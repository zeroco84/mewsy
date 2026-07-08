#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import { Alerter } from './alerts.js';
import { loadConfig, requireEnv, type MewsyConfig, type PropertyConfig } from './config.js';
import { HyperAccountsClient } from './hyperaccounts/client.js';
import { MewsClient } from './mews/client.js';
import { approveAdjustment, rejectAdjustment } from './pipeline/adjustments.js';
import { renderDateReport, renderLines, writeRunReports } from './pipeline/report.js';
import { runPipeline, resolvePostingDelay } from './pipeline/run.js';
import { runVatSpike } from './pipeline/vatSpike.js';
import { openDb } from './store/db.js';
import { Store } from './store/store.js';
import { centsFromDecimal, formatEur } from './util/money.js';
import { isValidBusinessDate, latestEligibleBusinessDate } from './util/dates.js';
import { logger, setLogLevel } from './util/logger.js';

/** Load KEY=VALUE pairs from ./.env without overriding real env vars. */
function loadDotEnv(): void {
  if (!existsSync('.env')) return;
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

interface Ctx {
  config: MewsyConfig;
  store: Store;
  alert: Alerter;
  runId: string;
  reportDir: string;
}

function makeCtx(opts: { config?: string; db?: string }): Ctx {
  const configPath = opts.config ?? process.env['MEWSY_CONFIG'] ?? './config/mewsy.json';
  const dbPath = opts.db ?? process.env['MEWSY_DB'] ?? './data/mewsy.db';
  const reportDir = process.env['MEWSY_REPORT_DIR'] ?? './data/reports';
  const config = loadConfig(configPath);
  const store = new Store(openDb(dbPath));
  const runId = `run-${DateTime.utc().toFormat('yyyyMMdd-HHmmss')}-${randomBytes(2).toString('hex')}`;
  const webhookUrl = config.alerts.webhookUrlEnv ? process.env[config.alerts.webhookUrlEnv] : undefined;
  const alert = new Alerter(store, runId, webhookUrl);
  return { config, store, alert, runId, reportDir };
}

function haFactory(property: PropertyConfig): HyperAccountsClient {
  return new HyperAccountsClient({
    baseUrl: property.hyperAccounts.baseUrl,
    authToken: requireEnv(property.hyperAccounts.authTokenEnv),
  });
}

function mewsFactory(config: MewsyConfig) {
  return (property: PropertyConfig): MewsClient =>
    new MewsClient({
      baseUrl: process.env['MEWS_BASE_URL'] ?? config.mews.baseUrl,
      clientToken: requireEnv(config.mews.clientTokenEnv),
      accessToken: requireEnv(property.mewsAccessTokenEnv),
      clientName: config.mews.clientName,
    });
}

function requireProperty(config: MewsyConfig, code: string): PropertyConfig {
  const property = config.properties.find((p) => p.code === code);
  if (!property) {
    throw new Error(`Unknown property ${code} (configured: ${config.properties.map((p) => p.code).join(', ')})`);
  }
  return property;
}

const GOOD_OUTCOMES = new Set(['POSTED', 'SKIPPED_SAME', 'ADJUSTMENT_POSTED', 'DRY_RUN']);

const program = new Command();
program
  .name('mewsy')
  .description('Mews → Sage 50 revenue integration — "Mews Entries, Wired to Sage for You"')
  .version('0.1.0')
  .option('-c, --config <path>', 'config file (default ./config/mewsy.json or $MEWSY_CONFIG)')
  .option('--db <path>', 'SQLite database (default ./data/mewsy.db or $MEWSY_DB)')
  .option('-v, --verbose', 'debug logging')
  .hook('preAction', (cmd) => {
    if (cmd.opts()['verbose']) setLogLevel('debug');
  });

program
  .command('run')
  .description('The daily loop (spec §4): post every eligible business date per property. Use --dry-run for Phase 1.')
  .option('--dry-run', 'build and reconcile but never write to Sage (Phase 1)', false)
  .option('-p, --property <code...>', 'restrict to specific property code(s)')
  .option('--date <yyyy-mm-dd>', 'process exactly this business date')
  .option('--from <yyyy-mm-dd>', 'start of an explicit date range')
  .option('--to <yyyy-mm-dd>', 'end of an explicit date range')
  .action(async (opts) => {
    const ctx = makeCtx(program.opts());
    for (const d of [opts.date, opts.from, opts.to].filter(Boolean) as string[]) {
      if (!isValidBusinessDate(d)) throw new Error(`Invalid date ${d} (expected yyyy-MM-dd)`);
    }
    const mode = opts.dryRun ? 'dry-run' : 'post';
    ctx.store.audit(ctx.runId, 'RUN_START', { mode, options: { property: opts.property, date: opts.date, from: opts.from, to: opts.to } });
    const summary = await runPipeline(ctx.config, ctx.store, ctx.alert, ctx.runId, {
      mode,
      onlyProperties: opts.property,
      date: opts.date,
      from: opts.from,
      to: opts.to,
    });
    const dir = writeRunReports(ctx.reportDir, summary);
    let allGood = true;
    console.log(`\nRun ${ctx.runId} (${mode}) — reports in ${dir}`);
    for (const prop of summary.properties) {
      const line = prop.outcomes.map((o) => `${o.report.businessDate}:${o.kind}`).join('  ') || '(nothing to do)';
      console.log(`  ${prop.propertyCode}  ${line}${prop.error ? `  ERROR: ${prop.error}` : ''}`);
      if (prop.error || prop.outcomes.some((o) => !GOOD_OUTCOMES.has(o.kind))) allGood = false;
    }
    ctx.store.audit(ctx.runId, 'RUN_END', { allGood });
    if (!allGood) process.exitCode = 2;
  });

program
  .command('report')
  .description('Phase 1: build the would-be journal for one date and print the reconciliation report (no posting)')
  .requiredOption('-p, --property <code>', 'property code')
  .requiredOption('--date <yyyy-mm-dd>', 'business date')
  .action(async (opts) => {
    const ctx = makeCtx(program.opts());
    if (!isValidBusinessDate(opts.date)) throw new Error(`Invalid date ${opts.date}`);
    requireProperty(ctx.config, opts.property);
    const summary = await runPipeline(ctx.config, ctx.store, ctx.alert, ctx.runId, {
      mode: 'dry-run',
      onlyProperties: [opts.property],
      date: opts.date,
    });
    for (const prop of summary.properties) {
      if (prop.error) {
        console.error(`ERROR: ${prop.error}`);
        process.exitCode = 2;
      }
      for (const outcome of prop.outcomes) {
        console.log('\n' + renderDateReport(outcome.report));
      }
    }
  });

program
  .command('validate')
  .description('Phase 0 checks: config, tokens, Mews connectivity, ledger-code completeness (spec §10), HyperAccounts reachability')
  .option('-p, --property <code...>', 'restrict to specific property code(s)')
  .action(async (opts) => {
    const ctx = makeCtx(program.opts());
    let problems = 0;
    const properties = ctx.config.properties.filter((p) => !opts.property || opts.property.includes(p.code));
    console.log(`Config OK — ${ctx.config.properties.length} property/ies, Mews base ${process.env['MEWS_BASE_URL'] ?? ctx.config.mews.baseUrl}`);

    for (const property of properties) {
      console.log(`\n── ${property.code} (${property.name}) ──`);

      for (const envName of [ctx.config.mews.clientTokenEnv, property.mewsAccessTokenEnv, property.hyperAccounts.authTokenEnv]) {
        if (!process.env[envName]) {
          console.log(`  ✗ env ${envName} is not set`);
          problems++;
        } else {
          console.log(`  ✓ env ${envName} present`);
        }
      }

      if (process.env[ctx.config.mews.clientTokenEnv] && process.env[property.mewsAccessTokenEnv]) {
        try {
          const mews = mewsFactory(ctx.config)(property);
          const delay = await resolvePostingDelay(property, mews);
          const conf = await mews.getConfiguration();
          console.log(`  ✓ Mews: enterprise "${conf.Enterprise?.Name ?? '?'}", tz ${conf.Enterprise?.TimeZoneIdentifier ?? '?'}, editable window ${conf.Enterprise?.EditableHistoryInterval ?? '(not set)'} → posting delay ${delay.delayDays}d (${delay.source})`);
          if (conf.Enterprise?.TimeZoneIdentifier && conf.Enterprise.TimeZoneIdentifier !== property.timezone) {
            console.log(`  ! timezone mismatch: config ${property.timezone} vs Mews ${conf.Enterprise.TimeZoneIdentifier}`);
            problems++;
          }
          const categories = await mews.getAccountingCategories();
          const active = categories.filter((c) => c.IsActive);
          const field = property.ledgerCodeField;
          const missing = active.filter((c) => !(field === 'PostingAccountCode' ? c.PostingAccountCode : c.LedgerAccountCode)?.trim());
          const tooLong = active.filter((c) => ((field === 'PostingAccountCode' ? c.PostingAccountCode : c.LedgerAccountCode)?.trim().length ?? 0) > 8);
          console.log(`  ✓ Mews: ${categories.length} accounting categories (${active.length} active)`);
          if (missing.length > 0) {
            console.log(`  ✗ ${missing.length} ACTIVE categories missing ${field} — these will block posting (spec §10):`);
            for (const c of missing) console.log(`      - ${c.Name ?? c.Id}${c.Code ? ` [${c.Code}]` : ''}`);
            problems++;
          }
          if (tooLong.length > 0) {
            console.log(`  ✗ ${tooLong.length} categories have ledger codes longer than Sage's 8-char nominal limit:`);
            for (const c of tooLong) console.log(`      - ${c.Name ?? c.Id}: ${(field === 'PostingAccountCode' ? c.PostingAccountCode : c.LedgerAccountCode)?.trim()}`);
            problems++;
          }
          const latest = latestEligibleBusinessDate(DateTime.utc(), property.timezone, property.endOfDayMinutes, delay.delayDays);
          console.log(`  ✓ latest eligible business date now: ${latest}`);
        } catch (err) {
          console.log(`  ✗ Mews check failed: ${String(err instanceof Error ? err.message : err)}`);
          problems++;
        }
      }

      console.log(`  · taxCodeMap: ${Object.entries(property.taxCodeMap).map(([k, v]) => `${k}→T${v.sageTaxCode}@${v.ratePercent}%`).join(', ') || '(EMPTY — every taxed item will block)'}`);
      if (Object.keys(property.taxCodeMap).length === 0) problems++;

      if (process.env[property.hyperAccounts.authTokenEnv]) {
        const probe = await haFactory(property).probe();
        console.log(`  ${probe.reachable ? '✓' : '✗'} HyperAccounts ${property.hyperAccounts.baseUrl}: ${probe.detail}`);
        if (!probe.reachable) problems++;
      }
    }

    console.log(`\n${problems === 0 ? 'All checks passed.' : `${problems} problem(s) found.`}`);
    if (problems > 0) process.exitCode = 1;
  });

program
  .command('status')
  .description('Watermarks, pending adjustments, unresolved attempts and open dead letters (offline — reads only the local DB)')
  .action(() => {
    const ctx = makeCtx(program.opts());
    console.log('Properties:');
    for (const property of ctx.config.properties) {
      const watermark = ctx.store.getWatermark(property.code);
      const pending = ctx.store.pendingAdjustments(property.code);
      const dead = ctx.store.openDeadLetters(property.code);
      const delayNote = property.postingDelayDays !== null
        ? `latest eligible ${latestEligibleBusinessDate(DateTime.utc(), property.timezone, property.endOfDayMinutes, property.postingDelayDays)}`
        : 'delay read from Mews at run time';
      console.log(`  ${property.code}: watermark ${watermark ?? '(none — will start at ' + property.startDate + ')'}; ${delayNote}`);
      if (pending.length > 0) console.log(`    ⚠ ${pending.length} adjustment(s) pending approval: ${pending.map((r) => `#${r.id} ${r.business_date}`).join(', ')}`);
      if (dead.length > 0) console.log(`    ⚠ ${dead.length} open dead-letter item(s): ${dead.map((d) => `#${d.id} ${d.business_date} (${d.reason})`).join('; ')}`);
    }
    const recent = ctx.store.recentLedgerRows(12);
    if (recent.length > 0) {
      console.log('\nRecent posting-ledger rows:');
      for (const r of recent) {
        console.log(`  #${r.id} ${r.property_code} ${r.business_date} ${r.kind}${r.seq ? `#${r.seq}` : ''} ${r.status}  ${r.inv_ref}${r.sage_transaction_ref ? `  Sage:${r.sage_transaction_ref}` : ''}`);
      }
    }
    // Query the whole ledger, not just the recent listing — an old UNKNOWN
    // row must keep tripping the exit code until someone resolves it.
    const unresolved = ctx.store.allUnresolvedRows();
    if (unresolved.length > 0) {
      console.log(`\n⚠ ${unresolved.length} row(s) with uncertain Sage state — verify in Sage and use \`mewsy resolve\`:`);
      for (const r of unresolved) {
        console.log(`  #${r.id} ${r.property_code} ${r.business_date} ${r.kind} ${r.status}  ${r.inv_ref}`);
      }
      process.exitCode = 2;
    }
  });

const adjustments = program.command('adjustments').description('Review and approve staged adjustment journals (spec §8.1/8.3)');

adjustments
  .command('list')
  .option('-p, --property <code>', 'filter by property')
  .action((opts) => {
    const ctx = makeCtx(program.opts());
    const rows = ctx.store.pendingAdjustments(opts.property);
    if (rows.length === 0) {
      console.log('No adjustments pending approval.');
      return;
    }
    for (const r of rows) {
      const lines = ctx.store.parseLines(r);
      const drift = lines.reduce((s, l) => s + Math.abs(l.netCents) + Math.abs(l.taxCents), 0);
      console.log(`#${r.id}  ${r.property_code} ${r.business_date}  ${r.inv_ref}  ${lines.length} line(s), drift ${formatEur(drift)}  (staged ${r.created_at_utc})`);
    }
    console.log('\nInspect with: mewsy adjustments show --id <id>');
  });

adjustments
  .command('show')
  .requiredOption('--id <rowId>', 'posting-ledger row id')
  .action((opts) => {
    const ctx = makeCtx(program.opts());
    const row = ctx.store.getLedgerRow(Number(opts.id));
    if (!row) throw new Error(`No posting-ledger row #${opts.id}`);
    console.log(`#${row.id}  ${row.property_code} ${row.business_date}  ${row.kind}  ${row.status}`);
    console.log(`invRef ${row.inv_ref}  journal date ${row.journal_date}  ${row.note ?? ''}`);
    console.log('\n' + renderLines(ctx.store.parseLines(row)));
    if (row.status === 'PENDING_APPROVAL') {
      console.log(`\nApprove with: mewsy adjustments approve --id ${row.id} --yes`);
    }
  });

adjustments
  .command('approve')
  .requiredOption('--id <rowId>', 'posting-ledger row id')
  .option('--yes', 'actually post to Sage (required)', false)
  .action(async (opts) => {
    const ctx = makeCtx(program.opts());
    if (!opts.yes) {
      console.log('Refusing to post without --yes. Inspect first with: mewsy adjustments show --id ' + opts.id);
      process.exitCode = 1;
      return;
    }
    const result = await approveAdjustment(ctx.config, ctx.store, ctx.alert, ctx.runId, Number(opts.id), haFactory);
    console.log(result.message);
    if (!result.ok) process.exitCode = 2;
  });

adjustments
  .command('reject')
  .requiredOption('--id <rowId>', 'posting-ledger row id')
  .requiredOption('--note <text>', 'why this adjustment is being rejected')
  .action((opts) => {
    const ctx = makeCtx(program.opts());
    const result = rejectAdjustment(ctx.store, ctx.runId, Number(opts.id), opts.note);
    console.log(result.message);
    if (!result.ok) process.exitCode = 2;
  });

program
  .command('resolve')
  .description('Resolve a posting attempt with uncertain outcome (UNKNOWN/ATTEMPTING) after manually checking Sage')
  .requiredOption('--id <rowId>', 'posting-ledger row id')
  .requiredOption('--outcome <posted|failed>', '"posted" if the journal IS in Sage, "failed" if it is NOT')
  .option('--sage-ref <ref>', 'Sage transaction number (when outcome=posted)')
  .option('--note <text>', 'how this was verified')
  .action((opts) => {
    const ctx = makeCtx(program.opts());
    const row = ctx.store.getLedgerRow(Number(opts.id));
    if (!row) throw new Error(`No posting-ledger row #${opts.id}`);
    if (row.status !== 'UNKNOWN' && row.status !== 'ATTEMPTING') {
      throw new Error(`Row #${row.id} is ${row.status} — only UNKNOWN/ATTEMPTING rows can be resolved`);
    }
    if (opts.outcome !== 'posted' && opts.outcome !== 'failed') throw new Error('--outcome must be "posted" or "failed"');
    const note = `Manually resolved as ${opts.outcome}${opts.note ? `: ${opts.note}` : ''}`;
    if (opts.outcome === 'posted') {
      ctx.store.updateLedgerStatus(row.id, 'POSTED', { sageTransactionRef: opts.sageRef ?? null, note });
    } else {
      ctx.store.updateLedgerStatus(row.id, 'FAILED', { note });
    }
    ctx.store.audit(ctx.runId, 'MANUAL_RESOLVE', { rowId: row.id, outcome: opts.outcome, sageRef: opts.sageRef ?? null, note: opts.note ?? null }, row.property_code, row.business_date);
    ctx.store.resolveDeadLettersFor(row.property_code, row.business_date);
    console.log(`Row #${row.id} → ${opts.outcome === 'posted' ? 'POSTED' : 'FAILED'}. The next run will ${opts.outcome === 'posted' ? 'verify content and reconcile' : 'rebuild and repost'} ${row.business_date}.`);
  });

program
  .command('vat-spike')
  .description('Phase 0 (spec §9): post a small test journal at every configured VAT rate, then check the Sage VAT3 return')
  .requiredOption('-p, --property <code>', 'property code')
  .requiredOption('--revenue-nominal <code>', 'nominal to carry the test revenue lines (pick a test/spike nominal)')
  .option('--date <yyyy-mm-dd>', 'journal date (default: today)')
  .option('--amount <eur>', 'net amount per rate line', '100.00')
  .option('--reverse', 'post the reversal of a previous spike', false)
  .option('--yes', 'actually post (otherwise prints the payload only)', false)
  .action(async (opts) => {
    const ctx = makeCtx(program.opts());
    const property = requireProperty(ctx.config, opts.property);
    const date = opts.date ?? DateTime.utc().setZone(property.timezone).toISODate()!;
    if (!isValidBusinessDate(date)) throw new Error(`Invalid date ${date}`);
    if (opts.revenueNominal.length > 8) throw new Error('revenue nominal exceeds 8 chars');
    const result = await runVatSpike({
      property,
      store: ctx.store,
      alert: ctx.alert,
      runId: ctx.runId,
      ha: opts.yes ? haFactory(property) : null,
      revenueNominal: opts.revenueNominal,
      date,
      netCentsPerRate: centsFromDecimal(Number(opts.amount), '--amount'),
      reverse: opts.reverse,
    });
    console.log('Journal payload:\n' + result.preview + '\n');
    console.log(result.message);
    if (opts.yes && !result.posted) process.exitCode = 2;
  });

loadDotEnv();
program.parseAsync(process.argv).catch((err: unknown) => {
  logger.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});

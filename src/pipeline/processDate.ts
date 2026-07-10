import type { Alerter } from '../alerts.js';
import type { PropertyConfig } from '../config.js';
import {
  adjustmentInvRef,
  buildAdjustmentLines,
  buildDayJournal,
  journalContentHash,
  revenueInvRef,
  toHyperAccountsJournal,
  type BuiltJournal,
  type JournalLine,
  type JournalTotals,
} from '../domain/journal.js';
import type { JournalPostResult } from '../hyperaccounts/client.js';
import type {
  MewsAccountingCategory,
  MewsConfigurationResponse,
  MewsOrderItem,
  MewsPayment,
} from '../mews/types.js';
import {
  checkPresenceInSage,
  lookupTranNumber,
  resolveAmbiguousOutcome,
  verifyInSage,
  type SagePoster,
} from './readback.js';
import type { LedgerKind } from '../store/db.js';
import type { Store } from '../store/store.js';
import { businessDateWindowUtc } from '../util/dates.js';
import { AmbiguousWriteError } from '../util/http.js';
import { logger } from '../util/logger.js';
import { formatEur } from '../util/money.js';

/**
 * The per-date state machine — spec §4 steps 2–7 for one property+date.
 *
 * Clients are injected as narrow interfaces so the idempotency/adjustment
 * paths are testable without the network.
 */

export interface MewsDataSource {
  getConfiguration(): Promise<MewsConfigurationResponse>;
  getAccountingCategories(): Promise<MewsAccountingCategory[]>;
  getClosedOrderItems(interval: { startUtc: string; endUtc: string }): Promise<MewsOrderItem[]>;
  getClosedPayments(interval: { startUtc: string; endUtc: string }): Promise<MewsPayment[]>;
}

export type { SagePoster } from './readback.js';

export type DateOutcomeKind =
  | 'POSTED' // posted and reconciled clean
  | 'POSTED_UNVERIFIED' // posted, but the post-hoc reconcile fetch failed
  | 'NO_ACTIVITY' // zero Closed items and payments — nothing to post, date complete
  | 'SKIPPED_SAME' // already in Sage with identical content — reconciled
  | 'ADJUSTMENT_PENDING' // delta staged, awaiting approval
  | 'ADJUSTMENT_POSTED' // delta auto-posted (requireAdjustmentApproval=false)
  | 'DRY_RUN' // Phase 1 — built and reconciled, nothing written
  | 'BLOCKED' // data problems (missing codes etc.) — nothing posted
  | 'BLOCKED_UNRESOLVED' // an earlier attempt has UNKNOWN outcome — human must resolve
  | 'POST_FAILED' // definite failure (rejected / never sent)
  | 'POST_UNKNOWN' // ambiguous outcome — recorded, needs `mewsy resolve`
  | 'VARIANCE'; // post-hoc reconcile found Mews ≠ Sage

export interface DateReport {
  propertyCode: string;
  businessDate: string;
  outcome: DateOutcomeKind;
  invRef?: string;
  sageTransactionRef?: string | null;
  totals?: JournalTotals;
  lines?: JournalLine[];
  blockers: string[];
  warnings: string[];
  reconciliation?: {
    verified: boolean;
    deltaLineCount: number;
    detail: string;
  };
}

export interface DateOutcome {
  kind: DateOutcomeKind;
  advanceWatermark: boolean;
  report: DateReport;
}

export interface ProcessDateDeps {
  mews: MewsDataSource;
  ha: SagePoster | null; // null in dry-run mode
  store: Store;
  alert: Alerter;
  runId: string;
  categoriesById: Map<string, MewsAccountingCategory>;
  /** Business "today" at the property — journal date for detection-dated adjustments. */
  detectionDate: string;
}

async function fetchDay(
  mews: MewsDataSource,
  property: PropertyConfig,
  businessDate: string,
): Promise<{ orderItems: MewsOrderItem[]; payments: MewsPayment[] }> {
  const window = businessDateWindowUtc(businessDate, property.timezone, property.endOfDayMinutes);
  const [orderItems, payments] = await Promise.all([
    mews.getClosedOrderItems(window),
    mews.getClosedPayments(window),
  ]);
  return { orderItems, payments };
}

function buildFor(
  property: PropertyConfig,
  businessDate: string,
  data: { orderItems: MewsOrderItem[]; payments: MewsPayment[] },
  categoriesById: Map<string, MewsAccountingCategory>,
) {
  return buildDayJournal({
    property,
    businessDate,
    orderItems: data.orderItems,
    payments: data.payments,
    categoriesById,
  });
}

interface PostResult {
  ok: boolean;
  kind: Extract<DateOutcomeKind, 'POSTED' | 'POST_FAILED' | 'POST_UNKNOWN'>;
  invRef: string;
  sageTransactionRef: string | null;
}

/** Record-then-post with definite/ambiguous outcome bookkeeping (spec §8.1/8.3). */
async function postWithLedger(
  deps: ProcessDateDeps,
  property: PropertyConfig,
  businessDate: string,
  kind: LedgerKind,
  seq: number,
  lines: JournalLine[],
  journalDate: string,
  contentHash: string,
  totals: JournalTotals | null,
  invRef: string,
): Promise<PostResult> {
  const { store, alert, runId } = deps;
  if (!deps.ha) throw new Error('Internal: postWithLedger called without a HyperAccounts client');
  const readback = property.hyperAccounts.readback;

  // Pre-post guard: never post an invRef that is already in Sage. Catches a
  // previous attempt that timed out but landed late (its read-back said
  // "absent" a moment too early), and a mistaken `mewsy resolve --outcome
  // failed` on a journal that actually exists. Read-back down ⇒ proceed
  // (the ambiguous path still freezes if the post outcome is unknowable).
  const preCheck = await checkPresenceInSage(deps.ha, invRef, readback);
  if (preCheck.kind === 'present') {
    const attempt = store.nextAttempt(property.code, businessDate, kind, seq);
    const rowId = store.insertLedgerRow({
      propertyCode: property.code,
      businessDate,
      kind,
      seq,
      attempt,
      invRef,
      status: 'POSTED',
      contentHash,
      lines,
      totals,
      journalDate,
      note: `Found already in Sage by the pre-post read-back (${preCheck.count} header(s)) — not reposted`,
    });
    store.audit(runId, 'POST_PREEXISTING', { rowId, invRef, count: preCheck.count, tranNumber: preCheck.tranNumber }, property.code, businessDate);
    store.updateLedgerStatus(rowId, 'POSTED', { sageTransactionRef: preCheck.tranNumber });
    await alert.send(
      'warn',
      'POST_PREEXISTING',
      `Journal ${invRef} is already in Sage (ref ${preCheck.tranNumber ?? 'n/a'}${preCheck.count > 1 ? `, ${preCheck.count} copies — investigate` : ''}) — recorded without reposting`,
      { propertyCode: property.code, businessDate, ledgerRowId: rowId },
    );
    return { ok: true, kind: 'POSTED', invRef, sageTransactionRef: preCheck.tranNumber };
  }

  const maxAttempts = 1 + property.journalRetries;
  for (let i = 0; i < maxAttempts; i++) {
    const attempt = store.nextAttempt(property.code, businessDate, kind, seq);
    const payload = toHyperAccountsJournal({ lines, accountRef: property.clearing.accountRef, invRef, journalDate });
    const rowId = store.insertLedgerRow({
      propertyCode: property.code,
      businessDate,
      kind,
      seq,
      attempt,
      invRef,
      status: 'ATTEMPTING',
      contentHash,
      lines,
      totals,
      journalDate,
    });
    store.audit(runId, 'POST_ATTEMPT', { rowId, invRef, attempt, payload }, property.code, businessDate);

    let result: JournalPostResult;
    try {
      result = await deps.ha.postJournal(payload);
    } catch (err) {
      // Ambiguous: Sage may hold this journal. Resolve via the read-back
      // (G3): found ⇒ posted; absent ⇒ safe retry; freeze only if the
      // search itself is unavailable (D4 as amended).
      const message = err instanceof AmbiguousWriteError ? err.message : String(err);
      const resolution = await resolveAmbiguousOutcome(deps.ha, invRef, readback);

      if (resolution.kind === 'posted') {
        store.updateLedgerStatus(rowId, 'POSTED', {
          sageTransactionRef: resolution.tranNumber,
          note: `Ambiguous outcome (${message}) resolved as POSTED via Sage read-back`,
        });
        store.audit(runId, 'POST_RECOVERED_VIA_READBACK', { rowId, invRef, tranNumber: resolution.tranNumber }, property.code, businessDate);
        await alert.send(
          'warn',
          'POST_RECOVERED',
          `Journal ${invRef} hit an ambiguous outcome but the Sage read-back found it — recorded as posted (Sage ref ${resolution.tranNumber ?? 'n/a'})`,
          { propertyCode: property.code, businessDate, ledgerRowId: rowId },
        );
        return { ok: true, kind: 'POSTED', invRef, sageTransactionRef: resolution.tranNumber };
      }

      if (resolution.kind === 'absent') {
        store.updateLedgerStatus(rowId, 'FAILED', {
          note: `Ambiguous outcome (${message}); Sage read-back confirms the journal is absent — safe to retry`,
        });
        store.audit(runId, 'POST_ABSENT_CONFIRMED', { rowId, invRef, message }, property.code, businessDate);
        if (i === maxAttempts - 1) {
          store.deadLetter(runId, property.code, businessDate, 'Journal post failed (confirmed absent in Sage)', { rowId, invRef, message });
          await alert.send(
            'error',
            'POST_FAILED',
            `Journal ${invRef} failed (${message}); Sage read-back confirms it is NOT in Sage — will retry next run`,
            { propertyCode: property.code, businessDate, ledgerRowId: rowId },
          );
          return { ok: false, kind: 'POST_FAILED', invRef, sageTransactionRef: null };
        }
        continue; // verified absent — an in-run retry is safe
      }

      // Read-back unavailable: the original D4 freeze applies.
      store.updateLedgerStatus(rowId, 'UNKNOWN', { note: `${message}; read-back unavailable: ${resolution.error}` });
      store.audit(runId, 'POST_AMBIGUOUS', { rowId, invRef, message, readback: resolution.error }, property.code, businessDate);
      store.deadLetter(runId, property.code, businessDate, 'Journal post outcome unknown', { rowId, invRef, message });
      await alert.send(
        'error',
        'POST_UNKNOWN',
        `Journal ${invRef} outcome UNKNOWN and the Sage read-back is unavailable (${resolution.error}) — verify in Sage whether it exists, then run: mewsy resolve --id ${rowId} --outcome posted|failed`,
        {
          propertyCode: property.code,
          businessDate,
          ledgerRowId: rowId,
          remediation: `mewsy resolve --id ${rowId} --outcome posted|failed`,
          detail: { invRef, message },
        },
      );
      return { ok: false, kind: 'POST_UNKNOWN', invRef, sageTransactionRef: null };
    }

    if (result.outcome.kind === 'ok') {
      // G1: /api/journal returns no transaction number — capture it from the
      // audit-header read-back instead (best-effort).
      const tranNumber = await lookupTranNumber(deps.ha, invRef, readback);
      store.updateLedgerStatus(rowId, 'POSTED', {
        sageTransactionRef: tranNumber,
        haResponse: result.rawResponse,
      });
      store.audit(runId, 'POSTED', { rowId, invRef, sageTransactionRef: tranNumber }, property.code, businessDate);
      logger.info(`Posted ${invRef} → Sage ref ${tranNumber ?? '(read-back unavailable)'}`);
      return { ok: true, kind: 'POSTED', invRef, sageTransactionRef: tranNumber };
    }

    if (result.outcome.kind === 'rejected') {
      store.updateLedgerStatus(rowId, 'FAILED', { note: `HTTP ${result.outcome.status}: ${result.outcome.body.slice(0, 1000)}` });
      store.audit(runId, 'POST_REJECTED', { rowId, invRef, status: result.outcome.status, body: result.outcome.body.slice(0, 1000) }, property.code, businessDate);
      store.deadLetter(runId, property.code, businessDate, 'Journal rejected by HyperAccounts', { rowId, invRef, status: result.outcome.status, body: result.outcome.body.slice(0, 1000) });
      await alert.send('error', 'POST_REJECTED', `Journal ${invRef} rejected (HTTP ${result.outcome.status}) — not in Sage`, { propertyCode: property.code, businessDate, detail: { rowId } });
      return { ok: false, kind: 'POST_FAILED', invRef, sageTransactionRef: null };
    }

    // failed_not_sent: definitely never reached HyperAccounts — safe to retry.
    store.updateLedgerStatus(rowId, 'FAILED', { note: result.outcome.error });
    store.audit(runId, 'POST_NOT_SENT', { rowId, invRef, error: result.outcome.error }, property.code, businessDate);
    if (i === maxAttempts - 1) {
      store.deadLetter(runId, property.code, businessDate, 'HyperAccounts unreachable', { rowId, invRef, error: result.outcome.error });
      await alert.send('error', 'POST_NOT_SENT', `Journal ${invRef} could not be sent (HyperAccounts unreachable) — will retry next run`, { propertyCode: property.code, businessDate, detail: { rowId, error: result.outcome.error } });
      return { ok: false, kind: 'POST_FAILED', invRef, sageTransactionRef: null };
    }
  }
  throw new Error('unreachable');
}

/**
 * Post-hoc reconciliation (spec §4 step 6 / §8.2): re-fetch the day from Mews
 * and confirm what is now in Sage (per the ledger) matches it exactly.
 */
async function reconcileAfterPost(
  deps: ProcessDateDeps,
  property: PropertyConfig,
  businessDate: string,
): Promise<{ verified: boolean; deltaLineCount: number; detail: string } | null> {
  const { mews, store, categoriesById } = deps;
  let fresh;
  try {
    fresh = await fetchDay(mews, property, businessDate);
  } catch (err) {
    return null; // fetch failed — reconciliation could not run
  }
  const rebuilt = buildFor(property, businessDate, fresh, categoriesById);
  if (!rebuilt.journal) {
    return { verified: false, deltaLineCount: -1, detail: `Reconcile rebuild blocked: ${rebuilt.blockers.join('; ')}` };
  }
  const postedRows = store.postedRows(property.code, businessDate);
  const posted = postedRows.map((r) => store.parseLines(r));
  const delta = buildAdjustmentLines(posted, rebuilt.journal, businessDate);
  if (delta.length === 0) {
    // Mews-side clean. Now verify Sage-side via the audit-table read-back
    // (D8 upgraded per response §2): the ledger is no longer trusted as a
    // proxy for what is actually in Sage.
    let detail = 'Sage postings match Mews Closed figures exactly';
    if (deps.ha) {
      const verification = await verifyInSage(
        deps.ha,
        postedRows.map((r) => ({ invRef: r.inv_ref, lines: store.parseLines(r) })),
        property.hyperAccounts.readback,
      );
      if (verification.kind === 'mismatch') {
        return { verified: false, deltaLineCount: 0, detail: verification.detail };
      }
      detail += verification.kind === 'verified'
        ? `; ${verification.detail}`
        : `; ${verification.detail} — verified against the local ledger only`;
    }
    return { verified: true, deltaLineCount: 0, detail };
  }
  const totalDrift = delta.reduce((s, l) => s + Math.abs(l.netCents) + Math.abs(l.taxCents), 0);
  return {
    verified: false,
    deltaLineCount: delta.length,
    detail: `Mews figures moved after posting: ${delta.length} line(s), total drift ${formatEur(totalDrift)}`,
  };
}

export async function processDate(
  property: PropertyConfig,
  businessDate: string,
  mode: 'post' | 'dry-run',
  deps: ProcessDateDeps,
): Promise<DateOutcome> {
  const { store, alert, runId, categoriesById } = deps;

  const report: DateReport = {
    propertyCode: property.code,
    businessDate,
    outcome: 'BLOCKED',
    blockers: [],
    warnings: [],
  };

  // Spec §8.1: never act on a date whose Sage state is uncertain.
  const unresolved = store.unresolvedRows(property.code, businessDate);
  if (unresolved.length > 0 && mode === 'post') {
    const ids = unresolved.map((r) => `#${r.id} (${r.inv_ref}, ${r.status})`).join(', ');
    report.outcome = 'BLOCKED_UNRESOLVED';
    report.blockers.push(
      `Unresolved posting attempt(s) ${ids} — verify in Sage and run mewsy resolve before this date can proceed`,
    );
    await alert.send('error', 'BLOCKED_UNRESOLVED', report.blockers[0]!, {
      propertyCode: property.code,
      businessDate,
      ledgerRowId: unresolved[0]!.id,
      remediation: `mewsy resolve --id ${unresolved[0]!.id} --outcome posted|failed`,
      detail: { rows: unresolved.map((r) => r.id) },
    });
    return { kind: 'BLOCKED_UNRESOLVED', advanceWatermark: false, report };
  }

  // §4 step 2: fetch the finalised Closed figures for D.
  const data = await fetchDay(deps.mews, property, businessDate);
  // §4 step 3 / §5: build the balanced journal.
  const build = buildFor(property, businessDate, data, categoriesById);
  report.warnings.push(...build.warnings);

  for (const w of build.warnings) {
    store.audit(runId, 'BUILD_WARNING', { warning: w }, property.code, businessDate);
    if (w.includes('suspense')) {
      await alert.send('warn', 'SUSPENSE_USED', w, { propertyCode: property.code, businessDate });
    }
  }

  if (!build.journal) {
    report.outcome = 'BLOCKED';
    report.blockers = build.blockers;
    store.audit(runId, 'BLOCKED', { blockers: build.blockers }, property.code, businessDate);
    store.deadLetter(runId, property.code, businessDate, 'Journal build blocked', { blockers: build.blockers });
    await alert.send(
      'error',
      'BLOCKED',
      `Cannot build journal for ${businessDate}: ${build.blockers.length} blocker(s). First: ${build.blockers[0]}`,
      { propertyCode: property.code, businessDate, detail: { blockers: build.blockers } },
    );
    return { kind: 'BLOCKED', advanceWatermark: false, report };
  }

  const journal: BuiltJournal = build.journal;
  report.totals = journal.totals;
  report.lines = journal.lines;
  const contentHash = journalContentHash(journal);

  // §4 step 4 / §8.1: idempotency against the posting ledger.
  const postedRows = store.postedRows(property.code, businessDate);
  const postedLineSets = postedRows.map((r) => store.parseLines(r));

  // A date with zero Closed items and payments is a legitimate no-activity
  // day (closure night, pre-opening date): there is nothing to post — an
  // empty splits[] would be rejected by HyperAccounts and wedge the
  // watermark. If something WAS posted previously, fall through so the
  // delta machinery raises the reversing adjustment instead.
  if (journal.lines.length === 0 && postedRows.length === 0) {
    report.reconciliation = { verified: true, deltaLineCount: 0, detail: 'No Closed activity for this date — nothing to post' };
    if (mode === 'dry-run') {
      report.outcome = 'DRY_RUN';
      store.audit(runId, 'DRY_RUN', { detail: 'no activity' }, property.code, businessDate);
      return { kind: 'DRY_RUN', advanceWatermark: false, report };
    }
    report.outcome = 'NO_ACTIVITY';
    store.audit(runId, 'NO_ACTIVITY', { orderItemCount: 0, paymentCount: 0 }, property.code, businessDate);
    store.resolveDeadLettersFor(property.code, businessDate);
    return { kind: 'NO_ACTIVITY', advanceWatermark: true, report };
  }

  if (mode === 'dry-run') {
    report.outcome = 'DRY_RUN';
    const delta = postedRows.length > 0 ? buildAdjustmentLines(postedLineSets, journal, businessDate) : null;
    report.reconciliation = {
      verified: delta === null ? true : delta.length === 0,
      deltaLineCount: delta?.length ?? 0,
      detail:
        postedRows.length === 0
          ? `Would post ${journal.lines.length} line(s): revenue gross ${formatEur(journal.totals.revenueGrossCents)}, payments ${formatEur(journal.totals.paymentsCents)}`
          : delta!.length === 0
            ? 'Already posted with identical content'
            : `Already posted but figures differ — an adjustment of ${delta!.length} line(s) would be raised`,
    };
    store.audit(runId, 'DRY_RUN', { contentHash, totals: journal.totals, detail: report.reconciliation.detail }, property.code, businessDate);
    return { kind: 'DRY_RUN', advanceWatermark: false, report };
  }

  if (postedRows.length === 0) {
    // First post for this date (§4 step 5, §7).
    const invRef = revenueInvRef(property.code, businessDate);
    const result = await postWithLedger(
      deps, property, businessDate, 'REVENUE', 0, journal.lines, businessDate, contentHash, journal.totals, invRef,
    );
    report.invRef = invRef;
    report.sageTransactionRef = result.sageTransactionRef;
    if (!result.ok) {
      report.outcome = result.kind;
      return { kind: result.kind, advanceWatermark: false, report };
    }

    // §4 step 6: reconcile after posting.
    const rec = await reconcileAfterPost(deps, property, businessDate);
    if (rec === null) {
      report.outcome = 'POSTED_UNVERIFIED';
      report.reconciliation = { verified: false, deltaLineCount: -1, detail: 'Reconcile fetch failed — will verify next run' };
      await alert.send('warn', 'RECONCILE_UNVERIFIED', `Posted ${invRef} but could not re-fetch Mews to reconcile — will verify on next run`, { propertyCode: property.code, businessDate });
      return { kind: 'POSTED_UNVERIFIED', advanceWatermark: false, report };
    }
    report.reconciliation = rec;
    if (!rec.verified) {
      report.outcome = 'VARIANCE';
      store.audit(runId, 'VARIANCE', { detail: rec.detail }, property.code, businessDate);
      store.deadLetter(runId, property.code, businessDate, 'Reconciliation variance after posting', { detail: rec.detail });
      await alert.send('error', 'VARIANCE', `${rec.detail} — watermark held (spec §8.2)`, { propertyCode: property.code, businessDate });
      return { kind: 'VARIANCE', advanceWatermark: false, report };
    }
    store.audit(runId, 'RECONCILED', { detail: rec.detail, totals: journal.totals }, property.code, businessDate);
    store.resolveDeadLettersFor(property.code, businessDate);
    report.outcome = 'POSTED';
    return { kind: 'POSTED', advanceWatermark: true, report };
  }

  // Something already posted: compare content (§8.1).
  const delta = buildAdjustmentLines(postedLineSets, journal, businessDate);
  if (delta.length === 0) {
    // Sage matches Mews again — any adjustment staged for an interim change
    // (since reverted) is now stale and must not remain approvable, or a
    // later approval would post a delta that no longer exists in Mews.
    const stalePending = store.pendingAdjustments(property.code).filter((r) => r.business_date === businessDate);
    for (const stale of stalePending) {
      store.updateLedgerStatus(stale.id, 'REJECTED', {
        note: `Withdrawn by run ${runId}: Mews figures now match Sage (no delta remains)`,
      });
      store.audit(runId, 'ADJUSTMENT_WITHDRAWN', { rowId: stale.id }, property.code, businessDate);
      await alert.send(
        'warn',
        'ADJUSTMENT_WITHDRAWN',
        `Pending adjustment #${stale.id} for ${businessDate} withdrawn — Mews figures reverted and Sage already matches`,
        { propertyCode: property.code, businessDate, detail: { rowId: stale.id } },
      );
    }
    // The fetch that produced this build reconciles Mews against the LEDGER;
    // Sage itself must also still hold exactly these journals (a mistakenly
    // resolved-as-posted row, a journal edited/deleted in Sage, or a
    // duplicate invRef must not reconcile clean — §8.2 holds every run).
    let detail = 'Already posted with identical content';
    if (deps.ha) {
      const verification = await verifyInSage(
        deps.ha,
        postedRows.map((r) => ({ invRef: r.inv_ref, lines: store.parseLines(r) })),
        property.hyperAccounts.readback,
      );
      if (verification.kind === 'mismatch') {
        report.outcome = 'VARIANCE';
        report.reconciliation = { verified: false, deltaLineCount: 0, detail: verification.detail };
        store.audit(runId, 'VARIANCE', { detail: verification.detail }, property.code, businessDate);
        store.deadLetter(runId, property.code, businessDate, 'Sage-side reconciliation variance', { detail: verification.detail });
        await alert.send('error', 'VARIANCE', `${verification.detail} — watermark held (spec §8.2)`, {
          propertyCode: property.code,
          businessDate,
        });
        return { kind: 'VARIANCE', advanceWatermark: false, report };
      }
      detail += verification.kind === 'verified'
        ? `; ${verification.detail}`
        : `; ${verification.detail} — verified against the local ledger only`;
    }
    report.outcome = 'SKIPPED_SAME';
    report.reconciliation = { verified: true, deltaLineCount: 0, detail };
    store.audit(runId, 'SKIPPED_SAME', { contentHash, detail }, property.code, businessDate);
    store.resolveDeadLettersFor(property.code, businessDate);
    return { kind: 'SKIPPED_SAME', advanceWatermark: true, report };
  }

  // Content changed after posting → adjustment journal, never a repost (§8.1/8.3).
  const deltaHash = journalContentHash({ businessDate, accountRef: journal.accountRef, lines: delta });
  const journalDate = property.adjustmentDating === 'source' ? businessDate : deps.detectionDate;

  const pending = store.pendingAdjustments(property.code).filter((r) => r.business_date === businessDate);
  const samePending = pending.find((r) => r.content_hash === deltaHash);
  if (samePending) {
    report.outcome = 'ADJUSTMENT_PENDING';
    report.reconciliation = { verified: false, deltaLineCount: delta.length, detail: `Adjustment #${samePending.id} already staged, awaiting approval` };
    return { kind: 'ADJUSTMENT_PENDING', advanceWatermark: false, report };
  }
  for (const stale of pending) {
    store.updateLedgerStatus(stale.id, 'REJECTED', { note: `Superseded by run ${runId} (Mews figures moved again)` });
    store.audit(runId, 'ADJUSTMENT_SUPERSEDED', { rowId: stale.id }, property.code, businessDate);
  }

  const seq = store.nextSeq(property.code, businessDate, 'ADJUSTMENT');
  const invRef = adjustmentInvRef(property.code, businessDate, seq);
  const totalDrift = delta.reduce((s, l) => s + Math.abs(l.netCents) + Math.abs(l.taxCents), 0);

  if (property.requireAdjustmentApproval) {
    const rowId = store.insertLedgerRow({
      propertyCode: property.code,
      businessDate,
      kind: 'ADJUSTMENT',
      seq,
      attempt: 1,
      invRef,
      status: 'PENDING_APPROVAL',
      contentHash: deltaHash,
      lines: delta,
      totals: null,
      journalDate,
      note: `Delta vs Sage detected on ${deps.detectionDate}`,
    });
    store.audit(runId, 'ADJUSTMENT_STAGED', { rowId, invRef, lines: delta }, property.code, businessDate);
    await alert.send(
      'warn',
      'ADJUSTMENT_PENDING',
      `Mews figures for ${businessDate} changed after posting — adjustment ${invRef} staged (${delta.length} line(s), drift ${formatEur(totalDrift)}). Review with: mewsy adjustments show --id ${rowId}`,
      { propertyCode: property.code, businessDate, detail: { rowId, invRef } },
    );
    report.outcome = 'ADJUSTMENT_PENDING';
    report.invRef = invRef;
    report.reconciliation = { verified: false, deltaLineCount: delta.length, detail: `Adjustment staged (#${rowId})` };
    return { kind: 'ADJUSTMENT_PENDING', advanceWatermark: false, report };
  }

  const result = await postWithLedger(
    deps, property, businessDate, 'ADJUSTMENT', seq, delta, journalDate, deltaHash, null, invRef,
  );
  report.invRef = invRef;
  report.sageTransactionRef = result.sageTransactionRef;
  if (!result.ok) {
    report.outcome = result.kind;
    return { kind: result.kind, advanceWatermark: false, report };
  }
  await alert.send('warn', 'ADJUSTMENT_POSTED', `Adjustment ${invRef} posted for ${businessDate} (${delta.length} line(s), drift ${formatEur(totalDrift)})`, { propertyCode: property.code, businessDate });

  const rec = await reconcileAfterPost(deps, property, businessDate);
  report.reconciliation = rec ?? { verified: false, deltaLineCount: -1, detail: 'Reconcile fetch failed — will verify next run' };
  if (rec?.verified) {
    store.audit(runId, 'RECONCILED', { detail: rec.detail }, property.code, businessDate);
    store.resolveDeadLettersFor(property.code, businessDate);
    report.outcome = 'ADJUSTMENT_POSTED';
    return { kind: 'ADJUSTMENT_POSTED', advanceWatermark: true, report };
  }
  report.outcome = rec ? 'VARIANCE' : 'POSTED_UNVERIFIED';
  if (rec && !rec.verified) {
    await alert.send('error', 'VARIANCE', `${rec.detail} — watermark held`, { propertyCode: property.code, businessDate });
  }
  return { kind: report.outcome, advanceWatermark: false, report };
}

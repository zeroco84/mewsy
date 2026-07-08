import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JournalLine } from '../domain/journal.js';
import { formatEur } from '../util/money.js';
import type { DateReport } from './processDate.js';
import type { RunSummary } from './run.js';

/**
 * Reconciliation/report artifacts (spec §11 Phase 1): every processed date
 * yields a JSON report plus a human-readable text summary under
 * data/reports/<runId>/.
 */

export function renderLines(lines: JournalLine[]): string {
  const rows = lines.map((l) => {
    const effect = l.netCents + l.taxCents;
    const drcr = effect >= 0 ? 'DR' : 'CR';
    return [
      l.nominalCode.padEnd(8),
      drcr,
      formatEur(Math.abs(l.netCents)).padStart(14),
      formatEur(Math.abs(l.taxCents)).padStart(12),
      `T${l.sageTaxCode}`.padEnd(4),
      l.kind.padEnd(10),
      l.details,
    ].join('  ');
  });
  const header = ['Nominal '.padEnd(8), '  ', 'Net'.padStart(14), 'Tax'.padStart(12), 'Code', 'Kind      ', 'Details'].join('  ');
  return [header, ...rows].join('\n');
}

export function renderDateReport(report: DateReport): string {
  const out: string[] = [];
  out.push(`${report.propertyCode} ${report.businessDate} — ${report.outcome}`);
  if (report.invRef) out.push(`invRef: ${report.invRef}${report.sageTransactionRef ? `  Sage ref: ${report.sageTransactionRef}` : ''}`);
  if (report.totals) {
    out.push(
      `Revenue net ${formatEur(report.totals.revenueNetCents)} + VAT ${formatEur(report.totals.revenueTaxCents)} = gross ${formatEur(report.totals.revenueGrossCents)}; ` +
        `payments ${formatEur(report.totals.paymentsCents)}; imbalance ${formatEur(report.totals.imbalanceCents)} ` +
        `(${report.totals.orderItemCount} items, ${report.totals.paymentCount} payments)`,
    );
  }
  if (report.lines && report.lines.length > 0) {
    out.push('', renderLines(report.lines));
  }
  if (report.reconciliation) out.push('', `Reconciliation: ${report.reconciliation.verified ? 'OK' : 'NOT VERIFIED'} — ${report.reconciliation.detail}`);
  if (report.warnings.length > 0) out.push('', 'Warnings:', ...report.warnings.map((w) => `  ! ${w}`));
  if (report.blockers.length > 0) out.push('', 'Blockers:', ...report.blockers.map((b) => `  ✗ ${b}`));
  return out.join('\n');
}

export function writeRunReports(reportDir: string, summary: RunSummary): string {
  const dir = join(reportDir, summary.runId);
  mkdirSync(dir, { recursive: true });
  const overview: string[] = [`Mewsy run ${summary.runId} (${summary.mode})`, ''];
  for (const prop of summary.properties) {
    overview.push(
      `${prop.propertyCode}: delay ${prop.delayDays}d, latest eligible ${prop.latestEligible || 'n/a'}${prop.error ? `, ERROR: ${prop.error}` : ''}`,
    );
    for (const outcome of prop.outcomes) {
      const r = outcome.report;
      overview.push(`  ${r.businessDate}  ${r.outcome}`);
      writeFileSync(join(dir, `${r.propertyCode}-${r.businessDate}.json`), JSON.stringify(r, null, 2));
      writeFileSync(join(dir, `${r.propertyCode}-${r.businessDate}.txt`), renderDateReport(r) + '\n');
    }
    if (prop.stoppedEarly) overview.push('  (stopped early — later dates deferred)');
  }
  const overviewPath = join(dir, 'run-summary.txt');
  writeFileSync(overviewPath, overview.join('\n') + '\n');
  return dir;
}

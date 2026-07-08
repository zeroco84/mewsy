import type { Alerter } from '../alerts.js';
import type { PropertyConfig } from '../config.js';
import { buildVatSpikeLines, toHyperAccountsJournal, vatSpikeInvRef, journalContentHash } from '../domain/journal.js';
import type { Store } from '../store/store.js';
import { AmbiguousWriteError } from '../util/http.js';
import type { JournalPosterLike } from './adjustments.js';

/**
 * Phase 0 VAT-return spike (spec §9): post one small journal carrying every
 * configured VAT rate, then run the Sage 50 (Ireland) VAT3 return and check
 * each rate lands in the correct box. `reverse` posts the negation to back
 * the test data out afterwards.
 */
export async function runVatSpike(input: {
  property: PropertyConfig;
  store: Store;
  alert: Alerter;
  runId: string;
  ha: JournalPosterLike | null; // null = preview only
  revenueNominal: string;
  date: string;
  netCentsPerRate: number;
  reverse: boolean;
}): Promise<{ posted: boolean; preview: string; message: string }> {
  const { property, store, alert, runId, revenueNominal, date, netCentsPerRate, reverse } = input;
  const lines = buildVatSpikeLines(property, revenueNominal, netCentsPerRate, reverse);
  const invRef = vatSpikeInvRef(property.code, date, reverse);
  const payload = toHyperAccountsJournal({
    lines,
    accountRef: property.clearing.accountRef,
    invRef,
    journalDate: date,
  });
  const preview = JSON.stringify(payload, null, 2);

  if (!input.ha) {
    return { posted: false, preview, message: 'Preview only — re-run with --yes to post this journal to Sage.' };
  }

  const seq = store.nextSeq(property.code, date, 'VAT_SPIKE');
  const rowId = store.insertLedgerRow({
    propertyCode: property.code,
    businessDate: date,
    kind: 'VAT_SPIKE',
    seq,
    attempt: 1,
    invRef,
    status: 'ATTEMPTING',
    contentHash: journalContentHash({ businessDate: date, accountRef: property.clearing.accountRef, lines }),
    lines,
    totals: null,
    journalDate: date,
    note: reverse ? 'VAT spike reversal' : 'VAT spike (Phase 0, spec §9)',
  });
  store.audit(runId, 'VAT_SPIKE_ATTEMPT', { rowId, invRef, payload }, property.code, date);

  try {
    const result = await input.ha.postJournal(payload);
    if (result.outcome.kind === 'ok') {
      store.updateLedgerStatus(rowId, 'POSTED', { sageTransactionRef: result.sageTransactionRef, haResponse: result.rawResponse });
      store.audit(runId, 'POSTED', { rowId, invRef, sageTransactionRef: result.sageTransactionRef }, property.code, date);
      return {
        posted: true,
        preview,
        message:
          `Posted ${invRef} (Sage ref ${result.sageTransactionRef ?? 'n/a'}).\n` +
          `Now run the Sage 50 (Ireland) VAT3 return and confirm each rate lands in the correct box.\n` +
          (reverse ? '' : `When done, back it out with: mewsy vat-spike --property ${property.code} --revenue-nominal ${revenueNominal} --date ${date} --reverse --yes`),
      };
    }
    const detail = result.outcome.kind === 'rejected' ? `HTTP ${result.outcome.status}: ${result.outcome.body.slice(0, 500)}` : result.outcome.error;
    store.updateLedgerStatus(rowId, 'FAILED', { note: detail });
    store.audit(runId, 'VAT_SPIKE_FAILED', { rowId, detail }, property.code, date);
    return { posted: false, preview, message: `VAT spike not posted: ${detail}` };
  } catch (err) {
    const message = err instanceof AmbiguousWriteError ? err.message : String(err);
    store.updateLedgerStatus(rowId, 'UNKNOWN', { note: message });
    store.audit(runId, 'POST_AMBIGUOUS', { rowId, message }, property.code, date);
    await alert.send('error', 'POST_UNKNOWN', `VAT spike ${invRef} outcome UNKNOWN — verify in Sage, then: mewsy resolve --id ${rowId} --outcome posted|failed`, {
      propertyCode: property.code,
      businessDate: date,
    });
    return { posted: false, preview, message: `Outcome UNKNOWN — verify in Sage, then resolve row #${rowId}` };
  }
}

import type { Alerter } from '../alerts.js';
import type { PropertyConfig } from '../config.js';
import { buildVatSpikeLines, toHyperAccountsJournal, vatSpikeInvRef, journalContentHash } from '../domain/journal.js';
import type { Store } from '../store/store.js';
import { AmbiguousWriteError } from '../util/http.js';
import { lookupTranNumber, resolveAmbiguousOutcome, type SagePoster } from './readback.js';

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
  ha: SagePoster | null; // null = preview only
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

  const readback = property.hyperAccounts.readback;
  try {
    const result = await input.ha.postJournal(payload);
    if (result.outcome.kind === 'ok') {
      const tranNumber = await lookupTranNumber(input.ha, invRef, readback);
      store.updateLedgerStatus(rowId, 'POSTED', { sageTransactionRef: tranNumber, haResponse: result.rawResponse });
      store.audit(runId, 'POSTED', { rowId, invRef, sageTransactionRef: tranNumber }, property.code, date);
      return {
        posted: true,
        preview,
        message:
          `Posted ${invRef} (Sage ref ${tranNumber ?? 'n/a'}).\n` +
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
    const resolution = await resolveAmbiguousOutcome(input.ha, invRef, readback);
    if (resolution.kind === 'posted') {
      store.updateLedgerStatus(rowId, 'POSTED', { sageTransactionRef: resolution.tranNumber, note: `Ambiguous outcome (${message}) resolved as POSTED via Sage read-back` });
      store.audit(runId, 'POST_RECOVERED_VIA_READBACK', { rowId, invRef, tranNumber: resolution.tranNumber }, property.code, date);
      return { posted: true, preview, message: `Posted ${invRef} (recovered via Sage read-back; Sage ref ${resolution.tranNumber ?? 'n/a'}).` };
    }
    if (resolution.kind === 'absent') {
      store.updateLedgerStatus(rowId, 'FAILED', { note: `Ambiguous outcome (${message}); Sage read-back confirms absent` });
      store.audit(runId, 'POST_ABSENT_CONFIRMED', { rowId, invRef, message }, property.code, date);
      return { posted: false, preview, message: `VAT spike not posted (${message}); Sage read-back confirms it is NOT in Sage — safe to re-run.` };
    }
    store.updateLedgerStatus(rowId, 'UNKNOWN', { note: `${message}; read-back unavailable: ${resolution.error}` });
    store.audit(runId, 'POST_AMBIGUOUS', { rowId, message, readback: resolution.error }, property.code, date);
    await alert.send('error', 'POST_UNKNOWN', `VAT spike ${invRef} outcome UNKNOWN and the Sage read-back is unavailable — verify in Sage, then: mewsy resolve --id ${rowId} --outcome posted|failed`, {
      propertyCode: property.code,
      businessDate: date,
      ledgerRowId: rowId,
      remediation: `mewsy resolve --id ${rowId} --outcome posted|failed`,
    });
    return { posted: false, preview, message: `Outcome UNKNOWN — verify in Sage, then resolve row #${rowId}` };
  }
}

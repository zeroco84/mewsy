import type { Alerter } from '../alerts.js';
import type { MewsyConfig, PropertyConfig } from '../config.js';
import { toHyperAccountsJournal } from '../domain/journal.js';
import type { HyperAccountsJournal } from '../hyperaccounts/client.js';
import type { Store } from '../store/store.js';
import { AmbiguousWriteError } from '../util/http.js';
import { lookupTranNumber, resolveAmbiguousOutcome, type SagePoster } from './readback.js';

/**
 * Approval workflow for staged adjustment journals (spec §8.1 "raise an
 * adjustment — never silently repost", §8.3 dated adjustment journals).
 * Adjustments are staged PENDING_APPROVAL by the daily run; a human approves
 * or rejects them here.
 */

export async function approveAdjustment(
  config: MewsyConfig,
  store: Store,
  alert: Alerter,
  runId: string,
  rowId: number,
  haFactory: (property: PropertyConfig) => SagePoster,
): Promise<{ ok: boolean; message: string }> {
  const row = store.getLedgerRow(rowId);
  if (!row) return { ok: false, message: `No posting-ledger row #${rowId}` };
  if (row.status !== 'PENDING_APPROVAL') {
    return { ok: false, message: `Row #${rowId} is ${row.status}, not PENDING_APPROVAL — nothing to approve` };
  }
  const property = config.properties.find((p) => p.code === row.property_code);
  if (!property) return { ok: false, message: `Property ${row.property_code} is no longer in config` };
  const readback = property.hyperAccounts.readback;

  const lines = store.parseLines(row);
  let payload: HyperAccountsJournal;
  try {
    payload = toHyperAccountsJournal({
      lines,
      accountRef: property.clearing.accountRef,
      invRef: row.inv_ref,
      journalDate: row.journal_date,
    });
  } catch (err) {
    // Defensive: an unpostable staged payload must not crash the CLI or
    // change the row's status — reject it and let the next run re-stage.
    return {
      ok: false,
      message: `Cannot build a postable journal from staged adjustment #${rowId}: ${String(err instanceof Error ? err.message : err)}. Reject it (mewsy adjustments reject --id ${rowId} --note ...) and let the next run re-stage.`,
    };
  }

  store.updateLedgerStatus(rowId, 'ATTEMPTING', { note: `Approved via CLI (run ${runId})` });
  store.audit(runId, 'ADJUSTMENT_APPROVED', { rowId, invRef: row.inv_ref, payload }, row.property_code, row.business_date);

  const ha = haFactory(property);
  try {
    const result = await ha.postJournal(payload);
    if (result.outcome.kind === 'ok') {
      const tranNumber = await lookupTranNumber(ha, row.inv_ref, readback);
      store.updateLedgerStatus(rowId, 'POSTED', {
        sageTransactionRef: tranNumber,
        haResponse: result.rawResponse,
      });
      store.audit(runId, 'POSTED', { rowId, invRef: row.inv_ref, sageTransactionRef: tranNumber }, row.property_code, row.business_date);
      await alert.send('info', 'ADJUSTMENT_POSTED', `Adjustment ${row.inv_ref} approved and posted (Sage ref ${tranNumber ?? 'n/a'})`, {
        propertyCode: row.property_code,
        businessDate: row.business_date,
        ledgerRowId: rowId,
      });
      return { ok: true, message: `Posted ${row.inv_ref} → Sage ref ${tranNumber ?? '(read-back unavailable)'}` };
    }
    if (result.outcome.kind === 'rejected') {
      store.updateLedgerStatus(rowId, 'FAILED', { note: `HTTP ${result.outcome.status}: ${result.outcome.body.slice(0, 1000)}` });
      store.audit(runId, 'POST_REJECTED', { rowId, status: result.outcome.status }, row.property_code, row.business_date);
      await alert.send('error', 'POST_REJECTED', `Adjustment ${row.inv_ref} rejected by HyperAccounts (HTTP ${result.outcome.status})`, {
        propertyCode: row.property_code,
        businessDate: row.business_date,
        ledgerRowId: rowId,
      });
      return { ok: false, message: `Rejected by HyperAccounts (HTTP ${result.outcome.status}). Row marked FAILED; the next run will re-stage a fresh adjustment.` };
    }
    store.updateLedgerStatus(rowId, 'FAILED', { note: result.outcome.error });
    store.audit(runId, 'POST_NOT_SENT', { rowId, error: result.outcome.error }, row.property_code, row.business_date);
    return { ok: false, message: `HyperAccounts unreachable (${result.outcome.error}). Row marked FAILED; the next run will re-stage.` };
  } catch (err) {
    const message = err instanceof AmbiguousWriteError ? err.message : String(err);
    const resolution = await resolveAmbiguousOutcome(ha, row.inv_ref, readback);
    if (resolution.kind === 'posted') {
      store.updateLedgerStatus(rowId, 'POSTED', {
        sageTransactionRef: resolution.tranNumber,
        note: `Ambiguous outcome (${message}) resolved as POSTED via Sage read-back`,
      });
      store.audit(runId, 'POST_RECOVERED_VIA_READBACK', { rowId, tranNumber: resolution.tranNumber }, row.property_code, row.business_date);
      return { ok: true, message: `Posted ${row.inv_ref} (recovered via Sage read-back after an ambiguous outcome; Sage ref ${resolution.tranNumber ?? 'n/a'})` };
    }
    if (resolution.kind === 'absent') {
      store.updateLedgerStatus(rowId, 'FAILED', { note: `Ambiguous outcome (${message}); Sage read-back confirms absent` });
      store.audit(runId, 'POST_ABSENT_CONFIRMED', { rowId, message }, row.property_code, row.business_date);
      return { ok: false, message: `Post failed (${message}); Sage read-back confirms it is NOT in Sage. Row marked FAILED; the next run will re-stage.` };
    }
    store.updateLedgerStatus(rowId, 'UNKNOWN', { note: `${message}; read-back unavailable: ${resolution.error}` });
    store.audit(runId, 'POST_AMBIGUOUS', { rowId, message, readback: resolution.error }, row.property_code, row.business_date);
    store.deadLetter(runId, row.property_code, row.business_date, 'Adjustment post outcome unknown', { rowId, message });
    await alert.send('error', 'POST_UNKNOWN', `Adjustment ${row.inv_ref} outcome UNKNOWN and the Sage read-back is unavailable — verify in Sage, then: mewsy resolve --id ${rowId} --outcome posted|failed`, {
      propertyCode: row.property_code,
      businessDate: row.business_date,
      ledgerRowId: rowId,
      remediation: `mewsy resolve --id ${rowId} --outcome posted|failed`,
    });
    return { ok: false, message: `Outcome UNKNOWN — verify in Sage, then resolve row #${rowId}` };
  }
}

export function rejectAdjustment(store: Store, runId: string, rowId: number, note: string): { ok: boolean; message: string } {
  const row = store.getLedgerRow(rowId);
  if (!row) return { ok: false, message: `No posting-ledger row #${rowId}` };
  if (row.status !== 'PENDING_APPROVAL') {
    return { ok: false, message: `Row #${rowId} is ${row.status}, not PENDING_APPROVAL` };
  }
  store.updateLedgerStatus(rowId, 'REJECTED', { note });
  store.audit(runId, 'ADJUSTMENT_REJECTED', { rowId, note }, row.property_code, row.business_date);
  return {
    ok: true,
    message: `Rejected #${rowId}. Note: the daily run will re-detect the same delta and stage it again while Mews and Sage disagree — fix the underlying data if this is permanent.`,
  };
}

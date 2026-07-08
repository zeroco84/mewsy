import type { Alerter } from '../alerts.js';
import type { MewsyConfig, PropertyConfig } from '../config.js';
import { toHyperAccountsJournal } from '../domain/journal.js';
import type { JournalPostResult } from '../hyperaccounts/client.js';
import type { HyperAccountsJournal } from '../hyperaccounts/client.js';
import type { Store } from '../store/store.js';
import { AmbiguousWriteError } from '../util/http.js';

/**
 * Approval workflow for staged adjustment journals (spec §8.1 "raise an
 * adjustment — never silently repost", §8.3 dated adjustment journals).
 * Adjustments are staged PENDING_APPROVAL by the daily run; a human approves
 * or rejects them here.
 */

export interface JournalPosterLike {
  postJournal(journal: HyperAccountsJournal): Promise<JournalPostResult>;
}

export async function approveAdjustment(
  config: MewsyConfig,
  store: Store,
  alert: Alerter,
  runId: string,
  rowId: number,
  haFactory: (property: PropertyConfig) => JournalPosterLike,
): Promise<{ ok: boolean; message: string }> {
  const row = store.getLedgerRow(rowId);
  if (!row) return { ok: false, message: `No posting-ledger row #${rowId}` };
  if (row.status !== 'PENDING_APPROVAL') {
    return { ok: false, message: `Row #${rowId} is ${row.status}, not PENDING_APPROVAL — nothing to approve` };
  }
  const property = config.properties.find((p) => p.code === row.property_code);
  if (!property) return { ok: false, message: `Property ${row.property_code} is no longer in config` };

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
      store.updateLedgerStatus(rowId, 'POSTED', {
        sageTransactionRef: result.sageTransactionRef,
        haResponse: result.rawResponse,
      });
      store.audit(runId, 'POSTED', { rowId, invRef: row.inv_ref, sageTransactionRef: result.sageTransactionRef }, row.property_code, row.business_date);
      await alert.send('info', 'ADJUSTMENT_POSTED', `Adjustment ${row.inv_ref} approved and posted (Sage ref ${result.sageTransactionRef ?? 'n/a'})`, {
        propertyCode: row.property_code,
        businessDate: row.business_date,
      });
      return { ok: true, message: `Posted ${row.inv_ref} → Sage ref ${result.sageTransactionRef ?? '(none returned)'}` };
    }
    if (result.outcome.kind === 'rejected') {
      store.updateLedgerStatus(rowId, 'FAILED', { note: `HTTP ${result.outcome.status}: ${result.outcome.body.slice(0, 1000)}` });
      store.audit(runId, 'POST_REJECTED', { rowId, status: result.outcome.status }, row.property_code, row.business_date);
      await alert.send('error', 'POST_REJECTED', `Adjustment ${row.inv_ref} rejected by HyperAccounts (HTTP ${result.outcome.status})`, {
        propertyCode: row.property_code,
        businessDate: row.business_date,
      });
      return { ok: false, message: `Rejected by HyperAccounts (HTTP ${result.outcome.status}). Row marked FAILED; the next run will re-stage a fresh adjustment.` };
    }
    store.updateLedgerStatus(rowId, 'FAILED', { note: result.outcome.error });
    store.audit(runId, 'POST_NOT_SENT', { rowId, error: result.outcome.error }, row.property_code, row.business_date);
    return { ok: false, message: `HyperAccounts unreachable (${result.outcome.error}). Row marked FAILED; approve again once it is up — the next run will re-stage.` };
  } catch (err) {
    const message = err instanceof AmbiguousWriteError ? err.message : String(err);
    store.updateLedgerStatus(rowId, 'UNKNOWN', { note: message });
    store.audit(runId, 'POST_AMBIGUOUS', { rowId, message }, row.property_code, row.business_date);
    store.deadLetter(runId, row.property_code, row.business_date, 'Adjustment post outcome unknown', { rowId, message });
    await alert.send('error', 'POST_UNKNOWN', `Adjustment ${row.inv_ref} outcome UNKNOWN — verify in Sage, then: mewsy resolve --id ${rowId} --outcome posted|failed`, {
      propertyCode: row.property_code,
      businessDate: row.business_date,
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

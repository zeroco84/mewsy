import { nonIdempotentWrite, type FetchFn, type WriteOutcome } from '../util/http.js';

/**
 * HyperAccounts client (spec §7): POST {{url}}/api/journal with the
 * AuthToken header, over localhost on the Sage box.
 *
 * The journal write is NOT retried here — the caller owns the
 * attempt/UNKNOWN bookkeeping (see pipeline + posting ledger).
 */

export interface HyperAccountsSplit {
  details: string;
  nominalCode: string;
  netAmount: number;
  taxAmount: number;
  taxCode: number;
  /** 15 = JD (debit), 16 = JC (credit) — spec §7. */
  type: 15 | 16;
  deptNumber?: string;
  extraRef?: string;
}

export interface HyperAccountsJournal {
  /** dd/MM/yyyy */
  date: string;
  /** ≤30 chars — deterministic idempotency key (spec §7). */
  invRef: string;
  accountRef: string;
  splits: HyperAccountsSplit[];
}

export interface HyperAccountsClientOptions {
  baseUrl: string;
  authToken: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export interface JournalPostResult {
  outcome: WriteOutcome;
  /** Best-effort extraction of the Sage transaction reference from the response. */
  sageTransactionRef: string | null;
  rawResponse: string | null;
}

/** Pull something that looks like a Sage transaction number out of an unknown response shape. */
export function extractTransactionRef(response: unknown): string | null {
  if (response === null || response === undefined) return null;
  if (typeof response === 'number') return String(response);
  if (typeof response === 'string') {
    const trimmed = response.trim();
    return trimmed === '' ? null : trimmed.slice(0, 100);
  }
  if (typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  const candidateKeys = [
    'transactionNumber', 'TransactionNumber', 'tranNumber', 'TranNumber',
    'transactionRef', 'TransactionRef', 'number', 'Number', 'id', 'Id',
  ];
  for (const key of candidateKeys) {
    const v = record[key];
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) return String(v);
  }
  for (const nestKey of ['data', 'Data', 'result', 'Result']) {
    if (record[nestKey] !== undefined) {
      const nested = extractTransactionRef(record[nestKey]);
      if (nested) return nested;
    }
  }
  return null;
}

export class HyperAccountsClient {
  constructor(private readonly opts: HyperAccountsClientOptions) {}

  /**
   * Post a journal. Throws AmbiguousWriteError when the outcome is unknowable
   * (timeout / reset / 5xx) so the caller can record an UNKNOWN attempt.
   */
  async postJournal(journal: HyperAccountsJournal): Promise<JournalPostResult> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/api/journal`;
    const outcome = await nonIdempotentWrite(url, {
      method: 'POST',
      headers: { AuthToken: this.opts.authToken },
      body: journal,
      timeoutMs: this.opts.timeoutMs ?? 60_000,
      fetchFn: this.opts.fetchFn,
    });
    if (outcome.kind === 'ok') {
      return {
        outcome,
        sageTransactionRef: extractTransactionRef(outcome.response),
        rawResponse: JSON.stringify(outcome.response)?.slice(0, 4000) ?? null,
      };
    }
    return { outcome, sageTransactionRef: null, rawResponse: null };
  }

  /** Cheap reachability probe for `mewsy validate` — any HTTP response counts. */
  async probe(): Promise<{ reachable: boolean; detail: string }> {
    const fetchFn = this.opts.fetchFn ?? globalThis.fetch;
    try {
      const res = await fetchFn(this.opts.baseUrl, { method: 'GET' });
      return { reachable: true, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { reachable: false, detail: String(err) };
    }
  }
}

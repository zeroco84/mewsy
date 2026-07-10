import { idempotentJsonRequest, nonIdempotentWrite, type FetchFn, type WriteOutcome } from '../util/http.js';

/**
 * HyperAccounts client (spec §7): POST {{url}}/api/journal with the
 * AuthToken header, over localhost on the Sage box, plus the search
 * endpoints over Sage's audit tables (vendor API reference):
 *
 *   POST /api/search/auditHeaders — AUDIT_HEADER (invRef, tranNumber, …)
 *   POST /api/searchSplit         — AUDIT_SPLIT  (line-level detail)
 *
 * /api/journal returns { success, code, response, message } and NO
 * transaction number — tranNumber comes from the auditHeaders search.
 * The message text contains vendor typos; never match on it.
 *
 * The journal write is NOT retried here — the caller owns the
 * attempt/UNKNOWN bookkeeping (see pipeline + posting ledger).
 */

export interface HyperAccountsSplit {
  /** Max 30 chars (vendor API reference). */
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

export interface SearchFilter {
  field: string;
  /** eq | gte | lte | like | in | … (vendor filter grammar). */
  type: string;
  value: unknown;
}

/** A row from AUDIT_HEADER. Field presence depends on the instance — treat as loose. */
export interface AuditHeader {
  invRef?: string;
  tranNumber?: number | string;
  headerNumber?: number | string;
  date?: string;
  accountRef?: string;
  details?: string;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  outstanding?: number;
  [key: string]: unknown;
}

/** A row from AUDIT_SPLIT. Loose for the same reason. */
export interface AuditSplit {
  nominalCode?: string;
  netAmount?: number;
  taxAmount?: number;
  type?: number;
  headerNumber?: number | string;
  [key: string]: unknown;
}

/** GET /api/status response payload (vendor API reference). */
export interface ApiStatus {
  apiVersion?: string;
  sageVersion?: string;
  companyName?: string;
  sdoStatusOk?: boolean;
  odbcStatusOk?: boolean;
  [key: string]: unknown;
}

/** A row of GET /api/taxCode (vendor API reference). */
export interface SageTaxCode {
  index: number;
  description?: string;
  rate: number;
  [key: string]: unknown;
}

/** A row of GET /api/nominal/ (vendor API reference). */
export interface SageNominal {
  accountRef: string;
  name?: string;
  type?: number;
  balance?: number;
  inactiveFlag?: number;
  [key: string]: unknown;
}

export interface HyperAccountsClientOptions {
  baseUrl: string;
  authToken: string;
  fetchFn?: FetchFn;
  timeoutMs?: number;
}

export interface JournalPostResult {
  outcome: WriteOutcome;
  rawResponse: string | null;
}

export class HyperAccountsClient {
  constructor(private readonly opts: HyperAccountsClientOptions) {}

  private url(path: string): string {
    return `${this.opts.baseUrl.replace(/\/$/, '')}${path}`;
  }

  /**
   * Post a journal. Throws AmbiguousWriteError when the outcome is unknowable
   * (timeout / reset / 5xx) so the caller can record it and resolve via the
   * read-back. A 2xx body with success:false is a definite rejection (G1).
   */
  async postJournal(journal: HyperAccountsJournal): Promise<JournalPostResult> {
    const outcome = await nonIdempotentWrite(this.url('/api/journal'), {
      method: 'POST',
      headers: { AuthToken: this.opts.authToken },
      body: journal,
      timeoutMs: this.opts.timeoutMs ?? 60_000,
      fetchFn: this.opts.fetchFn,
    });
    if (outcome.kind !== 'ok') return { outcome, rawResponse: null };

    const body = outcome.response;
    const rawResponse = body === null ? null : JSON.stringify(body).slice(0, 4000);
    if (body !== null && typeof body === 'object' && (body as Record<string, unknown>)['success'] === false) {
      const code = Number((body as Record<string, unknown>)['code']);
      return {
        outcome: { kind: 'rejected', status: Number.isFinite(code) && code > 0 ? code : 200, body: rawResponse ?? '' },
        rawResponse,
      };
    }
    return { outcome, rawResponse };
  }

  /** Filter-array search; reads are idempotent so transient failures retry. */
  private async search<T>(path: string, filters: SearchFilter[]): Promise<T[]> {
    const response = await idempotentJsonRequest(this.url(path), {
      method: 'POST',
      headers: { AuthToken: this.opts.authToken },
      body: filters,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      retries: 2,
      fetchFn: this.opts.fetchFn,
    });
    if (Array.isArray(response)) return response as T[];
    if (response !== null && typeof response === 'object') {
      // Envelope shape not pinned down by the reference — accept common keys.
      for (const key of ['response', 'data', 'results', 'rows', 'headers', 'splits']) {
        const value = (response as Record<string, unknown>)[key];
        if (Array.isArray(value)) return value as T[];
      }
    }
    return [];
  }

  async searchAuditHeaders(filters: SearchFilter[]): Promise<AuditHeader[]> {
    return await this.search<AuditHeader>('/api/search/auditHeaders', filters);
  }

  async searchSplits(filters: SearchFilter[]): Promise<AuditSplit[]> {
    return await this.search<AuditSplit>('/api/searchSplit', filters);
  }

  /**
   * Look a journal up by its idempotency key (G3). `field` defaults to the
   * camelCase response name; the searchable column may differ per instance
   * (e.g. INV_REF) — configurable via hyperAccounts.readback.invRefField.
   */
  async findJournalByInvRef(invRef: string, field = 'invRef'): Promise<AuditHeader | null> {
    const headers = await this.searchAuditHeaders([{ field, type: 'eq', value: invRef }]);
    return headers[0] ?? null;
  }

  private async getJson(path: string): Promise<unknown> {
    return await idempotentJsonRequest(this.url(path), {
      method: 'GET',
      headers: { AuthToken: this.opts.authToken },
      timeoutMs: this.opts.timeoutMs ?? 30_000,
      retries: 2,
      fetchFn: this.opts.fetchFn,
    });
  }

  private static unwrapResults<T>(response: unknown): T[] {
    if (Array.isArray(response)) return response as T[];
    if (response !== null && typeof response === 'object') {
      const results = (response as Record<string, unknown>)['results'];
      if (Array.isArray(results)) return results as T[];
    }
    return [];
  }

  /** GET /api/status → { apiVersion, sageVersion, companyName, sdoStatusOk, odbcStatusOk }. */
  async getStatus(): Promise<ApiStatus | null> {
    const body = await this.getJson('/api/status');
    if (body !== null && typeof body === 'object') {
      const inner = (body as Record<string, unknown>)['response'];
      if (inner !== null && typeof inner === 'object') return inner as ApiStatus;
    }
    return null;
  }

  /** GET /api/taxCode → the Sage tax-code table (index, description, rate). */
  async getTaxCodes(): Promise<SageTaxCode[]> {
    return HyperAccountsClient.unwrapResults<SageTaxCode>(await this.getJson('/api/taxCode'));
  }

  /** GET /api/nominal/ → the nominal ledger (accountRef, name, type, balance, inactiveFlag). */
  async getNominals(): Promise<SageNominal[]> {
    return HyperAccountsClient.unwrapResults<SageNominal>(await this.getJson('/api/nominal/'));
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

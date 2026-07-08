import type Database from 'better-sqlite3';
import type { JournalLine, JournalTotals } from '../domain/journal.js';
import type { LedgerKind, LedgerStatus } from './db.js';

export interface LedgerRow {
  id: number;
  property_code: string;
  business_date: string;
  kind: LedgerKind;
  seq: number;
  attempt: number;
  inv_ref: string;
  status: LedgerStatus;
  content_hash: string;
  journal_json: string;
  totals_json: string | null;
  journal_date: string;
  sage_transaction_ref: string | null;
  ha_response: string | null;
  note: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}

export interface DeadLetterRow {
  id: number;
  ts_utc: string;
  run_id: string;
  property_code: string;
  business_date: string;
  reason: string;
  detail_json: string | null;
  resolved: number;
  resolved_at_utc: string | null;
}

function nowUtc(): string {
  return new Date().toISOString();
}

/**
 * Data access for the posting ledger, watermarks, audit log and dead letter.
 * All journal payloads are stored as JSON of JournalLine[] (signed cents).
 */
export class Store {
  constructor(private readonly db: Database.Database) {}

  // ---- posting ledger -----------------------------------------------------

  rowsForDate(propertyCode: string, businessDate: string): LedgerRow[] {
    return this.db
      .prepare(
        `SELECT * FROM posting_ledger WHERE property_code = ? AND business_date = ? ORDER BY id`,
      )
      .all(propertyCode, businessDate) as LedgerRow[];
  }

  /**
   * The business date's posted day-content: POSTED REVENUE/ADJUSTMENT rows.
   * VAT_SPIKE rows are Phase 0 test journals (operator posts + reverses them)
   * and must never count as the day's revenue for idempotency/reconciliation.
   */
  postedRows(propertyCode: string, businessDate: string): LedgerRow[] {
    return this.rowsForDate(propertyCode, businessDate).filter(
      (r) => r.status === 'POSTED' && r.kind !== 'VAT_SPIKE',
    );
  }

  /** An ATTEMPTING or UNKNOWN row means Sage state is uncertain — the date is blocked. */
  unresolvedRows(propertyCode: string, businessDate: string): LedgerRow[] {
    return this.rowsForDate(propertyCode, businessDate).filter(
      (r) => r.status === 'ATTEMPTING' || r.status === 'UNKNOWN',
    );
  }

  /** Every row with uncertain Sage state, regardless of age (for `mewsy status`). */
  allUnresolvedRows(): LedgerRow[] {
    return this.db
      .prepare(`SELECT * FROM posting_ledger WHERE status IN ('ATTEMPTING','UNKNOWN') ORDER BY id`)
      .all() as LedgerRow[];
  }

  pendingAdjustments(propertyCode?: string): LedgerRow[] {
    const sql = `SELECT * FROM posting_ledger WHERE status = 'PENDING_APPROVAL'${propertyCode ? ' AND property_code = ?' : ''} ORDER BY id`;
    const stmt = this.db.prepare(sql);
    return (propertyCode ? stmt.all(propertyCode) : stmt.all()) as LedgerRow[];
  }

  getLedgerRow(id: number): LedgerRow | undefined {
    return this.db.prepare(`SELECT * FROM posting_ledger WHERE id = ?`).get(id) as LedgerRow | undefined;
  }

  nextSeq(propertyCode: string, businessDate: string, kind: LedgerKind): number {
    const row = this.db
      .prepare(
        `SELECT MAX(seq) AS max_seq FROM posting_ledger WHERE property_code = ? AND business_date = ? AND kind = ?`,
      )
      .get(propertyCode, businessDate, kind) as { max_seq: number | null };
    return (row.max_seq ?? -1) + 1;
  }

  nextAttempt(propertyCode: string, businessDate: string, kind: LedgerKind, seq: number): number {
    const row = this.db
      .prepare(
        `SELECT MAX(attempt) AS max_attempt FROM posting_ledger WHERE property_code = ? AND business_date = ? AND kind = ? AND seq = ?`,
      )
      .get(propertyCode, businessDate, kind, seq) as { max_attempt: number | null };
    return (row.max_attempt ?? 0) + 1;
  }

  insertLedgerRow(input: {
    propertyCode: string;
    businessDate: string;
    kind: LedgerKind;
    seq: number;
    attempt: number;
    invRef: string;
    status: LedgerStatus;
    contentHash: string;
    lines: JournalLine[];
    totals?: JournalTotals | null;
    journalDate: string;
    note?: string;
  }): number {
    const ts = nowUtc();
    const result = this.db
      .prepare(
        `INSERT INTO posting_ledger
           (property_code, business_date, kind, seq, attempt, inv_ref, status, content_hash,
            journal_json, totals_json, journal_date, note, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.propertyCode,
        input.businessDate,
        input.kind,
        input.seq,
        input.attempt,
        input.invRef,
        input.status,
        input.contentHash,
        JSON.stringify(input.lines),
        input.totals ? JSON.stringify(input.totals) : null,
        input.journalDate,
        input.note ?? null,
        ts,
        ts,
      );
    return Number(result.lastInsertRowid);
  }

  updateLedgerStatus(
    id: number,
    status: LedgerStatus,
    fields?: { sageTransactionRef?: string | null; haResponse?: string | null; note?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE posting_ledger
           SET status = ?,
               sage_transaction_ref = COALESCE(?, sage_transaction_ref),
               ha_response = COALESCE(?, ha_response),
               note = COALESCE(?, note),
               updated_at_utc = ?
         WHERE id = ?`,
      )
      .run(status, fields?.sageTransactionRef ?? null, fields?.haResponse ?? null, fields?.note ?? null, nowUtc(), id);
  }

  parseLines(row: LedgerRow): JournalLine[] {
    return JSON.parse(row.journal_json) as JournalLine[];
  }

  recentLedgerRows(limit: number): LedgerRow[] {
    return this.db.prepare(`SELECT * FROM posting_ledger ORDER BY id DESC LIMIT ?`).all(limit) as LedgerRow[];
  }

  // ---- watermarks ----------------------------------------------------------

  getWatermark(propertyCode: string): string | null {
    const row = this.db.prepare(`SELECT last_posted_date FROM watermarks WHERE property_code = ?`).get(propertyCode) as
      | { last_posted_date: string }
      | undefined;
    return row?.last_posted_date ?? null;
  }

  advanceWatermark(propertyCode: string, businessDate: string): void {
    const current = this.getWatermark(propertyCode);
    if (current !== null && businessDate <= current) return; // monotonic only
    this.db
      .prepare(
        `INSERT INTO watermarks (property_code, last_posted_date, updated_at_utc) VALUES (?, ?, ?)
         ON CONFLICT (property_code) DO UPDATE SET last_posted_date = excluded.last_posted_date, updated_at_utc = excluded.updated_at_utc`,
      )
      .run(propertyCode, businessDate, nowUtc());
  }

  // ---- audit log (append-only; spec §8.3) -----------------------------------

  audit(runId: string, event: string, detail: Record<string, unknown>, propertyCode?: string, businessDate?: string): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (ts_utc, run_id, property_code, business_date, event, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(nowUtc(), runId, propertyCode ?? null, businessDate ?? null, event, JSON.stringify(detail));
  }

  // ---- dead letter -----------------------------------------------------------

  deadLetter(runId: string, propertyCode: string, businessDate: string, reason: string, detail: Record<string, unknown>): number {
    const result = this.db
      .prepare(
        `INSERT INTO dead_letter (ts_utc, run_id, property_code, business_date, reason, detail_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(nowUtc(), runId, propertyCode, businessDate, reason, JSON.stringify(detail));
    return Number(result.lastInsertRowid);
  }

  openDeadLetters(propertyCode?: string): DeadLetterRow[] {
    const sql = `SELECT * FROM dead_letter WHERE resolved = 0${propertyCode ? ' AND property_code = ?' : ''} ORDER BY id`;
    const stmt = this.db.prepare(sql);
    return (propertyCode ? stmt.all(propertyCode) : stmt.all()) as DeadLetterRow[];
  }

  resolveDeadLettersFor(propertyCode: string, businessDate: string): void {
    this.db
      .prepare(
        `UPDATE dead_letter SET resolved = 1, resolved_at_utc = ? WHERE property_code = ? AND business_date = ? AND resolved = 0`,
      )
      .run(nowUtc(), propertyCode, businessDate);
  }
}

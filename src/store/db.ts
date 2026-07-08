import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite persistence (spec §8).
 *
 * - posting_ledger: every attempt to put a journal into Sage, keyed by
 *   property + business date + kind + seq. Attempts are never deleted; a
 *   status transition is the only mutation. UNKNOWN rows (ambiguous write
 *   outcomes) block further posting for that date until resolved.
 * - audit_log: append-only, enforced by triggers (spec §8.3 "immutable").
 * - watermarks: last successfully posted business date per property.
 * - dead_letter: failures needing attention; resolved flag only.
 */

export type LedgerStatus =
  | 'ATTEMPTING' // intent recorded, POST in flight (a crash leaves this behind)
  | 'POSTED'
  | 'FAILED' // definitely not in Sage (rejected 4xx / never sent) — safe to retry later
  | 'UNKNOWN' // ambiguous outcome — must be resolved by a human before reposting
  | 'PENDING_APPROVAL' // staged adjustment awaiting `mewsy adjustments approve`
  | 'REJECTED'; // staged adjustment declined or superseded

export type LedgerKind = 'REVENUE' | 'ADJUSTMENT' | 'VAT_SPIKE';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS posting_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_code TEXT NOT NULL,
  business_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('REVENUE','ADJUSTMENT','VAT_SPIKE')),
  seq INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  inv_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ATTEMPTING','POSTED','FAILED','UNKNOWN','PENDING_APPROVAL','REJECTED')),
  content_hash TEXT NOT NULL,
  journal_json TEXT NOT NULL,
  totals_json TEXT,
  journal_date TEXT NOT NULL,
  sage_transaction_ref TEXT,
  ha_response TEXT,
  note TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE (property_code, business_date, kind, seq, attempt)
);
CREATE INDEX IF NOT EXISTS ix_ledger_prop_date ON posting_ledger (property_code, business_date);
CREATE INDEX IF NOT EXISTS ix_ledger_status ON posting_ledger (status);

CREATE TABLE IF NOT EXISTS watermarks (
  property_code TEXT PRIMARY KEY,
  last_posted_date TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc TEXT NOT NULL,
  run_id TEXT NOT NULL,
  property_code TEXT,
  business_date TEXT,
  event TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_prop_date ON audit_log (property_code, business_date);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE IF NOT EXISTS dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc TEXT NOT NULL,
  run_id TEXT NOT NULL,
  property_code TEXT NOT NULL,
  business_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail_json TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at_utc TEXT
);
CREATE INDEX IF NOT EXISTS ix_dead_letter_open ON dead_letter (resolved, property_code);
`;

export function openDb(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

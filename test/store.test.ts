import { describe, expect, it } from 'vitest';
import { makeStore } from './helpers.js';
import type { JournalLine } from '../src/domain/journal.js';

const LINE: JournalLine = {
  nominalCode: '4000',
  details: 'Accommodation',
  kind: 'REVENUE',
  netCents: -900000,
  taxCents: -121500,
  sageTaxCode: 3,
};

describe('posting ledger', () => {
  it('tracks attempts and status transitions', () => {
    const store = makeStore();
    const id = store.insertLedgerRow({
      propertyCode: 'PROP1',
      businessDate: '2026-07-01',
      kind: 'REVENUE',
      seq: 0,
      attempt: 1,
      invRef: 'MEWSY-REV-PROP1-20260701',
      status: 'ATTEMPTING',
      contentHash: 'abc',
      lines: [LINE],
      totals: null,
      journalDate: '2026-07-01',
    });
    expect(store.unresolvedRows('PROP1', '2026-07-01')).toHaveLength(1);
    store.updateLedgerStatus(id, 'POSTED', { sageTransactionRef: 'SAGE-1' });
    expect(store.unresolvedRows('PROP1', '2026-07-01')).toHaveLength(0);
    const rows = store.postedRows('PROP1', '2026-07-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sage_transaction_ref).toBe('SAGE-1');
    expect(store.parseLines(rows[0]!)).toEqual([LINE]);
  });

  it('sequences adjustments and attempts', () => {
    const store = makeStore();
    expect(store.nextSeq('PROP1', '2026-07-01', 'ADJUSTMENT')).toBe(0);
    store.insertLedgerRow({
      propertyCode: 'PROP1', businessDate: '2026-07-01', kind: 'ADJUSTMENT', seq: 0, attempt: 1,
      invRef: 'MEWSY-ADJ-PROP1-20260701-0', status: 'PENDING_APPROVAL', contentHash: 'x', lines: [LINE], journalDate: '2026-07-05',
    });
    expect(store.nextSeq('PROP1', '2026-07-01', 'ADJUSTMENT')).toBe(1);
    expect(store.nextAttempt('PROP1', '2026-07-01', 'ADJUSTMENT', 0)).toBe(2);
    expect(store.pendingAdjustments('PROP1')).toHaveLength(1);
    expect(store.pendingAdjustments('OTHER')).toHaveLength(0);
  });

  it('enforces attempt uniqueness per (property, date, kind, seq)', () => {
    const store = makeStore();
    const base = {
      propertyCode: 'PROP1', businessDate: '2026-07-01', kind: 'REVENUE' as const, seq: 0, attempt: 1,
      invRef: 'X', status: 'ATTEMPTING' as const, contentHash: 'x', lines: [LINE], journalDate: '2026-07-01',
    };
    store.insertLedgerRow(base);
    expect(() => store.insertLedgerRow(base)).toThrow(/UNIQUE/);
  });
});

describe('unresolved rows', () => {
  it('allUnresolvedRows finds old UNKNOWN rows regardless of newer activity', () => {
    // Regression: `mewsy status` only inspected the 12 most recent rows.
    const store = makeStore();
    const unknownId = store.insertLedgerRow({
      propertyCode: 'PROP1', businessDate: '2026-07-01', kind: 'REVENUE', seq: 0, attempt: 1,
      invRef: 'MEWSY-REV-PROP1-20260701', status: 'ATTEMPTING', contentHash: 'x', lines: [LINE], journalDate: '2026-07-01',
    });
    store.updateLedgerStatus(unknownId, 'UNKNOWN');
    for (let i = 0; i < 15; i++) {
      const id = store.insertLedgerRow({
        propertyCode: 'PROP2', businessDate: `2026-07-${String(i + 2).padStart(2, '0')}`, kind: 'REVENUE', seq: 0, attempt: 1,
        invRef: `REF-${i}`, status: 'ATTEMPTING', contentHash: 'x', lines: [LINE], journalDate: '2026-07-02',
      });
      store.updateLedgerStatus(id, 'POSTED');
    }
    const unresolved = store.allUnresolvedRows();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.id).toBe(unknownId);
    expect(store.recentLedgerRows(12).some((r) => r.id === unknownId)).toBe(false); // proves the old path missed it
  });
});

describe('watermarks', () => {
  it('advances monotonically only', () => {
    const store = makeStore();
    expect(store.getWatermark('PROP1')).toBeNull();
    store.advanceWatermark('PROP1', '2026-07-01');
    store.advanceWatermark('PROP1', '2026-07-03');
    store.advanceWatermark('PROP1', '2026-07-02'); // ignored
    expect(store.getWatermark('PROP1')).toBe('2026-07-03');
  });
});

describe('audit log immutability (spec §8.3)', () => {
  it('rejects UPDATE and DELETE at the database layer', () => {
    const store = makeStore();
    store.audit('run-1', 'TEST', { hello: 'world' }, 'PROP1', '2026-07-01');
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    expect(() => db.prepare(`UPDATE audit_log SET event = 'TAMPERED'`).run()).toThrow(/append-only/);
    expect(() => db.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/);
  });
});

describe('dead letters', () => {
  it('opens and resolves per property+date', () => {
    const store = makeStore();
    store.deadLetter('run-1', 'PROP1', '2026-07-01', 'Journal build blocked', { blockers: ['x'] });
    store.deadLetter('run-1', 'PROP1', '2026-07-02', 'Other', {});
    expect(store.openDeadLetters('PROP1')).toHaveLength(2);
    store.resolveDeadLettersFor('PROP1', '2026-07-01');
    const open = store.openDeadLetters('PROP1');
    expect(open).toHaveLength(1);
    expect(open[0]!.business_date).toBe('2026-07-02');
  });
});

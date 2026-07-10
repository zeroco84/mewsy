import { describe, expect, it } from 'vitest';
import { resolveAmbiguousOutcome, verifyInSage, type ReadbackConfig } from '../src/pipeline/readback.js';
import type { JournalLine } from '../src/domain/journal.js';
import { FakeHa } from './helpers.js';

const RB: ReadbackConfig = { enabled: true, invRefField: 'INV_REF', splitLinkField: 'HEADER_NUMBER', compareSplits: true };

const LINES: JournalLine[] = [
  { nominalCode: '4000', details: 'Accommodation', kind: 'REVENUE', netCents: -900000, taxCents: -121500, sageTaxCode: 3 },
  { nominalCode: '1200', details: 'Payments', kind: 'PAYMENT', netCents: 1021500, taxCents: 0, sageTaxCode: 9 },
];

function postedJournal(ha: FakeHa, invRef: string) {
  ha.posted.push({
    date: '01/07/2026',
    invRef,
    accountRef: '1200',
    splits: [
      { details: 'Accommodation', nominalCode: '4000', netAmount: 9000, taxAmount: 1215, taxCode: 3, type: 16 },
      { details: 'Payments', nominalCode: '1200', netAmount: 10215, taxAmount: 0, taxCode: 9, type: 15 },
    ],
  });
}

describe('resolveAmbiguousOutcome', () => {
  it('reports posted with the tranNumber when the journal is found', async () => {
    const ha = new FakeHa();
    postedJournal(ha, 'MEWSY-REV-PROP1-20260701');
    const result = await resolveAmbiguousOutcome(ha, 'MEWSY-REV-PROP1-20260701', RB);
    expect(result).toEqual({ kind: 'posted', tranNumber: 'SAGE-1' });
  });

  it('reports absent when not found, unavailable when the search is down or disabled', async () => {
    const ha = new FakeHa();
    expect(await resolveAmbiguousOutcome(ha, 'NOPE', RB)).toEqual({ kind: 'absent' });
    ha.readback = 'down';
    expect((await resolveAmbiguousOutcome(ha, 'NOPE', RB)).kind).toBe('unavailable');
    expect((await resolveAmbiguousOutcome(new FakeHa(), 'NOPE', { ...RB, enabled: false })).kind).toBe('unavailable');
  });
});

describe('verifyInSage', () => {
  it('verifies presence and split totals against the ledger lines', async () => {
    const ha = new FakeHa();
    postedJournal(ha, 'MEWSY-REV-PROP1-20260701');
    const result = await verifyInSage(ha, [{ invRef: 'MEWSY-REV-PROP1-20260701', lines: LINES }], RB);
    expect(result.kind).toBe('verified');
    expect(result.detail).toContain('split-compared');
  });

  it('flags a journal missing from AUDIT_HEADER as a mismatch', async () => {
    const ha = new FakeHa();
    const result = await verifyInSage(ha, [{ invRef: 'MEWSY-REV-PROP1-20260701', lines: LINES }], RB);
    expect(result.kind).toBe('mismatch');
    expect(result.detail).toContain('not found');
  });

  it('flags a duplicated invRef in Sage as a mismatch (double-post detection)', async () => {
    // Regression: the server accepts duplicate invRefs (G2); a repost race
    // used to be invisible because only headers[0] was ever inspected.
    const ha = new FakeHa();
    postedJournal(ha, 'MEWSY-REV-PROP1-20260701');
    postedJournal(ha, 'MEWSY-REV-PROP1-20260701'); // the duplicate
    const result = await verifyInSage(ha, [{ invRef: 'MEWSY-REV-PROP1-20260701', lines: LINES }], RB);
    expect(result.kind).toBe('mismatch');
    expect(result.detail).toContain('2 times');
  });

  it('flags diverging split amounts as a mismatch', async () => {
    const ha = new FakeHa();
    postedJournal(ha, 'MEWSY-REV-PROP1-20260701');
    const tampered = LINES.map((l) => (l.nominalCode === '4000' ? { ...l, netCents: -900100 } : l));
    const result = await verifyInSage(ha, [{ invRef: 'MEWSY-REV-PROP1-20260701', lines: tampered }], RB);
    expect(result.kind).toBe('mismatch');
    expect(result.detail).toContain('4000');
  });

  it('degrades to unavailable (never a false mismatch) when the search is down', async () => {
    const ha = new FakeHa();
    postedJournal(ha, 'X');
    ha.readback = 'down';
    const result = await verifyInSage(ha, [{ invRef: 'X', lines: LINES }], RB);
    expect(result.kind).toBe('unavailable');
  });
});

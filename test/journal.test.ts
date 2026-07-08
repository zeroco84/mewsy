import { describe, expect, it } from 'vitest';
import {
  buildAdjustmentLines,
  buildDayJournal,
  journalContentHash,
  toHyperAccountsJournal,
  revenueInvRef,
  buildVatSpikeLines,
} from '../src/domain/journal.js';
import { categoriesById, makeCategory, makeItem, makePayment, makeProperty, specExampleData } from './helpers.js';

const DATE = '2026-07-01';

describe('buildDayJournal — spec §5 worked example', () => {
  it('reproduces the spec journal: 3 revenue credits + 1 payment debit, balanced to zero', () => {
    const property = makeProperty();
    const { categories, orderItems, payments } = specExampleData();
    const { journal, blockers, warnings } = buildDayJournal({
      property,
      businessDate: DATE,
      orderItems,
      payments,
      categoriesById: categoriesById(categories),
    });
    expect(blockers).toEqual([]);
    expect(warnings).toEqual([]);
    expect(journal).not.toBeNull();
    expect(journal!.lines).toHaveLength(4);

    const byNominal = Object.fromEntries(journal!.lines.map((l) => [l.nominalCode, l]));
    // Credits are negative signed cents.
    expect(byNominal['4000']).toMatchObject({ netCents: -900000, taxCents: -121500, sageTaxCode: 3, kind: 'REVENUE' });
    expect(byNominal['4001']).toMatchObject({ netCents: -150000, taxCents: -13500, sageTaxCode: 5 });
    expect(byNominal['4002']).toMatchObject({ netCents: -80000, taxCents: -18400, sageTaxCode: 1 });
    expect(byNominal['1200']).toMatchObject({ netCents: 1283400, taxCents: 0, sageTaxCode: 9, kind: 'PAYMENT' });

    expect(journal!.totals).toMatchObject({
      revenueNetCents: 1130000,
      revenueTaxCents: 153400,
      revenueGrossCents: 1283400,
      paymentsCents: 1283400,
      imbalanceCents: 0,
    });
    // Balanced: Dr €12,834.00 = Cr €11,300 net + €1,534 VAT.
    const sum = journal!.lines.reduce((s, l) => s + l.netCents + l.taxCents, 0);
    expect(sum).toBe(0);
  });

  it('maps to the HyperAccounts payload of spec §7 (types 15/16, dd/MM/yyyy, 2dp)', () => {
    const property = makeProperty();
    const { categories, orderItems, payments } = specExampleData();
    const { journal } = buildDayJournal({ property, businessDate: DATE, orderItems, payments, categoriesById: categoriesById(categories) });
    const payload = toHyperAccountsJournal({
      lines: journal!.lines,
      accountRef: property.clearing.accountRef,
      invRef: revenueInvRef(property.code, DATE),
      journalDate: DATE,
    });
    expect(payload.date).toBe('01/07/2026');
    expect(payload.invRef).toBe('MEWSY-REV-PROP1-20260701');
    expect(payload.invRef.length).toBeLessThanOrEqual(30);
    expect(payload.accountRef).toBe('1200');

    const acc = payload.splits.find((s) => s.nominalCode === '4000')!;
    expect(acc).toMatchObject({ netAmount: 9000.0, taxAmount: 1215.0, taxCode: 3, type: 16 });
    const pay = payload.splits.find((s) => s.nominalCode === '1200')!;
    expect(pay).toMatchObject({ netAmount: 12834.0, taxAmount: 0, taxCode: 9, type: 15 });
    for (const split of payload.splits) {
      expect(split.nominalCode.length).toBeLessThanOrEqual(8);
      expect(split.details.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('buildDayJournal — corrections and edge cases', () => {
  it('posts a refund day as-is: negative payment flips to a credit split (spec §5 refunds)', () => {
    const property = makeProperty();
    const categories = [makeCategory('cat-acc', 'Accommodation', '4000')];
    // Refund day: revenue reversal −100 net and a −113.50 refund payment.
    const orderItems = [makeItem('cat-acc', -100, 'IE-R1', -13.5)];
    const payments = [makePayment(-113.5)];
    const { journal, blockers } = buildDayJournal({ property, businessDate: DATE, orderItems, payments, categoriesById: categoriesById(categories) });
    expect(blockers).toEqual([]);
    const revenue = journal!.lines.find((l) => l.nominalCode === '4000')!;
    expect(revenue.netCents).toBe(10000); // reversal of a credit = debit
    const payment = journal!.lines.find((l) => l.kind === 'PAYMENT')!;
    expect(payment.netCents).toBe(-11350);

    const payload = toHyperAccountsJournal({ lines: journal!.lines, accountRef: '1200', invRef: 'X', journalDate: DATE });
    expect(payload.splits.find((s) => s.nominalCode === '4000')!.type).toBe(15); // debit
    expect(payload.splits.find((s) => s.nominalCode === '1200')!.type).toBe(16); // credit
  });

  it('routes an overpayment imbalance to the suspense nominal and warns (spec §5 overpayments)', () => {
    const property = makeProperty();
    const categories = [makeCategory('cat-acc', 'Accommodation', '4000')];
    const orderItems = [makeItem('cat-acc', 100, 'IE-R1', 13.5)];
    const payments = [makePayment(150)]; // €36.50 more than the bill
    const { journal, warnings } = buildDayJournal({ property, businessDate: DATE, orderItems, payments, categoriesById: categoriesById(categories) });
    const suspense = journal!.lines.find((l) => l.kind === 'SUSPENSE')!;
    expect(suspense.nominalCode).toBe('2205');
    expect(suspense.netCents).toBe(-3650); // credit balance parked in suspense
    expect(warnings.some((w) => w.includes('suspense'))).toBe(true);
    expect(journal!.lines.reduce((s, l) => s + l.netCents + l.taxCents, 0)).toBe(0);
  });

  it('treats a ≤tolerance imbalance as rounding, no warning', () => {
    const property = makeProperty();
    const categories = [makeCategory('cat-acc', 'Accommodation', '4000')];
    const orderItems = [makeItem('cat-acc', 100, 'IE-R1', 13.5)];
    const payments = [makePayment(113.51)]; // 1 cent over
    const { journal, warnings } = buildDayJournal({ property, businessDate: DATE, orderItems, payments, categoriesById: categoriesById(categories) });
    const rounding = journal!.lines.find((l) => l.kind === 'ROUNDING')!;
    expect(rounding.netCents).toBe(-1);
    expect(warnings).toEqual([]);
  });

  it('groups items of the same category and tax code onto one line', () => {
    const property = makeProperty();
    const categories = [makeCategory('cat-acc', 'Accommodation', '4000')];
    const orderItems = [makeItem('cat-acc', 100, 'IE-R1', 13.5), makeItem('cat-acc', 50, 'IE-R1', 6.75)];
    const { journal } = buildDayJournal({ property, businessDate: DATE, orderItems, payments: [], categoriesById: categoriesById(categories) });
    const revenueLines = journal!.lines.filter((l) => l.kind === 'REVENUE');
    expect(revenueLines).toHaveLength(1);
    expect(revenueLines[0]).toMatchObject({ netCents: -15000, taxCents: -2025 });
  });

  it('blocks on missing category, missing ledger code, unmapped tax code, non-EUR and multi-tax items', () => {
    const property = makeProperty();
    const categories = [
      makeCategory('cat-acc', 'Accommodation', '4000'),
      makeCategory('cat-nocode', 'Spa', null),
    ];
    const orderItems = [
      makeItem(null, 10, 'IE-R1', 1.35),
      makeItem('cat-ghost', 10, 'IE-R1', 1.35),
      makeItem('cat-nocode', 10, 'IE-R1', 1.35),
      makeItem('cat-acc', 10, 'IE-WAT', 1.35),
      makeItem('cat-acc', 10, null, 0, { Amount: { Currency: 'USD', NetValue: 10, GrossValue: 10, TaxValues: [] } }),
      makeItem('cat-acc', 10, null, 0, {
        Amount: { Currency: 'EUR', NetValue: 10, GrossValue: 12, TaxValues: [{ Code: 'IE-R1', Value: 1 }, { Code: 'IE-S', Value: 1 }] },
      }),
    ];
    const { journal, blockers } = buildDayJournal({ property, businessDate: DATE, orderItems, payments: [], categoriesById: categoriesById(categories) });
    expect(journal).toBeNull();
    expect(blockers.some((b) => b.includes('no Accounting Category'))).toBe(true);
    expect(blockers.some((b) => b.includes('unknown Accounting Category'))).toBe(true);
    expect(blockers.some((b) => b.includes('has no LedgerAccountCode'))).toBe(true);
    expect(blockers.some((b) => b.includes('IE-WAT'))).toBe(true);
    expect(blockers.some((b) => b.includes('EUR-only'))).toBe(true);
    expect(blockers.some((b) => b.includes('tax values'))).toBe(true);
  });

  it('uses a payment accounting category ledger code over the tender map (mapping lives in Mews)', () => {
    const property = makeProperty();
    const categories = [
      makeCategory('cat-acc', 'Accommodation', '4000'),
      makeCategory('cat-cash', 'Cash payments', '1215'),
    ];
    const orderItems = [makeItem('cat-acc', 100, 'IE-R1', 13.5)];
    const payments = [
      makePayment(50, 'Cash', { AccountingCategoryId: 'cat-cash' }), // category wins
      makePayment(40, 'Cash'), // tender map
      makePayment(23.5, 'GiftCard'), // default clearing
    ];
    const { journal } = buildDayJournal({ property, businessDate: DATE, orderItems, payments, categoriesById: categoriesById(categories) });
    const nominals = journal!.lines.filter((l) => l.kind === 'PAYMENT').map((l) => l.nominalCode).sort();
    expect(nominals).toEqual(['1200', '1210', '1215']);
  });

  it('warns when VAT differs from the mapped rate but still posts Mews figures', () => {
    const property = makeProperty();
    const categories = [makeCategory('cat-acc', 'Accommodation', '4000')];
    const orderItems = [makeItem('cat-acc', 100, 'IE-R1', 20)]; // 13.5% of 100 ≠ 20
    const { journal, warnings } = buildDayJournal({ property, businessDate: DATE, orderItems, payments: [], categoriesById: categoriesById(categories) });
    expect(journal).not.toBeNull();
    expect(warnings.some((w) => w.includes('differs from 13.5%'))).toBe(true);
    expect(journal!.lines.find((l) => l.kind === 'REVENUE')!.taxCents).toBe(-2000);
  });
});

describe('idempotency hash + adjustment delta (spec §8.1/8.3)', () => {
  function build(net: number) {
    const property = makeProperty();
    const categories = [makeCategory('cat-acc', 'Accommodation', '4000')];
    const orderItems = [makeItem('cat-acc', net, 'IE-R1', Math.round(net * 13.5) / 100)];
    const payments = [makePayment(net + Math.round(net * 13.5) / 100)];
    return buildDayJournal({ property, businessDate: DATE, orderItems, payments, categoriesById: categoriesById(categories) }).journal!;
  }

  it('hash is stable across line order and label changes', () => {
    const a = build(100);
    const b = build(100);
    b.lines = [...b.lines].reverse().map((l) => ({ ...l, details: l.details + ' renamed' }));
    expect(journalContentHash(a)).toBe(journalContentHash(b));
    const c = build(101);
    expect(journalContentHash(a)).not.toBe(journalContentHash(c));
  });

  it('delta is empty for identical content', () => {
    const a = build(100);
    const b = build(100);
    expect(buildAdjustmentLines([a.lines], b, DATE)).toEqual([]);
  });

  it('delta captures only the movement and balances to zero', () => {
    const before = build(100); // net 100, tax 13.50, payment 113.50
    const after = build(90); // net 90, tax 12.15, payment 102.15
    const delta = buildAdjustmentLines([before.lines], after, DATE);
    expect(delta.length).toBe(2);
    const revenue = delta.find((l) => l.nominalCode === '4000')!;
    expect(revenue.netCents).toBe(1000); // 100→90 credit shrinks: +10.00 debit movement
    expect(revenue.taxCents).toBe(135);
    const payment = delta.find((l) => l.nominalCode === '1200')!;
    expect(payment.netCents).toBe(-1135);
    expect(delta.reduce((s, l) => s + l.netCents + l.taxCents, 0)).toBe(0);
  });

  it('cumulative posted journals (original + adjustment) then equal figures → empty delta', () => {
    const original = build(100);
    const target = build(90);
    const adjustment = buildAdjustmentLines([original.lines], target, DATE);
    const again = buildAdjustmentLines([original.lines, adjustment], target, DATE);
    expect(again).toEqual([]);
  });

  it('splits an opposite-signed delta (net up, tax down) into postable net-only and tax-only lines', () => {
    // Regression: net and tax moving in opposite directions (hand-edited VAT
    // in Mews) produced a single unpostable line that crashed approve/auto-post.
    const property = makeProperty();
    const posted: import('../src/domain/journal.js').JournalLine[] = [
      { nominalCode: '4000', details: 'Accommodation', kind: 'REVENUE', netCents: -10000, taxCents: -2000, sageTaxCode: 3 },
    ];
    const target = {
      propertyCode: 'PROP1',
      businessDate: DATE,
      accountRef: '1200',
      lines: [
        { nominalCode: '4000', details: 'Accommodation', kind: 'REVENUE' as const, netCents: -11000, taxCents: -1350, sageTaxCode: 3 },
        { nominalCode: '1200', details: 'Payments', kind: 'PAYMENT' as const, netCents: 350, taxCents: 0, sageTaxCode: 9 },
      ],
      totals: {} as import('../src/domain/journal.js').JournalTotals,
    };
    const delta = buildAdjustmentLines([posted], target, DATE);
    const fourThousand = delta.filter((l) => l.nominalCode === '4000');
    expect(fourThousand).toHaveLength(2); // split into net-only + tax-only
    expect(fourThousand.find((l) => l.taxCents === 0)!.netCents).toBe(-1000);
    expect(fourThousand.find((l) => l.netCents === 0)!.taxCents).toBe(650);
    expect(delta.reduce((s, l) => s + l.netCents + l.taxCents, 0)).toBe(0);
    // And the payload builds without throwing:
    expect(() => toHyperAccountsJournal({ lines: delta, accountRef: '1200', invRef: 'X', journalDate: DATE })).not.toThrow();
  });
});

describe('VAT spike (spec §9)', () => {
  it('builds one line per distinct positive rate plus a balancing clearing line', () => {
    const property = makeProperty();
    const lines = buildVatSpikeLines(property, '9998', 10000, false);
    expect(lines).toHaveLength(4); // 23%, 13.5%, 9% + clearing
    const rates = lines.filter((l) => l.kind === 'SPIKE' && l.taxCents !== 0);
    expect(rates.map((l) => l.sageTaxCode).sort()).toEqual([1, 3, 5]);
    expect(lines.reduce((s, l) => s + l.netCents + l.taxCents, 0)).toBe(0);
    // 23% of €100 = €23, 13.5% = €13.50, 9% = €9 → clearing debit €345.50
    const clearing = lines.find((l) => l.nominalCode === '1200')!;
    expect(clearing.netCents).toBe(34550);
  });

  it('reverse negates every line', () => {
    const property = makeProperty();
    const fwd = buildVatSpikeLines(property, '9998', 10000, false);
    const rev = buildVatSpikeLines(property, '9998', 10000, true);
    for (let i = 0; i < fwd.length; i++) {
      expect(rev[i]!.netCents).toBe(-fwd[i]!.netCents || 0);
      expect(rev[i]!.taxCents).toBe(-fwd[i]!.taxCents || 0);
    }
  });
});

import type { PropertyConfig } from '../config.js';
import type { HyperAccountsJournal, HyperAccountsSplit } from '../hyperaccounts/client.js';
import type { MewsAccountingCategory, MewsOrderItem, MewsPayment } from '../mews/types.js';
import { compactDate, formatSageDate } from '../util/dates.js';
import { stableHash } from '../util/hash.js';
import { centsFromDecimal, decimalFromCents, formatEur } from '../util/money.js';

/**
 * Journal domain (spec §5).
 *
 * Sign convention: amounts are signed integer cents with DEBIT positive and
 * CREDIT negative. Revenue (money earned) is a credit; payments received are
 * debits to clearing. A balanced journal satisfies Σ(net + tax) = 0 — matching
 * the spec's example where Dr €12,834.00 = Cr €11,300 net + €1,534 VAT.
 */

export type LineKind = 'REVENUE' | 'PAYMENT' | 'ROUNDING' | 'SUSPENSE' | 'ADJUSTMENT' | 'SPIKE';

export interface JournalLine {
  nominalCode: string;
  details: string;
  kind: LineKind;
  /** Signed cents, debit positive / credit negative. */
  netCents: number;
  taxCents: number;
  sageTaxCode: number;
  mewsTaxCode?: string | null;
  deptNumber?: string;
  extraRef?: string;
}

export interface JournalTotals {
  /** Positive magnitudes for reporting (credits shown positive). */
  revenueNetCents: number;
  revenueTaxCents: number;
  revenueGrossCents: number;
  paymentsCents: number;
  /** Signed residual before the balancing line (debits − credits). */
  imbalanceCents: number;
  orderItemCount: number;
  paymentCount: number;
}

export interface BuiltJournal {
  propertyCode: string;
  businessDate: string;
  accountRef: string;
  lines: JournalLine[];
  totals: JournalTotals;
}

export interface BuildResult {
  journal: BuiltJournal | null;
  /** Any blocker stops the date from posting (spec §10: "or nothing posts"). */
  blockers: string[];
  warnings: string[];
}

// Vendor API reference: splits[].details is max 30 chars (G6).
const DETAILS_MAX = 30;
const EXTRA_REF_MAX = 30;
const INV_REF_MAX = 30;
const NOMINAL_MAX = 8;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/** Normalise -0 (from sign-flipping a zero) to 0 so equality and JSON stay clean. */
function nz(cents: number): number {
  return cents === 0 ? 0 : cents;
}

interface LineAccumulator {
  nominalCode: string;
  sageTaxCode: number;
  deptNumber?: string;
  kind: LineKind;
  details: string;
  extraRef?: string;
  mewsTaxCode?: string | null;
  netCents: number;
  taxCents: number;
}

function groupKey(a: { nominalCode: string; sageTaxCode: number; deptNumber?: string; kind: LineKind }): string {
  return [a.nominalCode, a.sageTaxCode, a.deptNumber ?? '', a.kind].join('|');
}

export function buildDayJournal(input: {
  property: PropertyConfig;
  businessDate: string;
  orderItems: MewsOrderItem[];
  payments: MewsPayment[];
  categoriesById: Map<string, MewsAccountingCategory>;
}): BuildResult {
  const { property, businessDate, orderItems, payments, categoriesById } = input;
  const blockers: string[] = [];
  const warnings: string[] = [];
  const groups = new Map<string, LineAccumulator>();

  const unmappedTaxCodes = new Set<string>();

  const add = (acc: Omit<LineAccumulator, 'netCents' | 'taxCents'>, netCents: number, taxCents: number) => {
    const key = groupKey(acc);
    const existing = groups.get(key);
    if (existing) {
      existing.netCents = nz(existing.netCents + netCents);
      existing.taxCents = nz(existing.taxCents + taxCents);
    } else {
      groups.set(key, { ...acc, netCents: nz(netCents), taxCents: nz(taxCents) });
    }
  };

  const ledgerCodeOf = (cat: MewsAccountingCategory): string | null => {
    const raw = property.ledgerCodeField === 'PostingAccountCode' ? cat.PostingAccountCode : cat.LedgerAccountCode;
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  };

  const deptOf = (cat: MewsAccountingCategory | null): string | undefined => {
    if (!property.deptFromCostCenter || !cat?.CostCenterCode) return undefined;
    const code = cat.CostCenterCode.trim();
    if (code === '') return undefined;
    if (code.length > 2) {
      warnings.push(
        `Category "${cat.Name ?? cat.Id}" CostCenterCode ${JSON.stringify(code)} exceeds deptNumber max of 2 chars — omitted`,
      );
      return undefined;
    }
    return code;
  };

  // ---- Revenue side (credits) --------------------------------------------
  for (const item of orderItems) {
    const label = `order item ${item.Id}${item.Name ? ` ("${item.Name}")` : ''}`;
    if (item.Amount.Currency !== 'EUR') {
      blockers.push(`${label} is in ${item.Amount.Currency}; Mewsy is EUR-only (spec: Republic of Ireland, EUR)`);
      continue;
    }
    if (!item.AccountingCategoryId) {
      blockers.push(`${label} has no Accounting Category — cannot resolve a Sage nominal`);
      continue;
    }
    const cat = categoriesById.get(item.AccountingCategoryId);
    if (!cat) {
      blockers.push(`${label} references unknown Accounting Category ${item.AccountingCategoryId}`);
      continue;
    }
    const nominal = ledgerCodeOf(cat);
    if (!nominal) {
      blockers.push(
        `Accounting Category "${cat.Name ?? cat.Id}" has no ${property.ledgerCodeField} in Mews — finance must set a Sage nominal on every active category (spec §10)`,
      );
      continue;
    }
    if (nominal.length > NOMINAL_MAX) {
      blockers.push(
        `Accounting Category "${cat.Name ?? cat.Id}" ledger code ${JSON.stringify(nominal)} exceeds Sage nominal max of ${NOMINAL_MAX} chars`,
      );
      continue;
    }

    let netCents: number;
    let taxCentsTotal: number;
    let grossCents: number;
    try {
      netCents = centsFromDecimal(item.Amount.NetValue, label);
      grossCents = centsFromDecimal(item.Amount.GrossValue, label);
      taxCentsTotal = (item.Amount.TaxValues ?? []).reduce(
        (sum, tv) => sum + centsFromDecimal(tv.Value, `${label} tax ${tv.Code}`),
        0,
      );
    } catch (err) {
      blockers.push(String(err));
      continue;
    }

    const taxValues = item.Amount.TaxValues ?? [];
    if (taxValues.length > 1) {
      blockers.push(
        `${label} carries ${taxValues.length} tax values (${taxValues.map((t) => t.Code).join(', ')}) — multi-tax items cannot be split onto one journal line; needs a decision`,
      );
      continue;
    }

    if (Math.abs(netCents + taxCentsTotal - grossCents) > 1) {
      warnings.push(
        `${label}: gross ${formatEur(grossCents)} ≠ net ${formatEur(netCents)} + tax ${formatEur(taxCentsTotal)} — posting net+tax as reported`,
      );
    }

    const mewsTaxCode = taxValues[0]?.Code ?? null;
    let sageTaxCode: number;
    if (mewsTaxCode === null) {
      if (taxCentsTotal !== 0) {
        blockers.push(`${label} has tax ${formatEur(taxCentsTotal)} but no tax code`);
        continue;
      }
      sageTaxCode = property.exemptSageTaxCode;
    } else {
      const mapping = property.taxCodeMap[mewsTaxCode];
      if (!mapping) {
        unmappedTaxCodes.add(mewsTaxCode);
        continue;
      }
      sageTaxCode = mapping.sageTaxCode;
      const expectedTax = Math.round((netCents * mapping.ratePercent) / 100);
      if (Math.abs(expectedTax - taxCentsTotal) > property.vatWarnToleranceCents) {
        const description = `${label}: tax ${formatEur(taxCentsTotal)} differs from ${mapping.ratePercent}% of net ${formatEur(netCents)} (expected ~${formatEur(expectedTax)})`;
        if (property.vatMismatchPolicy === 'block') {
          // D15 (response §3): a wrong rate in Mews becomes a wrong VAT3 in
          // Sage — block while the tax mapping is being established.
          blockers.push(`${description} — blocked by vatMismatchPolicy 'block' (relax to 'warn' once the mapping is trusted)`);
          continue;
        }
        warnings.push(`${description} — posting Mews figures as-is`);
      }
    }

    // Revenue is a credit: negate. A rebate/refund line (negative in Mews)
    // therefore becomes a debit naturally — spec §5 "post as-is".
    add(
      {
        nominalCode: nominal,
        sageTaxCode,
        deptNumber: deptOf(cat),
        kind: 'REVENUE',
        details: truncate(cat.Name ?? `Category ${cat.Code ?? cat.Id}`, DETAILS_MAX),
        extraRef: truncate(`AC-${cat.Code ?? cat.Id}`, EXTRA_REF_MAX),
        mewsTaxCode,
      },
      -netCents,
      -taxCentsTotal,
    );
  }

  if (unmappedTaxCodes.size > 0) {
    blockers.push(
      `Mews tax code(s) ${[...unmappedTaxCodes].sort().join(', ')} have no entry in taxCodeMap — finance must map each to a Sage 50 (Ireland) tax code (spec §10)`,
    );
  }

  // ---- Payment side (debits to clearing) ---------------------------------
  for (const payment of payments) {
    const label = `payment ${payment.Id}`;
    if (payment.Amount.Currency !== 'EUR') {
      blockers.push(`${label} is in ${payment.Amount.Currency}; Mewsy is EUR-only`);
      continue;
    }
    let amountCents: number;
    try {
      amountCents = centsFromDecimal(payment.Amount.GrossValue, label);
    } catch (err) {
      blockers.push(String(err));
      continue;
    }

    const tender = payment.Data?.Discriminator ?? payment.Type ?? 'Unknown';

    // Mapping precedence keeps the spec's "mapping lives in Mews" principle:
    // a payment accounting category with a ledger code wins; then the
    // config tender map; then the default clearing nominal.
    let nominal: string | null = null;
    let source = '';
    if (payment.AccountingCategoryId) {
      const cat = categoriesById.get(payment.AccountingCategoryId);
      if (cat) {
        nominal = ledgerCodeOf(cat);
        if (nominal) source = `category "${cat.Name ?? cat.Id}"`;
      }
    }
    if (!nominal) {
      nominal = property.clearing.byTender[tender] ?? property.clearing.defaultNominal;
      source = property.clearing.byTender[tender] ? `tender map (${tender})` : 'default clearing';
    }
    if (nominal.length > NOMINAL_MAX) {
      blockers.push(`Clearing nominal ${JSON.stringify(nominal)} from ${source} exceeds ${NOMINAL_MAX} chars`);
      continue;
    }

    // Payment received = debit (positive). Mews reports refunds as negative
    // payment amounts, which flow through as negative debits (i.e. credits).
    add(
      {
        nominalCode: nominal,
        sageTaxCode: property.exemptSageTaxCode,
        kind: 'PAYMENT',
        details: truncate(`Payments - ${tender}`, DETAILS_MAX),
        extraRef: truncate(`PAY-${tender}`, EXTRA_REF_MAX),
      },
      amountCents,
      0,
    );
  }

  // ---- Assemble, balance, verify -----------------------------------------
  const lines: JournalLine[] = [];
  for (const acc of groups.values()) {
    if (acc.netCents === 0 && acc.taxCents === 0) continue;
    if (acc.netCents !== 0 && acc.taxCents !== 0 && Math.sign(acc.netCents) !== Math.sign(acc.taxCents)) {
      blockers.push(
        `Line ${acc.nominalCode} (${acc.details}) aggregates to net ${formatEur(acc.netCents)} with opposite-signed tax ${formatEur(acc.taxCents)} — cannot be expressed as a single debit/credit split; needs a decision`,
      );
      continue;
    }
    lines.push({ ...acc });
  }

  lines.sort((a, b) => groupKey(a).localeCompare(groupKey(b)));

  const revenueLines = lines.filter((l) => l.kind === 'REVENUE');
  const paymentLines = lines.filter((l) => l.kind === 'PAYMENT');
  const revenueNetCents = -revenueLines.reduce((s, l) => s + l.netCents, 0);
  const revenueTaxCents = -revenueLines.reduce((s, l) => s + l.taxCents, 0);
  const paymentsCents = paymentLines.reduce((s, l) => s + l.netCents, 0);

  // Any blocker means `lines` is a PARTIAL set (blocked items were excluded),
  // so an imbalance computed from it is a phantom figure — suspense routing,
  // materiality checks and their warnings/alerts must not run on it.
  if (blockers.length > 0) {
    return { journal: null, blockers, warnings };
  }

  const signedSum = lines.reduce((s, l) => s + l.netCents + l.taxCents, 0);
  const imbalanceCents = signedSum;

  if (imbalanceCents !== 0) {
    const balancing = -imbalanceCents;
    const isRounding = Math.abs(imbalanceCents) <= property.roundingToleranceCents;

    // D7 (response §3): a large suspense line means something upstream broke —
    // posting it is worse than not posting. Block above materiality. The
    // percent limit uses the MAGNITUDE of day revenue so it still bites on
    // refund-heavy (negative) days; with zero revenue any non-rounding
    // imbalance exceeds the percent limit ("above EITHER limit blocks").
    const absImbalance = Math.abs(imbalanceCents);
    const revenueMagnitude = Math.abs(revenueNetCents + revenueTaxCents);
    const breachesAbsolute = property.suspenseMaterialityCents !== null && absImbalance > property.suspenseMaterialityCents;
    const breachesPercent =
      property.suspenseMaterialityPercent !== null &&
      absImbalance > (revenueMagnitude * property.suspenseMaterialityPercent) / 100;
    if (!isRounding && (breachesAbsolute || breachesPercent)) {
      blockers.push(
        `Day imbalance ${formatEur(imbalanceCents)} exceeds the suspense materiality limit (${[
          property.suspenseMaterialityCents !== null ? formatEur(property.suspenseMaterialityCents) : null,
          property.suspenseMaterialityPercent !== null ? `${property.suspenseMaterialityPercent}% of revenue` : null,
        ]
          .filter(Boolean)
          .join(' / ')}) — refusing to post to suspense; investigate upstream (D7)`,
      );
    } else {
      if (!isRounding) {
        warnings.push(
          `Day imbalance ${formatEur(imbalanceCents)} routed to suspense nominal ${property.suspenseNominal} (overpayment / unmatched movement — visible for follow-up, spec §5)`,
        );
      }
      lines.push({
        nominalCode: property.suspenseNominal,
        details: isRounding ? 'Rounding (Mewsy)' : 'Overpayment/suspense (Mewsy)',
        kind: isRounding ? 'ROUNDING' : 'SUSPENSE',
        netCents: balancing,
        taxCents: 0,
        sageTaxCode: property.exemptSageTaxCode,
        extraRef: 'MEWSY-BALANCE',
      });
    }
  }

  // A materiality breach above is the only blocker that can appear past the
  // partial-set gate — nothing was posted to `lines` for it, so return now.
  if (blockers.length > 0) {
    return { journal: null, blockers, warnings };
  }

  const finalSum = lines.reduce((s, l) => s + l.netCents + l.taxCents, 0);
  if (finalSum !== 0) {
    throw new Error(`Internal invariant broken: journal for ${businessDate} nets to ${formatEur(finalSum)}, not zero`);
  }

  return {
    journal: {
      propertyCode: property.code,
      businessDate,
      accountRef: property.clearing.accountRef,
      lines,
      totals: {
        revenueNetCents,
        revenueTaxCents,
        revenueGrossCents: revenueNetCents + revenueTaxCents,
        paymentsCents,
        imbalanceCents,
        orderItemCount: orderItems.length,
        paymentCount: payments.length,
      },
    },
    blockers,
    warnings,
  };
}

// ---- Idempotency hash (spec §8.1) ----------------------------------------

/**
 * Hash of the journal's financial substance only: nominal, tax code, dept and
 * signed amounts. Labels/details are excluded so a category rename does not
 * masquerade as a financial change.
 */
export function journalContentHash(journal: Pick<BuiltJournal, 'businessDate' | 'accountRef' | 'lines'>): string {
  const substance = journal.lines
    .map((l) => ({
      n: l.nominalCode,
      t: l.sageTaxCode,
      d: l.deptNumber ?? '',
      net: l.netCents,
      tax: l.taxCents,
    }))
    .filter((l) => l.net !== 0 || l.tax !== 0)
    .sort((a, b) => `${a.n}|${a.t}|${a.d}`.localeCompare(`${b.n}|${b.t}|${b.d}`));
  return stableHash({ date: journal.businessDate, accountRef: journal.accountRef, lines: substance });
}

// ---- Adjustment deltas (spec §8.3) ----------------------------------------

/** Aggregate posted journals' lines by financial identity (nominal, tax code, dept). */
export function aggregateLines(lineSets: JournalLine[][]): Map<string, { netCents: number; taxCents: number }> {
  const out = new Map<string, { netCents: number; taxCents: number }>();
  for (const lines of lineSets) {
    for (const l of lines) {
      const key = [l.nominalCode, l.sageTaxCode, l.deptNumber ?? ''].join('|');
      const cur = out.get(key) ?? { netCents: 0, taxCents: 0 };
      cur.netCents += l.netCents;
      cur.taxCents += l.taxCents;
      out.set(key, cur);
    }
  }
  return out;
}

/**
 * Delta journal lines that move Sage from what was already posted for the
 * date (original + prior adjustments) to the current Mews figures. Empty
 * result = financially identical. Never edits posted entries (spec §8.3).
 */
export function buildAdjustmentLines(
  postedLineSets: JournalLine[][],
  target: BuiltJournal,
  sourceDate: string,
): JournalLine[] {
  const posted = aggregateLines(postedLineSets);
  const wanted = aggregateLines([target.lines]);
  const keys = new Set([...posted.keys(), ...wanted.keys()]);
  const lines: JournalLine[] = [];
  for (const key of [...keys].sort()) {
    const [nominalCode = '', taxStr = '0', dept = ''] = key.split('|');
    const before = posted.get(key) ?? { netCents: 0, taxCents: 0 };
    const after = wanted.get(key) ?? { netCents: 0, taxCents: 0 };
    const netCents = after.netCents - before.netCents;
    const taxCents = after.taxCents - before.taxCents;
    if (netCents === 0 && taxCents === 0) continue;
    const base = {
      nominalCode,
      sageTaxCode: Number(taxStr),
      deptNumber: dept === '' ? undefined : dept,
      kind: 'ADJUSTMENT' as const,
      extraRef: truncate(`ADJ-${compactDate(sourceDate)}`, EXTRA_REF_MAX),
    };
    if (netCents !== 0 && taxCents !== 0 && Math.sign(netCents) !== Math.sign(taxCents)) {
      // Net and tax moved in opposite directions (possible when Mews tax is
      // hand-edited — posted as-is per the VAT-warning policy). One split
      // cannot carry opposite signs, so emit separate net and tax movements.
      lines.push({ ...base, details: truncate(`Adj ${sourceDate} net (Mewsy)`, DETAILS_MAX), netCents, taxCents: 0 });
      lines.push({ ...base, details: truncate(`Adj ${sourceDate} tax (Mewsy)`, DETAILS_MAX), netCents: 0, taxCents });
      continue;
    }
    lines.push({
      ...base,
      details: truncate(`Adj ${sourceDate} (Mewsy)`, DETAILS_MAX),
      netCents,
      taxCents,
    });
  }
  const sum = lines.reduce((s, l) => s + l.netCents + l.taxCents, 0);
  if (sum !== 0) {
    throw new Error(`Adjustment delta for ${sourceDate} nets to ${formatEur(sum)}, not zero — refusing to build`);
  }
  return lines;
}

// ---- invRef keys (spec §7: ≤30 chars, deterministic) -----------------------

function assertInvRef(ref: string): string {
  if (ref.length > INV_REF_MAX) {
    throw new Error(`invRef ${JSON.stringify(ref)} exceeds ${INV_REF_MAX} chars (HyperAccounts limit)`);
  }
  return ref;
}

export function revenueInvRef(propertyCode: string, businessDate: string): string {
  return assertInvRef(`MEWSY-REV-${propertyCode}-${compactDate(businessDate)}`);
}

export function adjustmentInvRef(propertyCode: string, businessDate: string, seq: number): string {
  return assertInvRef(`MEWSY-ADJ-${propertyCode}-${compactDate(businessDate)}-${seq}`);
}

export function vatSpikeInvRef(propertyCode: string, businessDate: string, reverse = false): string {
  // Reversal needs its own idempotency key ("SPKR" keeps it inside 30 chars).
  const tag = reverse ? 'SPKR' : 'SPIKE';
  return assertInvRef(`MEWSY-${tag}-${propertyCode}-${compactDate(businessDate)}`);
}

// ---- HyperAccounts payload (spec §7) ---------------------------------------

const JD_DEBIT = 15 as const;
const JC_CREDIT = 16 as const;

/**
 * Convert signed lines into the HyperAccounts body. A line's debit/credit
 * type comes from the sign of its total effect (net + tax); amounts are sent
 * as positive 2-dp numbers, mirroring the spec §7 example.
 */
export function toHyperAccountsJournal(input: {
  lines: JournalLine[];
  accountRef: string;
  invRef: string;
  journalDate: string; // yyyy-MM-dd business/posting date
}): HyperAccountsJournal {
  const splits: HyperAccountsSplit[] = input.lines
    .filter((l) => l.netCents !== 0 || l.taxCents !== 0)
    .map((l) => {
      const effect = l.netCents + l.taxCents;
      if (l.netCents !== 0 && l.taxCents !== 0 && Math.sign(l.netCents) !== Math.sign(l.taxCents)) {
        throw new Error(`Line ${l.nominalCode} has opposite-signed net/tax — cannot map to a single split`);
      }
      const split: HyperAccountsSplit = {
        details: truncate(l.details, DETAILS_MAX),
        nominalCode: l.nominalCode,
        netAmount: decimalFromCents(Math.abs(l.netCents)),
        taxAmount: decimalFromCents(Math.abs(l.taxCents)),
        taxCode: l.sageTaxCode,
        type: effect >= 0 ? JD_DEBIT : JC_CREDIT,
      };
      if (l.deptNumber) split.deptNumber = l.deptNumber;
      if (l.extraRef) split.extraRef = truncate(l.extraRef, EXTRA_REF_MAX);
      return split;
    });
  return {
    date: formatSageDate(input.journalDate),
    invRef: assertInvRef(input.invRef),
    accountRef: input.accountRef,
    splits,
  };
}

// ---- VAT spike (spec §9 / Phase 0) ----------------------------------------

/**
 * A tiny test journal exercising every configured VAT rate so finance can run
 * the Sage 50 (Ireland) VAT3 return and confirm each rate lands in the right
 * box. `reverse` negates every line to back the test out afterwards.
 */
export function buildVatSpikeLines(
  property: PropertyConfig,
  revenueNominal: string,
  netCentsPerRate: number,
  reverse: boolean,
): JournalLine[] {
  const seen = new Set<number>();
  const lines: JournalLine[] = [];
  const sign = reverse ? -1 : 1;
  const entries = Object.entries(property.taxCodeMap)
    .filter(([, m]) => m.ratePercent > 0)
    .sort(([, a], [, b]) => b.ratePercent - a.ratePercent);
  for (const [mewsCode, mapping] of entries) {
    if (seen.has(mapping.sageTaxCode)) continue;
    seen.add(mapping.sageTaxCode);
    const taxCents = Math.round((netCentsPerRate * mapping.ratePercent) / 100);
    lines.push({
      nominalCode: revenueNominal,
      details: truncate(`VAT spike ${mapping.ratePercent}% (${mapping.label ?? mewsCode})`, DETAILS_MAX),
      kind: 'SPIKE',
      netCents: nz(-netCentsPerRate * sign),
      taxCents: nz(-taxCents * sign),
      sageTaxCode: mapping.sageTaxCode,
      mewsTaxCode: mewsCode,
      extraRef: 'MEWSY-VAT-SPIKE',
    });
  }
  if (lines.length === 0) throw new Error('taxCodeMap has no positive-rate entries to spike');
  const balance = -lines.reduce((s, l) => s + l.netCents + l.taxCents, 0);
  lines.push({
    nominalCode: property.clearing.defaultNominal,
    details: 'VAT spike clearing (Mewsy)',
    kind: 'SPIKE',
    netCents: balance,
    taxCents: 0,
    sageTaxCode: property.exemptSageTaxCode,
    extraRef: 'MEWSY-VAT-SPIKE',
  });
  return lines;
}

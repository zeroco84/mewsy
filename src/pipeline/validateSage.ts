import type { PropertyConfig } from '../config.js';
import type { ApiStatus, SageNominal, SageTaxCode } from '../hyperaccounts/client.js';
import type { MewsAccountingCategory } from '../mews/types.js';

/**
 * Sage reference-data checks for `mewsy validate` (spec §10: "Every code must
 * exist in the Sage chart of accounts, or nothing posts"), made possible by
 * the vendor's read endpoints:
 *
 *  - every nominal Mewsy could post to (Mews category ledger codes, clearing,
 *    tender map, suspense) must exist and be active in the nominal ledger;
 *  - every configured Sage tax code must exist, and its Sage rate must match
 *    the configured ratePercent (a mismatch here is exactly the wrong-VAT3
 *    risk that vatMismatchPolicy guards at runtime).
 */

export interface SageReader {
  getStatus(): Promise<ApiStatus | null>;
  getTaxCodes(): Promise<SageTaxCode[]>;
  getNominals(): Promise<SageNominal[]>;
}

export interface SageCheckResult {
  lines: string[];
  problems: number;
}

export async function sageReferenceChecks(
  ha: SageReader,
  property: PropertyConfig,
  /** Active Mews categories, when the Mews side was reachable (else []). */
  activeCategories: MewsAccountingCategory[],
): Promise<SageCheckResult> {
  const lines: string[] = [];
  let problems = 0;

  let status: ApiStatus | null;
  let nominals: SageNominal[];
  let taxCodes: SageTaxCode[];
  try {
    [status, nominals, taxCodes] = await Promise.all([ha.getStatus(), ha.getNominals(), ha.getTaxCodes()]);
  } catch (err) {
    return {
      lines: [`· Sage reference checks skipped — endpoints unavailable (${String(err instanceof Error ? err.message : err)})`],
      problems: 0,
    };
  }

  if (status) {
    lines.push(
      `✓ Sage: company "${status.companyName ?? '?'}", Sage ${status.sageVersion ?? '?'}, API ${status.apiVersion ?? '?'}, SDO ${status.sdoStatusOk ? 'OK' : 'NOT OK'}`,
    );
    if (status.sdoStatusOk === false) {
      lines.push('✗ SDO status is NOT OK — journal posting will fail');
      problems++;
    }
  }

  // --- nominals -------------------------------------------------------------
  if (nominals.length === 0) {
    lines.push('· Nominal ledger empty or endpoint returned no rows — nominal checks skipped');
  } else {
    const byRef = new Map(nominals.map((n) => [n.accountRef, n]));
    const wanted = new Map<string, string>(); // nominal → where it comes from
    wanted.set(property.clearing.defaultNominal, 'clearing.defaultNominal');
    for (const [tender, nominal] of Object.entries(property.clearing.byTender)) {
      wanted.set(nominal, `clearing.byTender.${tender}`);
    }
    wanted.set(property.suspenseNominal, 'suspenseNominal');
    for (const cat of activeCategories) {
      const code = (property.ledgerCodeField === 'PostingAccountCode' ? cat.PostingAccountCode : cat.LedgerAccountCode)?.trim();
      if (code) wanted.set(code, `Mews category "${cat.Name ?? cat.Id}"`);
    }

    const missing: string[] = [];
    const inactive: string[] = [];
    for (const [nominal, source] of wanted) {
      const row = byRef.get(nominal);
      if (!row) missing.push(`${nominal} (${source})`);
      else if (row.inactiveFlag === 1) inactive.push(`${nominal} (${source})`);
    }
    if (missing.length === 0 && inactive.length === 0) {
      lines.push(`✓ All ${wanted.size} configured/mapped nominal(s) exist in the Sage nominal ledger (${nominals.length} nominals read)`);
    }
    for (const m of missing) {
      lines.push(`✗ Nominal ${m} does not exist in the Sage chart of accounts — postings using it will be rejected (spec §10)`);
      problems++;
    }
    for (const i of inactive) {
      lines.push(`✗ Nominal ${i} is INACTIVE in Sage`);
      problems++;
    }
  }

  // --- tax codes --------------------------------------------------------------
  if (taxCodes.length === 0) {
    lines.push('· Tax-code table empty or endpoint returned no rows — tax checks skipped');
  } else {
    const byIndex = new Map(taxCodes.map((t) => [t.index, t]));
    const checks: Array<{ sageTaxCode: number; ratePercent: number | null; source: string }> = [
      { sageTaxCode: property.exemptSageTaxCode, ratePercent: null, source: 'exemptSageTaxCode' },
      ...Object.entries(property.taxCodeMap).map(([mewsCode, m]) => ({
        sageTaxCode: m.sageTaxCode,
        ratePercent: m.ratePercent,
        source: `taxCodeMap.${mewsCode}`,
      })),
    ];
    let ok = 0;
    for (const check of checks) {
      const row = byIndex.get(check.sageTaxCode);
      if (!row) {
        lines.push(`✗ Sage tax code T${check.sageTaxCode} (${check.source}) does not exist in the Sage tax-code table`);
        problems++;
        continue;
      }
      if (check.ratePercent !== null && Math.abs(row.rate - check.ratePercent) > 0.001) {
        lines.push(
          `✗ ${check.source}: configured rate ${check.ratePercent}% but Sage T${check.sageTaxCode} ("${row.description ?? ''}") is ${row.rate}% — VAT would post to the wrong rate/box`,
        );
        problems++;
        continue;
      }
      ok++;
    }
    if (ok === checks.length) {
      lines.push(`✓ All ${checks.length} configured Sage tax code(s) exist${checks.length > 1 ? ' and rates match' : ''} (Sage table has ${taxCodes.length} codes)`);
    }
  }

  return { lines, problems };
}

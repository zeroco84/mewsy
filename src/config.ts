import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isValidBusinessDate, parseEndOfDayMinutes } from './util/dates.js';

/**
 * Configuration (spec §10 — finance-owned).
 *
 * The accounting correctness lives here and in Mews itself:
 *  - ledger (nominal) codes ride on Mews Accounting Categories, not here;
 *  - this file owns the tax-code map, clearing/suspense nominals, timing
 *    overrides and the property → Sage-company wiring.
 *
 * Secrets are never stored in the file — fields ending in `Env` name the
 * environment variable that holds the actual token.
 */

const nominalCode = z
  .string()
  .trim()
  .min(1)
  .max(8, 'Sage nominal codes are max 8 characters (HyperAccounts splits[].nominalCode)');

const taxMapEntry = z.object({
  sageTaxCode: z.number().int().min(0).max(99),
  ratePercent: z.number().min(0).max(100),
  label: z.string().optional(),
});

const clearingSchema = z.object({
  /** Top-level accountRef sent on the journal (bank/clearing reference). */
  accountRef: z.string().trim().min(1).max(8),
  /** Nominal for payment debits when no tender-specific mapping applies. */
  defaultNominal: nominalCode,
  /** Tender (Mews payment Data.Discriminator or Type) → clearing nominal. */
  byTender: z.record(z.string(), nominalCode).default({}),
});

const settingsShape = {
  timezone: z.string().default('Europe/Dublin'),
  /** "HH:mm" — the property's end-of-day boundary (spec §6). */
  endOfDay: z
    .string()
    .default('00:00')
    .refine((v) => {
      try {
        parseEndOfDayMinutes(v);
        return true;
      } catch {
        return false;
      }
    }, 'endOfDay must be "HH:mm"'),
  /**
   * Full posting delay in days (editable-history window + 1). null → derive
   * from the Mews EditableHistoryInterval at runtime (spec §6).
   */
  postingDelayDays: z.number().int().min(1).max(60).nullable().default(null),
  /** Safety valve on catch-up after downtime. */
  maxCatchupDays: z.number().int().min(1).max(366).default(31),
  /** Imbalance up to this many cents is treated as rounding; beyond it, suspense + alert. */
  roundingToleranceCents: z.number().int().min(0).max(1000).default(2),
  /** Per-line |net×rate − tax| beyond this warns (Mews stays source of truth). */
  vatWarnToleranceCents: z.number().int().min(0).max(1000).default(2),
  /** Stage adjustment journals for human approval instead of auto-posting. */
  requireAdjustmentApproval: z.boolean().default(true),
  /** Journal date for adjustments: date detected vs original business date. */
  adjustmentDating: z.enum(['detection', 'source']).default('detection'),
  /** Which Mews accounting-category field carries the Sage nominal. */
  ledgerCodeField: z.enum(['LedgerAccountCode', 'PostingAccountCode']).default('LedgerAccountCode'),
  /**
   * Automatic retries for the journal POST. Default 0: a failed/ambiguous
   * post is recorded and alerted, never blindly re-sent (see util/http.ts).
   */
  journalRetries: z.number().int().min(0).max(3).default(0),
  /** Sage tax code for non-VATable lines (payments, suspense, rounding). */
  exemptSageTaxCode: z.number().int().min(0).max(99),
  /** Mews TaxValues[].Code (e.g. "IE-R1") → Sage 50 (Ireland) tax code. */
  taxCodeMap: z.record(z.string(), taxMapEntry),
  clearing: clearingSchema,
  /** Nominal that absorbs day-level imbalance (overpayments etc., spec §5). */
  suspenseNominal: nominalCode,
  /** Map Mews CostCenterCode → HyperAccounts deptNumber (max 2 chars). */
  deptFromCostCenter: z.boolean().default(false),
};

const settingsSchema = z.object(settingsShape);
const settingsOverrideSchema = z.object(
  Object.fromEntries(Object.entries(settingsShape).map(([k, v]) => [k, v.optional()])) as {
    [K in keyof typeof settingsShape]: z.ZodOptional<(typeof settingsShape)[K]>;
  },
);

const propertySchema = z
  .object({
    /** Short code used in invRef keys — keep ≤8 chars so invRef fits 30. */
    code: z
      .string()
      .regex(/^[A-Z0-9]{1,8}$/, 'property code must be 1-8 chars of A-Z / 0-9 (it is embedded in the ≤30-char invRef)'),
    name: z.string().min(1),
    mewsAccessTokenEnv: z.string().min(1),
    /** First business date Mewsy is responsible for. */
    startDate: z.string().refine(isValidBusinessDate, 'startDate must be yyyy-MM-dd'),
    hyperAccounts: z.object({
      baseUrl: z.string().url(),
      authTokenEnv: z.string().min(1),
    }),
  })
  .merge(settingsOverrideSchema);

const configSchema = z.object({
  mews: z.object({
    baseUrl: z.string().url().default('https://api.mews.com'),
    clientTokenEnv: z.string().default('MEWS_CLIENT_TOKEN'),
    clientName: z.string().default('Mewsy 0.1.0'),
  }),
  alerts: z
    .object({
      webhookUrlEnv: z.string().optional(),
    })
    .default({}),
  defaults: settingsSchema,
  properties: z.array(propertySchema).min(1),
});

export type Settings = z.infer<typeof settingsSchema>;
export type RawConfig = z.infer<typeof configSchema>;

export interface PropertyConfig extends Settings {
  code: string;
  name: string;
  startDate: string;
  mewsAccessTokenEnv: string;
  hyperAccounts: { baseUrl: string; authTokenEnv: string };
  endOfDayMinutes: number;
}

export interface MewsyConfig {
  mews: { baseUrl: string; clientTokenEnv: string; clientName: string };
  alerts: { webhookUrlEnv?: string };
  properties: PropertyConfig[];
}

export function loadConfig(path: string): MewsyConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config ${path}: ${String(err)}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Config ${path} failed validation:\n${issues}`);
  }
  const cfg = parsed.data;

  const seen = new Set<string>();
  const properties = cfg.properties.map((p) => {
    if (seen.has(p.code)) throw new Error(`Duplicate property code ${p.code} in config`);
    seen.add(p.code);
    const { code, name, startDate, mewsAccessTokenEnv, hyperAccounts, ...overrides } = p;
    const merged: Settings = { ...cfg.defaults };
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
    }
    return {
      ...merged,
      code,
      name,
      startDate,
      mewsAccessTokenEnv,
      hyperAccounts,
      endOfDayMinutes: parseEndOfDayMinutes(merged.endOfDay),
    } satisfies PropertyConfig;
  });

  return { mews: cfg.mews, alerts: cfg.alerts, properties };
}

/** Resolve a token env var, failing with a message that names it. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Environment variable ${name} is not set (referenced from config)`);
  }
  return value.trim();
}

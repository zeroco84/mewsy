/**
 * All monetary amounts inside Mewsy are integer euro cents.
 * Decimals exist only at the API boundaries (Mews responses in,
 * HyperAccounts request bodies out).
 */

export class MoneyPrecisionError extends Error {
  constructor(value: number, context: string) {
    super(`Amount ${value} in ${context} is not representable in whole cents`);
    this.name = 'MoneyPrecisionError';
  }
}

/**
 * Convert a decimal EUR amount (as parsed from JSON) to integer cents.
 * Rejects values that are not whole cents beyond float noise, so a bad
 * upstream figure fails loudly instead of being silently rounded.
 */
export function centsFromDecimal(value: number, context: string): number {
  if (!Number.isFinite(value)) throw new MoneyPrecisionError(value, context);
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) throw new MoneyPrecisionError(value, context);
  return cents;
}

/** Convert integer cents to a 2-dp number for JSON request bodies. */
export function decimalFromCents(cents: number): number {
  if (!Number.isSafeInteger(cents)) throw new MoneyPrecisionError(cents, 'decimalFromCents');
  return Number((cents / 100).toFixed(2));
}

/** Human-readable EUR, e.g. "€12,834.00" (negative: "-€50.00"). */
export function formatEur(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  const grouped = euros.toLocaleString('en-IE');
  return `${sign}€${grouped}.${rem}`;
}

import { Duration } from 'luxon';

/**
 * Parse a Mews EditableHistoryInterval (ISO 8601 duration, e.g. "P1D",
 * "P0Y0M3DT0H0M0S") into a whole number of days, rounding any partial
 * day up — we must never post a date Mews can still edit.
 */
export function editableWindowDays(iso: string): number {
  const d = Duration.fromISO(iso);
  if (!d.isValid) {
    throw new Error(`Cannot parse Mews EditableHistoryInterval ${JSON.stringify(iso)} as an ISO 8601 duration`);
  }
  const days = d.as('days');
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`Mews EditableHistoryInterval ${JSON.stringify(iso)} resolves to invalid day count ${days}`);
  }
  return Math.ceil(days);
}

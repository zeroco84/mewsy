import { DateTime } from 'luxon';

/**
 * Business-date arithmetic (spec §6).
 *
 * A "business date" is a calendar date string (yyyy-MM-dd) in the property's
 * timezone. The property's day runs from (midnight + endOfDay offset) to the
 * same moment the next day — e.g. endOfDay "02:00" means the business date
 * 2026-07-01 covers 2026-07-01T02:00 local to 2026-07-02T02:00 local.
 */

export function parseEndOfDayMinutes(endOfDay: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(endOfDay);
  if (!m) throw new Error(`endOfDay must be "HH:mm", got ${JSON.stringify(endOfDay)}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new Error(`endOfDay out of range: ${endOfDay}`);
  return hours * 60 + minutes;
}

export function isValidBusinessDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && DateTime.fromISO(date, { zone: 'utc' }).isValid;
}

/**
 * Start of business date D's window: zoned midnight + the end-of-day offset.
 * Around a DST transition the boundary's local clock time may shift by the
 * transition hour — that is acceptable; what is NOT acceptable is a gap or
 * overlap between consecutive windows, so the window END is defined as the
 * next date's START (contiguity by construction). Mixing exact-minute and
 * calendar-day arithmetic here previously dropped one hour of items and
 * double-fetched another around each DST change when endOfDay ≠ 00:00.
 */
function windowStartLocal(date: string, timezone: string, endOfDayMinutes: number): DateTime {
  const start = DateTime.fromISO(date, { zone: timezone }).plus({ minutes: endOfDayMinutes });
  if (!start.isValid) throw new Error(`Invalid timezone or date: ${timezone} / ${date}`);
  return start;
}

/** The UTC interval [startUtc, endUtc) covering business date D at a property. */
export function businessDateWindowUtc(
  date: string,
  timezone: string,
  endOfDayMinutes: number,
): { startUtc: string; endUtc: string } {
  if (!isValidBusinessDate(date)) throw new Error(`Invalid business date ${JSON.stringify(date)}`);
  const localStart = windowStartLocal(date, timezone, endOfDayMinutes);
  const localEnd = windowStartLocal(nextDay(date), timezone, endOfDayMinutes);
  return {
    startUtc: localStart.toUTC().toISO({ suppressMilliseconds: true })!,
    endUtc: localEnd.toUTC().toISO({ suppressMilliseconds: true })!,
  };
}

/**
 * The business date currently in progress at a property ("business today").
 * Before the end-of-day boundary the previous calendar date is still open —
 * at 01:30 local with endOfDay 02:00, business today is still yesterday.
 * Defined via the same window boundaries as businessDateWindowUtc so the
 * two can never disagree.
 */
export function currentBusinessDate(nowUtc: DateTime, timezone: string, endOfDayMinutes: number): string {
  const local = nowUtc.setZone(timezone);
  if (!local.isValid) throw new Error(`Invalid timezone ${JSON.stringify(timezone)}`);
  const candidate = local.toISODate()!;
  return local < windowStartLocal(candidate, timezone, endOfDayMinutes) ? previousDay(candidate) : candidate;
}

/**
 * Latest business date eligible for posting (spec §6): post day D at
 * D + (editable-history window + 1 day). delayDays is that full posting delay,
 * so on business-day X the latest eligible date is X - delayDays.
 * Example (window 1 → delay 2): on 3 June, 1 June entries become eligible.
 */
export function latestEligibleBusinessDate(
  nowUtc: DateTime,
  timezone: string,
  endOfDayMinutes: number,
  delayDays: number,
): string {
  const today = currentBusinessDate(nowUtc, timezone, endOfDayMinutes);
  return DateTime.fromISO(today, { zone: 'utc' }).minus({ days: delayDays }).toISODate()!;
}

/** Inclusive range of business dates from `from` to `to`; empty if from > to. */
export function businessDateRange(from: string, to: string): string[] {
  if (!isValidBusinessDate(from) || !isValidBusinessDate(to)) {
    throw new Error(`Invalid date range ${from}..${to}`);
  }
  const out: string[] = [];
  let d = DateTime.fromISO(from, { zone: 'utc' });
  const end = DateTime.fromISO(to, { zone: 'utc' });
  while (d <= end) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}

export function nextDay(date: string): string {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days: 1 }).toISODate()!;
}

export function previousDay(date: string): string {
  return DateTime.fromISO(date, { zone: 'utc' }).minus({ days: 1 }).toISODate()!;
}

/** HyperAccounts wants dd/MM/yyyy (spec §7). */
export function formatSageDate(date: string): string {
  if (!isValidBusinessDate(date)) throw new Error(`Invalid business date ${JSON.stringify(date)}`);
  const dt = DateTime.fromISO(date, { zone: 'utc' });
  return dt.toFormat('dd/MM/yyyy');
}

/** Compact yyyyMMdd used inside invRef idempotency keys. */
export function compactDate(date: string): string {
  return date.replaceAll('-', '');
}

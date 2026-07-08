import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  businessDateRange,
  businessDateWindowUtc,
  currentBusinessDate,
  formatSageDate,
  latestEligibleBusinessDate,
  nextDay,
  parseEndOfDayMinutes,
} from '../src/util/dates.js';

describe('business dates', () => {
  it('parses end-of-day offsets', () => {
    expect(parseEndOfDayMinutes('00:00')).toBe(0);
    expect(parseEndOfDayMinutes('02:00')).toBe(120);
    expect(() => parseEndOfDayMinutes('2am')).toThrow();
    expect(() => parseEndOfDayMinutes('25:00')).toThrow();
  });

  it('computes the UTC window for an Irish summer date (IST = UTC+1)', () => {
    const w = businessDateWindowUtc('2026-07-01', 'Europe/Dublin', 0);
    expect(w.startUtc).toBe('2026-06-30T23:00:00Z');
    expect(w.endUtc).toBe('2026-07-01T23:00:00Z');
  });

  it('applies the end-of-day offset', () => {
    const w = businessDateWindowUtc('2026-07-01', 'Europe/Dublin', 120);
    expect(w.startUtc).toBe('2026-07-01T01:00:00Z');
    expect(w.endUtc).toBe('2026-07-02T01:00:00Z');
  });

  it('keeps a full local day across the DST spring-forward (29 Mar 2026)', () => {
    const w = businessDateWindowUtc('2026-03-29', 'Europe/Dublin', 0);
    // Midnight local is UTC+0 before the change; next midnight is UTC+1.
    expect(w.startUtc).toBe('2026-03-29T00:00:00Z');
    expect(w.endUtc).toBe('2026-03-29T23:00:00Z');
  });

  it('windows stay contiguous across both DST transitions with a non-zero end-of-day offset', () => {
    // Regression: exact-minute start + calendar-day end used to leave a one-hour
    // gap (money silently dropped) and a one-hour overlap (money double-posted)
    // around each transition when endOfDay ≠ 00:00.
    const spans = [
      ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31'], // spring forward 29 Mar
      ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'], // fall back 25 Oct
    ];
    for (const offset of [0, 120, 90]) {
      for (const dates of spans) {
        for (let i = 0; i < dates.length - 1; i++) {
          const a = businessDateWindowUtc(dates[i]!, 'Europe/Dublin', offset);
          const b = businessDateWindowUtc(dates[i + 1]!, 'Europe/Dublin', offset);
          expect(a.endUtc, `${dates[i]} → ${dates[i + 1]} @${offset}m`).toBe(b.startUtc);
        }
      }
    }
  });

  it('transition-day windows cover 23h (spring) and 25h (fall) so no hour is lost or doubled', () => {
    const hours = (d: string) => {
      const w = businessDateWindowUtc(d, 'Europe/Dublin', 120);
      return DateTime.fromISO(w.endUtc).diff(DateTime.fromISO(w.startUtc), 'hours').hours;
    };
    expect(hours('2026-03-28') + hours('2026-03-29') + hours('2026-03-30')).toBe(71); // 23h day in there
    expect(hours('2026-10-24') + hours('2026-10-25') + hours('2026-10-26')).toBe(73); // 25h day in there
  });

  it('currentBusinessDate agrees with the window boundaries around the fall-back morning', () => {
    // 25 Oct 2026, clocks 02:00 IST → 01:00 GMT. Boundary 02:00 local.
    const eod = 120;
    // 00:30 IST (23:30Z prev day): before the boundary → business 24 Oct.
    expect(currentBusinessDate(DateTime.fromISO('2026-10-24T23:30:00Z'), 'Europe/Dublin', eod)).toBe('2026-10-24');
    // 03:00 local (02:00Z): past the boundary → business 25 Oct.
    expect(currentBusinessDate(DateTime.fromISO('2026-10-25T02:00:00Z'), 'Europe/Dublin', eod)).toBe('2026-10-25');
  });

  it('holds the previous business date open until the end-of-day boundary', () => {
    // 01:30 local on 3 June with an 02:00 boundary → business today is 2 June.
    const now = DateTime.fromISO('2026-06-03T00:30:00Z'); // 01:30 IST
    expect(currentBusinessDate(now, 'Europe/Dublin', 120)).toBe('2026-06-02');
    // After the boundary it rolls over.
    const later = DateTime.fromISO('2026-06-03T01:30:00Z'); // 02:30 IST
    expect(currentBusinessDate(later, 'Europe/Dublin', 120)).toBe('2026-06-03');
  });

  it('matches the spec §6 example: window 1 day → 1 June posts on 3 June', () => {
    const on3June = DateTime.fromISO('2026-06-03T10:00:00Z');
    expect(latestEligibleBusinessDate(on3June, 'Europe/Dublin', 0, 2)).toBe('2026-06-01');
    // window 7 days → delay 8: 1 June eligible on 9 June
    const on9June = DateTime.fromISO('2026-06-09T10:00:00Z');
    expect(latestEligibleBusinessDate(on9June, 'Europe/Dublin', 0, 8)).toBe('2026-06-01');
  });

  it('builds inclusive ranges', () => {
    expect(businessDateRange('2026-06-30', '2026-07-02')).toEqual(['2026-06-30', '2026-07-01', '2026-07-02']);
    expect(businessDateRange('2026-07-02', '2026-07-01')).toEqual([]);
    expect(nextDay('2026-06-30')).toBe('2026-07-01');
  });

  it('formats Sage dates dd/MM/yyyy (spec §7)', () => {
    expect(formatSageDate('2026-07-01')).toBe('01/07/2026');
  });
});

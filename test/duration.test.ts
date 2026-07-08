import { describe, expect, it } from 'vitest';
import { editableWindowDays } from '../src/util/duration.js';

describe('editableWindowDays', () => {
  it('parses whole-day ISO durations', () => {
    expect(editableWindowDays('P1D')).toBe(1);
    expect(editableWindowDays('P7D')).toBe(7);
    expect(editableWindowDays('P0Y0M3DT0H0M0S')).toBe(3);
  });

  it('rounds partial days up (never post inside the window)', () => {
    expect(editableWindowDays('PT12H')).toBe(1);
    expect(editableWindowDays('P1DT1H')).toBe(2);
    expect(editableWindowDays('PT0S')).toBe(0);
  });

  it('rejects garbage', () => {
    expect(() => editableWindowDays('yesterday')).toThrow(/ISO 8601/);
    expect(() => editableWindowDays('')).toThrow();
  });
});

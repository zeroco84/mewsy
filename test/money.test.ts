import { describe, expect, it } from 'vitest';
import { centsFromDecimal, decimalFromCents, formatEur, MoneyPrecisionError } from '../src/util/money.js';

describe('money', () => {
  it('converts decimals to cents exactly', () => {
    expect(centsFromDecimal(9000, 'x')).toBe(900000);
    expect(centsFromDecimal(0.01, 'x')).toBe(1);
    expect(centsFromDecimal(1215.0, 'x')).toBe(121500);
    expect(centsFromDecimal(-50.25, 'x')).toBe(-5025);
    // classic float traps
    expect(centsFromDecimal(0.1 + 0.2, 'x')).toBe(30);
    expect(centsFromDecimal(19.99, 'x')).toBe(1999);
  });

  it('rejects sub-cent amounts', () => {
    expect(() => centsFromDecimal(1.005001, 'x')).toThrow(MoneyPrecisionError);
    expect(() => centsFromDecimal(Number.NaN, 'x')).toThrow(MoneyPrecisionError);
    expect(() => centsFromDecimal(Infinity, 'x')).toThrow(MoneyPrecisionError);
  });

  it('round-trips cents to 2-dp decimals', () => {
    expect(decimalFromCents(1283400)).toBe(12834.0);
    expect(decimalFromCents(121500)).toBe(1215.0);
    expect(decimalFromCents(1)).toBe(0.01);
    expect(decimalFromCents(-5025)).toBe(-50.25);
  });

  it('formats EUR', () => {
    expect(formatEur(1283400)).toBe('€12,834.00');
    expect(formatEur(-5000)).toBe('-€50.00');
    expect(formatEur(5)).toBe('€0.05');
  });
});

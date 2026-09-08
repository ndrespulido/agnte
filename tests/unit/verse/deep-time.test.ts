import { describe, expect, it } from 'vitest';
import {
  CALENDAR_LIMIT_YEARS,
  MAX_DEEP_TIME_YEARS,
  MIN_DEEP_TIME_YEARS,
  toDeepTimeYears,
} from '@/modules/verse';
import { parseDeepTimeYears, toDate } from '@/modules/verse/domain/deep-time';

const now = new Date('2026-01-01T00:00:00.000Z');

describe('parseDeepTimeYears', () => {
  it('accepts the events the catalogue is built from', () => {
    for (const years of [-13.8e9, -4.5e9, -66e6, -300_000, -12_000, -2_000, -57]) {
      expect(parseDeepTimeYears(years).ok).toBe(true);
    }
  });

  it('accepts both bounds', () => {
    expect(parseDeepTimeYears(MIN_DEEP_TIME_YEARS).ok).toBe(true);
    expect(parseDeepTimeYears(MAX_DEEP_TIME_YEARS).ok).toBe(true);
  });

  it('refuses a fat-fingered exponent', () => {
    // The bound exists for this, not to adjudicate cosmology.
    expect(parseDeepTimeYears(-1.38e90).ok).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses %p',
    (value) => {
      expect(parseDeepTimeYears(value).ok).toBe(false);
    },
  );
});

describe('the calendar limit', () => {
  it('is inside what a Date can actually hold', () => {
    // The constant claims to be the span a calendar date can express. If a Date
    // cannot hold it, the claim — and any code branching on it — is wrong.
    expect(toDate(CALENDAR_LIMIT_YEARS, now)).not.toBe(null);
    expect(toDate(-CALENDAR_LIMIT_YEARS, now)).not.toBe(null);
  });

  it('is well short of the deep-time range, which is the whole reason it exists', () => {
    expect(CALENDAR_LIMIT_YEARS).toBeLessThan(Math.abs(MIN_DEEP_TIME_YEARS));
  });
});

describe('toDeepTimeYears', () => {
  it('puts now at zero', () => {
    expect(toDeepTimeYears(now, now)).toBe(0);
  });

  it('is negative for the past and positive for the future', () => {
    expect(toDeepTimeYears(new Date('2020-01-01T00:00:00Z'), now)).toBeLessThan(0);
    expect(toDeepTimeYears(new Date('2030-01-01T00:00:00Z'), now)).toBeGreaterThan(0);
  });

  it('measures a year as about a year', () => {
    const oneYearOn = new Date('2027-01-01T00:00:00.000Z');
    expect(toDeepTimeYears(oneYearOn, now)).toBeCloseTo(1, 2);
  });

  it('round-trips through toDate inside calendar range', () => {
    const date = new Date('1994-06-15T12:00:00.000Z');
    const years = toDeepTimeYears(date, now);
    const back = toDate(years, now);
    expect(back).not.toBe(null);
    expect(Math.abs((back as Date).getTime() - date.getTime())).toBeLessThan(1);
  });
});

describe('toDate', () => {
  it('returns null past what a Date can hold rather than an Invalid Date', () => {
    // An Invalid Date propagates silently through comparisons and formatting;
    // a null forces the caller to decide.
    expect(toDate(-66e6, now)).toBe(null);
    expect(toDate(MIN_DEEP_TIME_YEARS, now)).toBe(null);
  });

  it('handles a value inside range', () => {
    expect(toDate(1, now)).toBeInstanceOf(Date);
  });
});

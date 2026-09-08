import { type Result, err, ok } from '@/shared/kernel';
import { deepTimeOutOfRange } from './errors';

/**
 * Placing an event outside calendar range (CLAUDE.md).
 *
 * A JavaScript `Date` spans ±8.64e15 ms — about ±273,000 years — and Postgres
 * `timestamptz` caps out at year 294276. Neither reaches "66 million years
 * ago", so a Verse about the Chicxulub impact cannot be stored as a timestamp
 * at all. `deepTimeYears` is therefore a plain float, negative for years before
 * present, used *instead of* `eventStart`/`eventEnd` and never alongside them.
 *
 * A float is deliberate. Nobody knows when the Big Bang happened to the second,
 * and pretending otherwise by storing an exact instant would be false
 * precision; -13.8e9 says what is actually known.
 */

/**
 * Roughly the age of the universe, rounded outward.
 *
 * A bound rather than a fact: it exists to catch a fat-fingered exponent
 * (-1.38e90) rather than to adjudicate cosmology. If the figure is revised, the
 * rounding leaves room.
 */
export const MIN_DEEP_TIME_YEARS = -14_000_000_000;

/** Far enough ahead for "the sun becomes a red giant" and no further. */
export const MAX_DEEP_TIME_YEARS = 10_000_000_000;

/**
 * The span a calendar date can express, in years either side of now.
 *
 * Below this a Verse should use `eventStart`; the two representations meet
 * here. Kept as a constant because it is a property of the storage, not a
 * judgement, and a reader will want to know why ~273,000 and not some round
 * number.
 */
export const CALENDAR_LIMIT_YEARS = 273_000;

export function parseDeepTimeYears(
  value: number,
): Result<number, ReturnType<typeof deepTimeOutOfRange>> {
  if (!Number.isFinite(value)) {
    return err(deepTimeOutOfRange(MIN_DEEP_TIME_YEARS, MAX_DEEP_TIME_YEARS));
  }
  if (value < MIN_DEEP_TIME_YEARS || value > MAX_DEEP_TIME_YEARS) {
    return err(deepTimeOutOfRange(MIN_DEEP_TIME_YEARS, MAX_DEEP_TIME_YEARS));
  }
  return ok(value);
}

/**
 * Where a calendar date sits on the deep-time axis.
 *
 * The timeline merges personal Verses with the global catalogue (CLAUDE.md), so
 * the two representations need one comparable scale. Julian years (365.25 days)
 * rather than calendar years, because at this magnitude leap-year bookkeeping is
 * noise and a constant divisor keeps the mapping reversible.
 */
const MS_PER_JULIAN_YEAR = 365.25 * 24 * 60 * 60 * 1000;

export const toDeepTimeYears = (date: Date, now: Date): number =>
  (date.getTime() - now.getTime()) / MS_PER_JULIAN_YEAR;

/**
 * The calendar date a deep-time offset corresponds to, or null when it is
 * beyond what a Date can hold — which is the normal case for anything worth
 * storing as deep time, and the reason this returns null rather than an
 * Invalid Date that would propagate silently.
 */
export function toDate(years: number, now: Date): Date | null {
  const ms = now.getTime() + years * MS_PER_JULIAN_YEAR;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms);
}

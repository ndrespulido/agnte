import type { Clock } from '@/shared/kernel';

/**
 * A clock that does not move.
 *
 * Domain tests about ordering or expiry need time to be an input rather than an
 * ambient fact — otherwise they pass or fail depending on how fast the machine
 * is, which is the flakiness that trains people to re-run instead of read.
 */
export function fixedClock(at: Date = new Date('2026-01-01T00:00:00.000Z')): Clock {
  return { now: () => at };
}

/** A clock that advances by a fixed step on every read. */
export function tickingClock(
  start: Date = new Date('2026-01-01T00:00:00.000Z'),
  stepMs = 1000,
): Clock {
  let current = start.getTime() - stepMs;
  return {
    now: () => {
      current += stepMs;
      return new Date(current);
    },
  };
}

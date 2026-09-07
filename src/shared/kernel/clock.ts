/**
 * Time as a dependency rather than an ambient fact.
 *
 * The domain has real time-dependent rules — a verification token expires after
 * 24 hours, a reset token after one — and testing those against the wall clock
 * means either sleeping or accepting flakiness. Passing a Clock makes "it is
 * now 25 hours later" an ordinary test setup.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock stopped at an instant. */
export function fixedClock(at: Date): Clock {
  return { now: () => new Date(at.getTime()) };
}

/**
 * A clock that can be moved, for tests that need time to pass between steps
 * rather than merely to be a specific value.
 */
export function mutableClock(
  start: Date,
): Clock & { advance(ms: number): void; set(at: Date): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
    set: (at: Date) => {
      current = at.getTime();
    },
  };
}

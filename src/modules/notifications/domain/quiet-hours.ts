import { DomainError, type Result, err, ok } from '@/shared/kernel';

/**
 * The window in which this person is asleep.
 *
 * architecture.md §8.4 asks for this by name — "never dispatch a medication
 * reminder at 03:00 because of a timezone bug" — and the interesting word in
 * that sentence is *timezone*. Everything else in this system stores instants
 * in UTC and is right to; quiet hours are the one thing that cannot, because
 * "23:00" means a different instant in Barcelona in January than in July, and a
 * reminder deferred to "08:00 UTC" would arrive at 09:00 for half the year and
 * 10:00 for the other half.
 *
 * So the window is stored as local wall-clock minutes plus an IANA zone, and
 * resolved against a real instant at dispatch time using the platform's own
 * timezone database. No offset is ever stored: an offset is a fact about a
 * moment, not about a person, and storing one bakes in whichever side of a DST
 * boundary happened to be true when they set it.
 */

export interface QuietHours {
  /** Minutes from local midnight, 0–1439. */
  readonly startMinute: number;
  readonly endMinute: number;
  /** IANA zone, e.g. "Europe/Madrid". */
  readonly timeZone: string;
}

export const MINUTES_IN_DAY = 24 * 60;

export const invalidQuietHours = (detail: string): DomainError =>
  new DomainError('notifications.invalid_quiet_hours', detail);

/** Is this a zone the runtime actually knows? */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function parseQuietHours(input: {
  startMinute: number;
  endMinute: number;
  timeZone: string;
}): Result<QuietHours, DomainError> {
  for (const [name, value] of [
    ['startMinute', input.startMinute],
    ['endMinute', input.endMinute],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value >= MINUTES_IN_DAY) {
      return err(invalidQuietHours(`${name} must be a whole number of minutes, 0–1439.`));
    }
  }

  // Equal bounds would be an empty window or a whole day depending on which
  // way you read it, and a reminder system cannot have that ambiguity: one
  // reading silences everything forever.
  if (input.startMinute === input.endMinute) {
    return err(invalidQuietHours('Quiet hours cannot start and end at the same minute.'));
  }

  if (!isValidTimeZone(input.timeZone)) {
    return err(invalidQuietHours(`"${input.timeZone}" is not a known time zone.`));
  }

  return ok({
    startMinute: input.startMinute,
    endMinute: input.endMinute,
    timeZone: input.timeZone,
  });
}

/**
 * What time it is, locally, at a given instant.
 *
 * Uses `Intl` rather than arithmetic on an offset, because the runtime's
 * timezone database is the only thing that knows when a given zone last changed
 * its rules, and hand-rolled offset maths is how the 03:00 bug happens.
 */
export function localMinuteOf(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');

  // 24:00 rather than 00:00 is a legal `hourCycle: h23` rendering of midnight
  // in some locales; normalised so midnight is always 0.
  return (hour % 24) * 60 + minute;
}

/**
 * Is this instant inside the person's quiet hours?
 *
 * Handles the ordinary case (22:00–07:00, which wraps past midnight) and the
 * unusual one (01:00–05:00, which does not) with the same comparison, because
 * the wrapping case is the *common* one for sleep and getting it backwards
 * would silence the whole day instead of the night.
 */
export function isQuiet(quiet: QuietHours, at: Date): boolean {
  const minute = localMinuteOf(at, quiet.timeZone);

  return quiet.startMinute < quiet.endMinute
    ? minute >= quiet.startMinute && minute < quiet.endMinute
    : minute >= quiet.startMinute || minute < quiet.endMinute;
}

/**
 * The first instant at or after `at` that is outside quiet hours.
 *
 * Deferral rather than cancellation: a reminder that fell in the night is still
 * wanted in the morning — the whole point of the feature is that it arrives
 * when it can be acted on, not that it is dropped.
 *
 * Searches minute by minute from the end of the window rather than computing an
 * offset, for the same reason `localMinuteOf` uses `Intl`: the end of quiet
 * hours may itself be shifted by a DST transition that night, and the only
 * reliable test for "is this instant still quiet" is to ask.
 */
export function nextAudibleAfter(quiet: QuietHours, at: Date): Date {
  if (!isQuiet(quiet, at)) return at;

  // Minute resolution is enough — the tick runs every five (§8.4) — and this
  // walks at most a day, which bounds it regardless of what the zone does.
  const step = 60_000;
  let candidate = new Date(Math.ceil(at.getTime() / step) * step);

  for (let i = 0; i <= MINUTES_IN_DAY; i += 1) {
    if (!isQuiet(quiet, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + step);
  }

  /*
   * Unreachable while `parseQuietHours` refuses an empty window, and left as a
   * value rather than a throw anyway: the caller is a dispatcher holding a
   * reminder, and the safe failure for it is "send it now" rather than an
   * exception that strands the row. A window that silenced a full day would
   * be a bug in validation, not a reason to lose someone's medication alert.
   */
  return at;
}

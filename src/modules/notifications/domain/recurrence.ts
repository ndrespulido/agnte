import { DomainError, type Result, err, ok } from '@/shared/kernel';

/**
 * When a reminder repeats.
 *
 * Stored as an RRULE string (architecture.md §8.4) and parsed here into a shape
 * this module can compute with. Deliberately a *subset* of RFC 5545 rather than
 * the whole thing, and deliberately hand-written rather than a dependency:
 *
 * - The full spec covers BYSETPOS, BYYEARDAY, WKST, EXDATE and a dozen other
 *   fields that a personal reminder ("every Tuesday", "every 3 months") will
 *   never use. Carrying a library for a tenth of a specification is weight, and
 *   §9's test pyramid already lists recurrence as a pure domain unit — "no I/O,
 *   milliseconds" — which is only true if it is ours.
 * - What is *not* supported is rejected loudly at parse time rather than
 *   silently ignored. A rule that quietly drops BYDAY would fire a weekly
 *   reminder on the wrong day forever, which is exactly the class of bug a
 *   medication reminder cannot have.
 *
 * The stored form stays a real RRULE string so that widening this later, or
 * swapping in a full implementation, is a parser change and not a migration.
 */

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/** RFC 5545 weekday codes, Sunday-first to match `Date.getUTCDay()`. */
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface Recurrence {
  readonly freq: Frequency;
  /** Every N periods. At least 1; RFC's default. */
  readonly interval: number;
  /** WEEKLY only: which days. Empty means "the weekday of the start date". */
  readonly byDay: readonly Weekday[];
  /** Stop repeating after this instant, inclusive. Null means forever. */
  readonly until: Date | null;
  /** Stop after this many occurrences. Null means no limit. */
  readonly count: number | null;
}

const FREQUENCIES: readonly Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** A cap on how far `nextOccurrence` will search before giving up. */
const MAX_SEARCH_STEPS = 400;

export const invalidRecurrence = (detail: string): DomainError =>
  new DomainError('notifications.invalid_recurrence', detail);

/**
 * Parses the supported subset of an RRULE string.
 *
 * Accepts the `RRULE:` prefix or a bare rule, because both appear in the wild
 * and rejecting one would be a papercut with no safety value.
 */
export function parseRecurrence(input: string): Result<Recurrence, DomainError> {
  const body = input.trim().replace(/^RRULE:/i, '');
  if (body === '') return err(invalidRecurrence('The recurrence rule is empty.'));

  const parts = new Map<string, string>();
  for (const piece of body.split(';')) {
    if (piece === '') continue;
    const at = piece.indexOf('=');
    if (at <= 0) return err(invalidRecurrence(`Not a NAME=VALUE pair: "${piece}".`));
    parts.set(piece.slice(0, at).toUpperCase(), piece.slice(at + 1));
  }

  const freq = parts.get('FREQ')?.toUpperCase();
  if (!freq) return err(invalidRecurrence('FREQ is required.'));
  if (!FREQUENCIES.includes(freq as Frequency)) {
    return err(
      invalidRecurrence(
        `FREQ=${freq} is not supported. Supported: ${FREQUENCIES.join(', ')}.`,
      ),
    );
  }

  // Refused rather than ignored: silently dropping a field a rule depends on
  // means firing at the wrong time forever, and nothing about the reminder
  // would look wrong until someone missed a dose.
  const unsupported = [...parts.keys()].filter(
    (key) => !['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT'].includes(key),
  );
  if (unsupported.length > 0) {
    return err(
      invalidRecurrence(
        `Not supported yet: ${unsupported.join(', ')}. Supported: FREQ, INTERVAL, BYDAY, UNTIL, COUNT.`,
      ),
    );
  }

  const rawInterval = parts.get('INTERVAL');
  const interval = rawInterval === undefined ? 1 : Number(rawInterval);
  if (!Number.isInteger(interval) || interval < 1) {
    return err(invalidRecurrence(`INTERVAL must be a positive whole number.`));
  }

  let byDay: Weekday[] = [];
  const rawByDay = parts.get('BYDAY');
  if (rawByDay !== undefined) {
    if (freq !== 'WEEKLY') {
      return err(invalidRecurrence('BYDAY is only supported with FREQ=WEEKLY.'));
    }
    const codes = rawByDay.split(',').map((code) => code.trim().toUpperCase());
    for (const code of codes) {
      if (!WEEKDAYS.includes(code as Weekday)) {
        return err(invalidRecurrence(`"${code}" is not a weekday.`));
      }
    }
    byDay = codes as Weekday[];
  }

  let until: Date | null = null;
  const rawUntil = parts.get('UNTIL');
  if (rawUntil !== undefined) {
    until = parseUntil(rawUntil);
    if (!until) return err(invalidRecurrence(`UNTIL is not a valid UTC timestamp.`));
  }

  const rawCount = parts.get('COUNT');
  let count: number | null = null;
  if (rawCount !== undefined) {
    count = Number(rawCount);
    if (!Number.isInteger(count) || count < 1) {
      return err(invalidRecurrence('COUNT must be a positive whole number.'));
    }
  }

  if (until && count !== null) {
    return err(invalidRecurrence('UNTIL and COUNT cannot both be set.'));
  }

  return ok({ freq: freq as Frequency, interval, byDay, until, count });
}

/** `19970902T090000Z`, the only form RFC 5545 allows for a UTC UNTIL. */
function parseUntil(raw: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Back to the stored form, so a round-trip through the domain is lossless. */
export function formatRecurrence(rule: Recurrence): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length > 0) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.until) {
    parts.push(
      `UNTIL=${rule.until
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '')}`,
    );
  }
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  return parts.join(';');
}

/**
 * The next time this rule fires strictly after `after`.
 *
 * Computed on dispatch rather than by materialising a year of rows (§8.4): a
 * reminder that repeats forever has no end to materialise, and a rule someone
 * edits would leave a tail of stale rows behind it.
 *
 * `start` is the first occurrence — the anchor the rule counts from, which is
 * what makes "every 3 months" mean "every 3 months *from then*" rather than
 * from an arbitrary epoch. `occurrencesSoFar` is how many have already fired,
 * which is the only way COUNT can be honoured without replaying history.
 *
 * Returns null when the rule has run out: past UNTIL, or COUNT exhausted.
 */
export function nextOccurrence(
  rule: Recurrence,
  start: Date,
  after: Date,
  occurrencesSoFar: number,
): Date | null {
  if (rule.count !== null && occurrencesSoFar >= rule.count) return null;

  /*
   * Each occurrence is computed from the *anchor*, not from the one before it.
   *
   * Stepping from the previous occurrence loses the anchor the moment a month
   * is clamped: 31 January steps to 28 February correctly, and then the next
   * step advances from the 28th and gives 28 March instead of the 31st. The
   * reminder walks backwards through the calendar a few days a year and
   * nothing looks wrong until it has drifted a week. Found by a test that
   * checked the *second* step rather than the first.
   */
  let n = 0;
  let candidate = start;

  while (candidate <= after) {
    n += 1;
    if (n > MAX_SEARCH_STEPS) return null;
    candidate = occurrenceAt(rule, start, n);
  }

  if (rule.until && candidate > rule.until) return null;
  return candidate;
}

/**
 * The nth occurrence after the anchor, counted from the anchor every time.
 *
 * `n` is 0 for the anchor itself, so this is a pure function of the rule and
 * the index — which is what keeps a clamped month from contaminating the ones
 * that follow it.
 */
function occurrenceAt(rule: Recurrence, start: Date, n: number): Date {
  switch (rule.freq) {
    case 'DAILY':
      return addDays(start, n * rule.interval);

    case 'MONTHLY':
      return addMonths(start, n * rule.interval);

    case 'YEARLY':
      return addMonths(start, 12 * n * rule.interval);

    case 'WEEKLY': {
      if (rule.byDay.length === 0) return addDays(start, 7 * n * rule.interval);

      // Sorted so a week is walked in order, deduplicated because BYDAY=MO,MO
      // is legal input and would otherwise make every week a day short.
      const wanted = [...new Set(rule.byDay)]
        .map((day) => WEEKDAYS.indexOf(day))
        .sort((a, b) => a - b);

      const startDay = start.getUTCDay();

      // The anchor's own week is partial: only the wanted days still ahead of
      // the anchor belong to it.
      const restOfFirstWeek = wanted.filter((day) => day > startDay);
      if (n <= restOfFirstWeek.length) {
        return addDays(start, (restOfFirstWeek[n - 1] ?? startDay) - startDay);
      }

      // Everything after that falls in whole weeks, INTERVAL apart.
      const remaining = n - restOfFirstWeek.length;
      const perWeek = wanted.length;
      const weeksOn = Math.ceil(remaining / perWeek);
      const dayOfWeek = wanted[(remaining - 1) % perWeek] ?? startDay;

      return addDays(start, -startDay + 7 * rule.interval * weeksOn + dayOfWeek);
    }
  }
}

const addDays = (from: Date, days: number): Date =>
  new Date(from.getTime() + days * 86_400_000);

/**
 * Adds months, clamping to the end of a shorter month.
 *
 * 31 January plus one month is 28 February, not 3 March. JavaScript's `Date`
 * rolls over by default, which would silently walk a monthly reminder forward
 * through the calendar — the 31st becomes the 3rd becomes the 6th.
 */
function addMonths(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const day = from.getUTCDate();

  const lastOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, lastOfTarget),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

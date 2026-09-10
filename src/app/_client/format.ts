/**
 * How a moment in time is written on the timeline.
 *
 * Pure functions with time passed in, never read from the clock here: a
 * "Today" that depends on when the test runs is a test that fails at midnight.
 */

/**
 * A verse sits either on the calendar or in deep time, never both, so the
 * label it needs is one of two quite different things: a date, or a distance.
 */
export type Placement =
  { kind: 'date'; at: Date } | { kind: 'deep-time'; years: number } | { kind: 'undated' };

export function placementOf(verse: {
  eventStart: string | null;
  deepTimeYears: number | null;
  createdAt: string;
}): Placement {
  if (verse.deepTimeYears !== null) {
    return { kind: 'deep-time', years: verse.deepTimeYears };
  }
  if (verse.eventStart !== null) return { kind: 'date', at: new Date(verse.eventStart) };
  return { kind: 'undated' };
}

/**
 * The key a verse is grouped under.
 *
 * Deep-time entries are bucketed by magnitude rather than by year: "66,000,000
 * years ago" and "66,000,001 years ago" are the same moment to anyone reading,
 * and one section per year would produce a scroll of empty headings.
 */
export function sectionKey(placement: Placement): string {
  switch (placement.kind) {
    case 'date': {
      const at = placement.at;
      const month = String(at.getUTCMonth() + 1).padStart(2, '0');
      const day = String(at.getUTCDate()).padStart(2, '0');
      return `${at.getUTCFullYear()}-${month}-${day}`;
    }
    case 'deep-time':
      return `deep:${magnitude(placement.years)}`;
    case 'undated':
      return 'undated';
  }
}

/** The power of ten a deep-time value belongs to, floored. */
const magnitude = (years: number): number => {
  const absolute = Math.abs(years);
  return absolute < 1 ? 0 : Math.floor(Math.log10(absolute));
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * The header line: what a paper planner's tab would say.
 *
 * "Today" and "Tomorrow" earn their place — a timeline centred on today is
 * mostly read near today, and a date the reader has to compute against the
 * calendar is a date they read twice.
 */
export function headerLabel(placement: Placement, now: Date): string {
  switch (placement.kind) {
    case 'undated':
      return 'No date';
    case 'deep-time':
      return deepTimeLabel(placement.years);
    case 'date': {
      const days = calendarDaysBetween(now, placement.at);
      if (days === 0) return 'Today';
      if (days === 1) return 'Tomorrow';
      if (days === -1) return 'Yesterday';

      const at = placement.at;
      const sameYear = at.getUTCFullYear() === now.getUTCFullYear();
      const base = `${DAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
      return sameYear ? base : `${base} ${at.getUTCFullYear()}`;
    }
  }
}

/** Whole calendar days between two instants, in UTC. */
function calendarDaysBetween(from: Date, to: Date): number {
  const startOf = (d: Date) =>
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.round((startOf(to) - startOf(from)) / 86_400_000);
}

/**
 * "66 million years ago", not "-66000000".
 *
 * Deep time is the one place this app shows numbers nobody can read at a
 * glance, so it does the reading for them. Significant figures rather than
 * fixed decimals: -13.8e9 is three significant figures of genuine knowledge,
 * and printing 13,800,000,000 implies ten.
 */
export function deepTimeLabel(years: number): string {
  const ago = years < 0;
  const magnitudeOf = Math.abs(years);

  const scaled = (() => {
    if (magnitudeOf >= 1e9) return `${round(magnitudeOf / 1e9)} billion years`;
    if (magnitudeOf >= 1e6) return `${round(magnitudeOf / 1e6)} million years`;
    if (magnitudeOf >= 1e3) return `${round(magnitudeOf / 1e3)} thousand years`;
    if (magnitudeOf >= 1) return `${Math.round(magnitudeOf)} years`;
    return 'less than a year';
  })();

  return ago ? `${scaled} ago` : `in ${scaled}`;
}

/** One decimal place, but no trailing ".0" — "4.5 billion", "1 billion". */
const round = (value: number): string => {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
};

/**
 * An ISO instant as an `<input type="datetime-local">` value, and back.
 *
 * Both halves work in UTC, deliberately, because everything else on this
 * screen does: `headerLabel`, `sectionKey` and `timeLabel` all read UTC parts.
 * Converting to the browser's local zone here and not there would mean a verse
 * entered at 14:00 filing itself under a different hour — or, across midnight,
 * a different day — than the one just typed.
 *
 * The honest cost is that "14:00" means 14:00 UTC, not 14:00 where the person
 * is standing. That is a real bug for a journal, but it is the *display*
 * layer's bug and it already exists: the timeline has always rendered UTC.
 * Fixing it means changing both together, which is not this change.
 */
export function toDateTimeInput(iso: string | null): string {
  if (iso === null) return '';

  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`
  );
}

/** Empty means "no date", which the API takes as an explicit null. */
export function fromDateTimeInput(value: string): string | null {
  if (value.trim() === '') return null;

  // `Z` rather than letting Date parse it as local: a bare "YYYY-MM-DDTHH:mm"
  // is interpreted in the browser's zone, which is the shift this whole pair
  // exists to avoid.
  const at = new Date(`${value}:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** The small line under a header: the time of day, when there is one. */
export function timeLabel(placement: Placement): string | null {
  if (placement.kind !== 'date') return null;

  const at = placement.at;
  if (at.getUTCHours() === 0 && at.getUTCMinutes() === 0) return null;

  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
}

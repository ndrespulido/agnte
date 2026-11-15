import type { Strings } from './i18n';
import { yearsFromEpoch } from './timeline';

/**
 * How a moment in time is written on the timeline.
 *
 * Pure functions with time passed in, never read from the clock here: a
 * "Today" that depends on when the test runs is a test that fails at midnight.
 *
 * The **language is passed in for the same reason**. Every function that
 * produces words takes the string table rather than reaching for a hook or a
 * module-level "current locale": a formatter that reads ambient state is one
 * that renders differently depending on when it is called, which is exactly
 * the property the clock rule above exists to prevent. It also keeps these
 * testable in every language without mounting anything.
 */

/**
 * A verse sits either on the calendar or in deep time, never both, so the
 * label it needs is one of two quite different things: a date, or a distance.
 */
export type Placement =
  | { kind: 'date'; at: Date; precision: EventPrecision }
  | { kind: 'deep-time'; years: number }
  | { kind: 'undated' };

/**
 * Whether a verse's date is a calendar day or a real moment (architecture.md
 * §2.1). The same two values the server stores; a copy for the reason given on
 * `timelinePosition` below.
 */
export type EventPrecision = 'date' | 'minute';

/** What the functions here need of a verse to place it. */
export interface Placeable {
  eventStart: string | null;
  /** Absent on rows cached or queued before the field existed; see `placementOf`. */
  eventPrecision?: EventPrecision | null;
  deepTimeYears: number | null;
  createdAt: string;
}

const isUtcMidnight = (at: Date): boolean =>
  at.getUTCHours() === 0 &&
  at.getUTCMinutes() === 0 &&
  at.getUTCSeconds() === 0 &&
  at.getUTCMilliseconds() === 0;

export function placementOf(verse: Placeable): Placement {
  if (verse.deepTimeYears !== null) {
    return { kind: 'deep-time', years: verse.deepTimeYears };
  }
  if (verse.eventStart === null) return { kind: 'undated' };

  const at = new Date(verse.eventStart);
  /*
   * Inferred when absent, by the server's own rule: midnight UTC is a day,
   * anything else is a moment. A page cached by the service worker last month
   * and a write still sitting in the offline queue both predate the field, and
   * both must keep meaning what they meant.
   */
  const precision = verse.eventPrecision ?? (isUtcMidnight(at) ? 'date' : 'minute');
  return { kind: 'date', at, precision };
}

/**
 * The calendar day and clock time a placement reads as — **to this reader**.
 *
 * The one place the two kinds of date are told apart, and the fix for a bug
 * this file carried from the start: everything used to be read with UTC parts.
 *
 * - A **day** ("1 March") has no zone. It is stored as midnight UTC and read
 *   back with UTC parts, so it is 1 March in Madrid, in Recife and in Tokyo.
 *   Converting it would hand a reader west of Greenwich the day before.
 * - A **moment** happened once and is read in the reader's own zone. A
 *   reminder set for 17:00 in Madrid used to show as 15:00 on the timeline —
 *   the same verse, two times, in one app.
 */
interface CalendarParts {
  year: number;
  /** 0-based, as `Date` has it. */
  month: number;
  date: number;
  /** Sunday is 0. */
  weekday: number;
  hours: number;
  minutes: number;
}

function partsOf(placement: Extract<Placement, { kind: 'date' }>): CalendarParts {
  const at = placement.at;
  if (placement.precision === 'date') {
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth(),
      date: at.getUTCDate(),
      weekday: at.getUTCDay(),
      hours: 0,
      minutes: 0,
    };
  }
  return {
    year: at.getFullYear(),
    month: at.getMonth(),
    date: at.getDate(),
    weekday: at.getDay(),
    hours: at.getHours(),
    minutes: at.getMinutes(),
  };
}

/**
 * Where a verse sits on the timeline, in years from 2000 — the same number the
 * server stores as `timeline_years`, with one deliberate difference for a day
 * (below).
 */
export function timelinePosition(verse: Placeable): number {
  if (verse.deepTimeYears !== null) return verse.deepTimeYears;

  const placement = placementOf(verse);
  if (placement.kind === 'date' && placement.precision === 'date') {
    /*
     * A day sorts at the start of that day **where the reader is**.
     *
     * This is the one place the client deliberately disagrees with the
     * server's `timeline_years`, which has to use the stored instant because
     * it cannot know the reader's zone. Stored, "16 July" is midnight UTC —
     * and for a reader in Recife that instant is 21:00 on the 15th, so it
     * would sort into the middle of the 15th's timed verses and split that
     * day's section in two. Placing it at local midnight puts a day ahead of
     * everything timed within it, in every zone. The server's order is still
     * what pages are fetched by; this only arranges what has been loaded.
     */
    const { year, month, date } = partsOf(placement);
    return yearsFromEpoch(new Date(year, month, date));
  }

  return yearsFromEpoch(new Date(verse.eventStart ?? verse.createdAt));
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
      const parts = partsOf(placement);
      const month = String(parts.month + 1).padStart(2, '0');
      const day = String(parts.date).padStart(2, '0');
      return `${parts.year}-${month}-${day}`;
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

/**
 * The header line: what a paper planner's tab would say.
 *
 * "Today" and "Tomorrow" earn their place — a timeline centred on today is
 * mostly read near today, and a date the reader has to compute against the
 * calendar is a date they read twice.
 */
export function headerLabel(placement: Placement, now: Date, s: Strings): string {
  switch (placement.kind) {
    case 'undated':
      return s.common.noDate;
    case 'deep-time':
      return deepTimeLabel(placement.years, s);
    case 'date': {
      const parts = partsOf(placement);

      // "Today" is the reader's today. Their calendar day is compared with the
      // verse's calendar day as plain dates, so neither is shifted by a zone.
      const days = Math.round(
        (Date.UTC(parts.year, parts.month, parts.date) -
          Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) /
          86_400_000,
      );
      if (days === 0) return s.common.today;
      if (days === 1) return s.common.tomorrow;
      if (days === -1) return s.common.yesterday;

      // The table arranges the parts, rather than being handed a finished
      // string: Spanish needs "lunes, 3 de marzo" and Chinese runs
      // largest-unit-first, and neither is reachable by translating words in
      // an English order.
      const day = s.dates.days[parts.weekday] ?? '';
      const month = s.dates.months[parts.month] ?? '';

      return parts.year === now.getFullYear()
        ? s.dates.dayMonth(day, parts.date, month)
        : s.dates.dayMonthYear(day, parts.date, month, parts.year);
    }
  }
}

/**
 * A plain calendar day, always with its year: "12 Mar 2026".
 *
 * Unlike `headerLabel`, nothing here is relative to now. A dashboard's span
 * reads "5 Jan 2020 — 15 Jan 2099", and "Today" in the middle of a range would
 * be meaningless — a span needs two fixed points, not one fixed and one
 * relative. The year is always shown for the same reason: the two ends of a
 * span are frequently in different years, and dropping it from one of them
 * makes the range unreadable.
 *
 * UTC, like every other formatter here. That is a known bug in the display
 * layer rather than a choice — it predates this screen — but a dashboard that
 * disagreed with the timeline above it about which day something happened
 * would be worse than one that is consistently off.
 */
export function dayLabel(at: Date, s: Strings): string {
  return s.dates.dateMonthYear(
    at.getUTCDate(),
    s.dates.months[at.getUTCMonth()] ?? '',
    at.getUTCFullYear(),
  );
}

/**
 * "66 million years ago", not "-66000000".
 *
 * Deep time is the one place this app shows numbers nobody can read at a
 * glance, so it does the reading for them. Significant figures rather than
 * fixed decimals: -13.8e9 is three significant figures of genuine knowledge,
 * and printing 13,800,000,000 implies ten.
 */
export function deepTimeLabel(years: number, s: Strings): string {
  const ago = years < 0;
  const magnitudeOf = Math.abs(years);

  /*
   * The scale word is the table's decision, not this function's.
   *
   * Chinese groups large numbers in 万 (10^4) and 亿 (10^8) rather than
   * thousands and millions, so "1.4 billion years" is naturally 14亿年 — a
   * regrouping, not a translation. Handing over the rounded number and letting
   * each table say what it wants is what makes that expressible; a shared
   * "{n} {unit}" template would force every language into English's powers of
   * a thousand.
   */
  const scaled = (() => {
    if (magnitudeOf >= 1e9) return s.deepTime.billionYears(round(magnitudeOf / 1e9));
    if (magnitudeOf >= 1e6) return s.deepTime.millionYears(round(magnitudeOf / 1e6));
    if (magnitudeOf >= 1e3) return s.deepTime.thousandYears(round(magnitudeOf / 1e3));
    if (magnitudeOf >= 1) return s.deepTime.years(Math.round(magnitudeOf));
    return s.deepTime.lessThanAYear;
  })();

  return ago ? s.deepTime.ago(scaled) : s.deepTime.ahead(scaled);
}

/** One decimal place, but no trailing ".0" — "4.5 billion", "1 billion". */
const round = (value: number): string => {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
};

/**
 * The new-tag field, split into the names it holds.
 *
 * A comma is safe as the separator because `parseTagName` in the verse domain
 * rejects one inside a name, so no tag can ever contain the character this
 * splits on.
 *
 * Duplicates are removed here rather than left to the caller — `.a, .A` and
 * `.a, a` are the same tag, normalised the way the domain normalises
 * (leading dots stripped, lowercased), and creating it twice in one save is
 * an error the person did not make.
 */
export function splitTagNames(input: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of input.split(',')) {
    const name = part.trim();
    if (name === '') continue;

    const normalised = name.replace(/^\.+/, '').toLowerCase();
    // A field of nothing but dots and commas has no name in it.
    if (normalised === '' || seen.has(normalised)) continue;

    seen.add(normalised);
    names.push(name);
  }

  return names;
}

/**
 * A verse's date as the form shows it: a date field, and a time that may be
 * left empty.
 *
 * Two fields rather than one `datetime-local`, because that control cannot say
 * "no time" — and "no time" is most entries. The empty time *is* the precision:
 * left blank the verse is a day, filled in it is a moment.
 *
 * A day is read back with UTC parts, exactly as `partsOf` reads it, and a
 * moment in the browser's zone. These replaced a pair that round-tripped
 * everything through UTC, which showed back what was typed and stored the
 * wrong instant for it: "14:00" typed in Madrid was saved as 14:00Z.
 */
export function toDateInput(
  iso: string | null,
  precision: EventPrecision | null,
): string {
  if (iso === null) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  return precision === 'date'
    ? `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The time field for the same value: empty for a day. */
export function toTimeInput(
  iso: string | null,
  precision: EventPrecision | null,
): string {
  if (iso === null || precision !== 'minute') return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The two fields, back into what the API stores.
 *
 * No time: the day itself, as midnight UTC, which is what `'date'` precision
 * requires and what makes it the same day for every reader. With a time: that
 * wall-clock moment *where the person is*, as a real instant.
 *
 * Null for an empty or unparseable date. A time with no date is also null —
 * there is no day to put it on, and inventing today would be a guess.
 */
export function fromDateAndTime(
  date: string,
  time: string,
): { iso: string; precision: EventPrecision } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) return null;

  if (time.trim() === '') {
    const at = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(at.getTime())) return null;
    // 31 February parses — as 3 March. A date that does not come back as
    // itself was never a date.
    const iso = at.toISOString();
    return iso.startsWith(date.trim()) ? { iso, precision: 'date' } : null;
  }

  // No trailing Z: every engine reads this form as local time, which is what
  // a clock time typed by a person means.
  const at = new Date(`${date}T${time}`);
  if (Number.isNaN(at.getTime())) return null;
  if (toDateInput(at.toISOString(), 'minute') !== date.trim()) return null;
  return { iso: at.toISOString(), precision: 'minute' };
}

/** The small line under a header: the time of day, when there is one. */
export function timeLabel(placement: Placement): string | null {
  if (placement.kind !== 'date') return null;

  // A day has no time to show. This used to be guessed from the clock reading
  // midnight, which also hid any moment that genuinely was midnight.
  if (placement.precision === 'date') return null;

  const { hours, minutes } = partsOf(placement);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * An ISO instant as a `datetime-local` value, in the browser's own zone.
 *
 * The reminder form's converters. A reminder is always a moment — a promise to
 * interrupt someone at a particular time — so it has no "day only" case and
 * keeps the single combined control.
 *
 * These were once the odd ones out: the rest of this file read UTC parts, and
 * reminders could not survive that ("17:00" firing at 19:00 in Madrid in July
 * is the feature failing, not a rendering quirk). Since a verse's date learned
 * to say whether it is a day or a moment, everything that is a moment is read
 * this way, and the timeline agrees with the reminder screen about the time.
 */
export function toLocalDateTimeInput(iso: string | null): string {
  if (iso === null) return '';

  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';

  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/** Reads a `datetime-local` value as local wall-clock time. */
export function fromLocalDateTimeInput(value: string): string | null {
  if (value === '') return null;
  // `new Date("2026-09-15T17:00")` — no trailing Z — is parsed as local time by
  // every engine, which is exactly what a `datetime-local` value means.
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** A reminder's moment, in the reader's own zone: "15 September 2026, 17:00". */
export function localMomentLabel(iso: string, s: Strings): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  // Local parts, not UTC — see the note above `toLocalDateTimeInput` for why
  // reminders are the one screen that disagrees with the rest.
  const day = s.dates.dateMonthYear(
    at.getDate(),
    s.dates.months[at.getMonth()] ?? '',
    at.getFullYear(),
  );
  return `${day}, ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

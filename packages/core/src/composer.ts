import { fromDateAndTime, type EventPrecision } from './dates';
import { en, type Strings } from './i18n';

/**
 * The composer's grammar (§12.3): typed text in, a verse's fields out.
 *
 *     Trip to Recife from: 5 January 2027 to: 24/02/27 where: Recife Airport rating:5 .travel
 *
 * Three rules. `.name` is a tag. `key: value` sets a field when the key is a
 * reserved word and a property otherwise, and its value runs to the next key
 * or tag. Whatever comes before the first key is the note.
 *
 * **Deterministic, and no model reads this.** It runs on the device, offline,
 * for free, and the same text gives the same answer every time — which is what
 * makes it testable, and what makes a wrong reading something the person can
 * learn to avoid rather than something that changes under them.
 *
 * **Nothing typed is dropped.** A reserved key whose value cannot be read —
 * `rating: lots`, `from: sometime` — stays as a property under the word that
 * was typed and is listed in `unread`, so the card can say "I did not
 * understand this" beside text that is still there.
 */

export type ComposerField = 'from' | 'to' | 'when' | 'where' | 'rating' | 'visibility';
export type ComposerVisibility = 'private' | 'shared' | 'public';

export interface Composed {
  /** The free-text note, or null when nothing was left over. */
  xp: string | null;
  /** Tag names, lowercase, without the dot, in the order typed, no repeats. */
  tags: string[];
  /** Property keys are normalised the way the server stores them. */
  properties: Record<string, string>;
  eventStart: string | null;
  eventEnd: string | null;
  eventPrecision: EventPrecision | null;
  location: string | null;
  rating: number | null;
  /** Null unless a word for it was typed. Never guessed: see `readVisibility`. */
  visibility: ComposerVisibility | null;
  /** Reserved keys whose value was not understood, as typed. */
  unread: { key: string; value: string }[];
}

export interface ComposerContext {
  strings: Strings;
  /** "Today", and the year for a date typed without one. */
  now: Date;
}

const KEY_TOKEN = /^([\p{L}\p{N}][\p{L}\p{N}\p{M}-]*)[:：](.*)$/u;
const TAG_TOKEN = /^\.([a-z0-9]+(?:-[a-z0-9]+)*)$/i;
const FIELDS: ComposerField[] = ['from', 'to', 'when', 'where', 'rating', 'visibility'];

/** The server's `normalisePropertyKey`, so a key means the same on both sides. */
const normaliseKey = (raw: string): string => raw.normalize('NFC').trim().toLowerCase();

/**
 * Is this word-with-a-colon a key?
 *
 * Not when it is a time (`10:30` — a key that is only digits) and not when it
 * is a link (`https://…`, `mailto:someone`): a colon followed directly by `/`
 * is a URL scheme, never a value.
 */
function keyOf(token: string): { key: string; rest: string } | null {
  const match = KEY_TOKEN.exec(token);
  if (!match) return null;
  const [, key = '', rest = ''] = match;
  if (/^\p{N}+$/u.test(key)) return null;
  if (rest.startsWith('/')) return null;
  return { key: normaliseKey(key), rest };
}

function fieldFor(key: string, strings: Strings): ComposerField | null {
  for (const field of FIELDS) {
    // The interface language first, then English: a habit formed in one
    // language keeps working after switching (§12.3).
    if (strings.composer.keys[field].includes(key)) return field;
    if (en.composer.keys[field].includes(key)) return field;
  }
  return null;
}

export function parseComposer(text: string, context: ComposerContext): Composed {
  const tokens = text.normalize('NFC').split(/\s+/).filter(Boolean);

  const note: string[] = [];
  const tags: string[] = [];
  const pairs: { key: string; value: string[] }[] = [];
  let open: { key: string; value: string[] } | null = null;

  for (const token of tokens) {
    const tag = TAG_TOKEN.exec(token);
    // `.5` is a number, not a tag: a tag needs a letter somewhere.
    if (tag?.[1] !== undefined && /[a-z]/i.test(tag[1])) {
      const name = tag[1].toLowerCase();
      if (!tags.includes(name)) tags.push(name);
      open = null;
      continue;
    }

    const key = keyOf(token);
    if (key) {
      open = { key: key.key, value: key.rest === '' ? [] : [key.rest] };
      pairs.push(open);
      continue;
    }

    (open ? open.value : note).push(token);
  }

  const result: Composed = {
    xp: note.length > 0 ? note.join(' ') : null,
    tags,
    properties: {},
    eventStart: null,
    eventEnd: null,
    eventPrecision: null,
    location: null,
    rating: null,
    visibility: null,
    unread: [],
  };

  let start: DateValue | null = null;
  let end: DateValue | null = null;
  let endTyped = '';

  for (const pair of pairs) {
    const value = pair.value.join(' ');
    // `seat:` with nothing after it is a key somebody has not finished typing.
    if (value === '') continue;

    const keep = () => {
      result.properties[pair.key] = value;
    };
    const unread = () => {
      keep();
      result.unread.push({ key: pair.key, value });
    };

    switch (fieldFor(pair.key, context.strings)) {
      case null:
        keep();
        break;
      case 'where':
        result.location = value;
        break;
      case 'rating': {
        const rating = readRating(value);
        if (rating === null) unread();
        else result.rating = rating;
        break;
      }
      case 'visibility': {
        const visibility = readVisibility(value, context.strings);
        if (visibility === null) unread();
        else result.visibility = visibility;
        break;
      }
      case 'from':
      case 'when': {
        const date = readDate(value, context);
        if (date === null) unread();
        else start = date;
        break;
      }
      case 'to': {
        const date = readDate(value, context);
        if (date === null) unread();
        else {
          end = date;
          endTyped = value;
        }
        break;
      }
    }
  }

  /*
   * An end typed without a year belongs after its start, not in the year the
   * text happens to be typed in: "from: 20 December 2027 to: 5 January" ends
   * in 2028. Re-read against the start's year, then the next, and take the
   * first that is not before the start. A typed year reads the same every
   * time, so this cannot move a date somebody was explicit about.
   */
  if (start !== null && end !== null && end.date < start.date) {
    const startYear = Number(start.date.slice(0, 4));
    for (const year of [startYear, startYear + 1]) {
      const again = readDate(endTyped, context, year);
      if (again !== null && again.date >= start.date) {
        end = again;
        break;
      }
    }
  }

  placeDates(result, start, end);
  return result;
}

/**
 * Start, end and the one precision they share.
 *
 * A range is days or moments, never one of each (§2.1), and the start decides.
 * So a time on only one end is dropped from that end rather than refusing the
 * whole range: "from: 5 January to: 7 January 18:00" is three days. An end
 * with no start has nothing to be the end of, and becomes the start.
 */
function placeDates(
  result: Composed,
  start: DateValue | null,
  end: DateValue | null,
): void {
  const first = start ?? end;
  if (first === null) return;
  const last = start === null ? null : end;

  const timed = first.time !== null && (last === null || last.time !== null);
  const from = fromDateAndTime(first.date, timed ? (first.time ?? '') : '');
  if (from === null) return;

  result.eventStart = from.iso;
  result.eventPrecision = from.precision;
  if (last !== null) {
    result.eventEnd =
      fromDateAndTime(last.date, timed ? (last.time ?? '') : '')?.iso ?? null;
  }
}

/** `5`, `7.5`, `7,5`, `8/10`. Out of 0–10 is not a rating. */
function readRating(value: string): number | null {
  const match = /^(\d{1,2}(?:[.,]\d)?)(?:\s*\/\s*10)?$/.exec(value.trim());
  if (!match?.[1]) return null;
  const rating = Number(match[1].replace(',', '.'));
  return rating >= 0 && rating <= 10 ? rating : null;
}

/**
 * A visibility, only from a word that names one.
 *
 * **Fails closed.** Anything unrecognised is null — "nothing was said" — which
 * the server resolves to the most restrictive of the verse's tags, private by
 * default. There is no fallback to a looser setting and no nearest-match: a
 * typo in `public` must never publish, and a typo in `private` must never be
 * read as something else.
 */
function readVisibility(value: string, strings: Strings): ComposerVisibility | null {
  const word = normaliseKey(value);
  for (const visibility of ['private', 'shared', 'public'] as const) {
    if (strings.composer.visibility[visibility].includes(word)) return visibility;
    if (en.composer.visibility[visibility].includes(word)) return visibility;
  }
  return null;
}

interface DateValue {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, or null for a day. */
  time: string | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Null unless that day exists: 31 February is not rolled into March. */
function day(year: number, month: number, date: number): string | null {
  const text = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(date)}`;
  return fromDateAndTime(text, '') === null ? null : text;
}

const fullYear = (year: number): number => (year < 100 ? 2000 + year : year);

/**
 * A date as a person types one.
 *
 * In order: a trailing time is split off; then a relative word (today), an
 * ISO date, a numeric date in the language's order, a Chinese date, and a
 * date with a month name. A date with no year is this year.
 *
 * `05/01/27` cannot be told apart from its mirror image, so the language's
 * `dayFirst` decides — but when only one reading is a real date (`24/02/27`,
 * or `02/24/27`), that reading wins in every language.
 */
function readDate(
  value: string,
  context: ComposerContext,
  /** The year for a date typed without one. Never moves "today". */
  defaultYear: number = context.now.getFullYear(),
): DateValue | null {
  const { strings, now } = context;
  let text = value.trim().toLowerCase();

  let time: string | null = null;
  const clock = /(?:^|\s)(\d{1,2})[:h](\d{2})$/.exec(text);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) return null;
    time = `${pad(hours)}:${pad(minutes)}`;
    text = text.slice(0, clock.index).trim();
  }

  const date = readDay(text, strings, now, defaultYear);
  return date === null ? null : { date, time };
}

function readDay(
  text: string,
  strings: Strings,
  now: Date,
  defaultYear: number,
): string | null {
  const relative = [
    [strings.common.yesterday, -1],
    [strings.common.today, 0],
    [strings.common.tomorrow, 1],
    [en.common.yesterday, -1],
    [en.common.today, 0],
    [en.common.tomorrow, 1],
  ] as const;
  for (const [word, offset] of relative) {
    if (text === word.toLowerCase()) {
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
      return day(at.getFullYear(), at.getMonth() + 1, at.getDate());
    }
  }

  // 2027-01-05, 2027/1/5 — a four-digit year first is never ambiguous.
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (iso) return day(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 2027年1月5日, 1月5日
  const cjk = /^(?:(\d{2,4})年)?(\d{1,2})月(\d{1,2})日?$/.exec(text);
  if (cjk) {
    const year = cjk[1] === undefined ? defaultYear : fullYear(Number(cjk[1]));
    return day(year, Number(cjk[2]), Number(cjk[3]));
  }

  // 24/02/27, 5-1-2027, 5.1
  const numeric = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2}|\d{4}))?$/.exec(text);
  if (numeric) {
    const a = Number(numeric[1]);
    const b = Number(numeric[2]);
    const year = numeric[3] === undefined ? defaultYear : fullYear(Number(numeric[3]));
    const dayFirst = day(year, b, a);
    const monthFirst = day(year, a, b);
    if (dayFirst === null || monthFirst === null) return dayFirst ?? monthFirst;
    return strings.composer.dayFirst ? dayFirst : monthFirst;
  }

  return readNamedMonth(text, strings, defaultYear);
}

/** "5 January 2027", "January 5, 2027", "5 de enero de 2027", "1er mars". */
function readNamedMonth(
  text: string,
  strings: Strings,
  defaultYear: number,
): string | null {
  const words = text
    .replace(/,/g, ' ')
    .split(/\s+/)
    // The small words dates are glued together with, in the four languages.
    .filter((word) => word !== '' && !['de', 'del', 'of', 'the', 'le'].includes(word));

  let month: number | null = null;
  const numbers: number[] = [];

  for (const word of words) {
    const named = monthNamed(word, strings) ?? monthNamed(word, en);
    if (named !== null) {
      if (month !== null) return null;
      month = named;
      continue;
    }
    // 1st, 2nd, 1er, 5th
    const number = /^(\d{1,4})(?:st|nd|rd|th|er|e|º)?$/.exec(word);
    if (!number) return null;
    numbers.push(Number(number[1]));
  }

  if (month === null || numbers.length === 0 || numbers.length > 2) return null;
  const [first = 0, second] = numbers;
  if (second === undefined) return day(defaultYear, month, first);
  // Whichever of the two cannot be a day of the month is the year.
  return first > 31 ? day(first, month, second) : day(fullYear(second), month, first);
}

/** A month by its full name or its first three letters, 1–12. */
function monthNamed(word: string, strings: Strings): number | null {
  const index = strings.dates.months.findIndex((name) => {
    const full = name.toLowerCase();
    return (
      word === full ||
      (word.length >= 3 && word === full.slice(0, 3)) ||
      word === `${full.slice(0, 3)}.`
    );
  });
  return index === -1 ? null : index + 1;
}

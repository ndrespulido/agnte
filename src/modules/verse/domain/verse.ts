import {
  uuidv7,
  type Clock,
  type Result,
  type DomainError,
  err,
  ok,
} from '@/shared/kernel';
import type { Visibility } from './visibility';
import { parseDeepTimeYears } from './deep-time';
import {
  eventPrecisionInvalid,
  eventRangeInverted,
  locationInvalid,
  noTags,
  propertyKeyInvalid,
  propertyValueTooLong,
  ratingOutOfRange,
  timeConflict,
  tooManyProperties,
  xpTooLong,
} from './errors';

/**
 * The atomic unit (CLAUDE.md): a fragment of lived experience placed on the
 * timeline.
 *
 * The shape is dominated by one rule: **a Verse may be minimal.** Media, a tag
 * and a location, with nothing else, is a valid Verse — that is stated as a
 * design rule rather than an edge case, so every field below except the owner,
 * the identity fields and at least one tag is optional, and nothing in this
 * file may quietly require more.
 */
export interface Verse {
  readonly id: string;
  readonly ownerId: string;

  /**
   * When the thing happened, as opposed to when it was written down. Freely in
   * the past or the future — a booked flight is a Verse whose event has not
   * happened yet. Null for a Verse with no particular moment.
   */
  readonly eventStart: Date | null;

  /** Set only for a range; null for a moment. */
  readonly eventEnd: Date | null;

  /**
   * Whether the event fields above mean a calendar date or a real instant.
   * Null exactly when `eventStart` is null.
   *
   * **This is the distinction the app spent its first year conflating**, and it
   * is a domain concern rather than a display one. "1 March" and "15 July at
   * 17:00" are different kinds of fact: the first has no time and no zone and
   * must read as 1 March to every reader anywhere, while the second is a moment
   * that happened once and must be shown in the reader's own zone. Storing both
   * as a bare `timestamptz` and rendering it in UTC made each one wrong in a
   * different way — a typed time was stored as if the typist lived in UTC, and
   * a genuine instant (a reminder's fire time) was displayed two hours off the
   * screen that set it.
   *
   * At `'date'` precision the stored instant is **exactly midnight UTC** and
   * only its UTC date parts carry meaning; the database has a CHECK that says
   * so, and `parsePlacement` refuses anything else rather than truncating.
   */
  readonly eventPrecision: EventPrecision | null;

  /**
   * Mutually exclusive with the event fields above (see `parsePlacement`). Null
   * for anything inside calendar range, which is almost everything.
   */
  readonly deepTimeYears: number | null;

  readonly location: string | null;
  readonly rating: number | null;
  readonly xp: string | null;

  /** Schema-free key/value. Frozen so a caller cannot mutate a Verse it read. */
  readonly properties: Readonly<Record<string, string>>;

  /**
   * Null means "inherit from my tags" — the common case, and the reason this is
   * nullable rather than defaulted at write time. Resolving it eagerly would
   * freeze today's tag visibility into the row, so a tag later made private
   * would leave its Verses public.
   */
  readonly visibility: Visibility | null;

  readonly tagIds: readonly string[];

  /**
   * Ids owned by the `media` module. Held as opaque strings deliberately: a
   * shared Media *type* across the boundary would re-couple the modules
   * (CLAUDE.md), while a reference by id costs nothing to keep.
   */
  readonly mediaIds: readonly string[];

  readonly createdAt: Date;
  readonly updatedAt: Date;

  /** Optimistic concurrency (architecture.md §2). */
  readonly version: number;
}

export const MIN_RATING = 0;
export const MAX_RATING = 10;
export const MAX_XP_LENGTH = 20_000;
export const MAX_LOCATION_LENGTH = 200;
export const MAX_PROPERTIES = 50;
export const MAX_PROPERTY_KEY_LENGTH = 64;
export const MAX_PROPERTY_VALUE_LENGTH = 2_000;

/** Same shape as a tag name: lowercase, digits, inner hyphens. */
const PROPERTY_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Where a Verse sits in time.
 *
 * A discriminated union rather than three nullable fields, because "calendar or
 * deep time, never both" is then unrepresentable rather than merely checked.
 * The nullable fields on Verse are the storage shape; this is the shape callers
 * construct.
 */
/**
 * How precisely an event is placed.
 *
 * Two values, not a number of significant fields: a journal needs "a day" and
 * "a time on a day", and nothing between them has ever been asked for. If
 * month-precision is ever wanted ("sometime in March 2019"), it joins here —
 * which is the reason this is a named union rather than a boolean.
 */
export type EventPrecision = 'date' | 'minute';

export type Placement =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'moment';
      readonly at: Date;
      readonly precision: EventPrecision;
    }
  | {
      readonly kind: 'range';
      readonly start: Date;
      readonly end: Date;
      readonly precision: EventPrecision;
    }
  | { readonly kind: 'deep-time'; readonly years: number };

/** Midnight UTC, which is what `'date'` precision is required to store. */
export const isUtcMidnight = (at: Date): boolean =>
  at.getUTCHours() === 0 &&
  at.getUTCMinutes() === 0 &&
  at.getUTCSeconds() === 0 &&
  at.getUTCMilliseconds() === 0;

export function placementOf(verse: Verse): Placement {
  if (verse.deepTimeYears !== null) {
    return { kind: 'deep-time', years: verse.deepTimeYears };
  }
  if (verse.eventStart === null) return { kind: 'none' };

  // `?? 'minute'` is unreachable for a row this domain wrote — the CHECK and
  // `parsePlacement` both make precision non-null whenever a start exists — and
  // is here so a row from an older release reads as an instant rather than
  // throwing. That is the safe direction: an instant shown in the reader's zone
  // is at worst off by their offset, where a bare date treated as an instant
  // can move to a different day.
  const precision = verse.eventPrecision ?? 'minute';

  if (verse.eventEnd === null) return { kind: 'moment', at: verse.eventStart, precision };
  return { kind: 'range', start: verse.eventStart, end: verse.eventEnd, precision };
}

/**
 * Validates a placement given as loose fields, which is how it arrives from
 * the API. Returns the union so the rest of the domain never sees the invalid
 * combinations.
 */
export function parsePlacement(input: {
  eventStart?: Date | null;
  eventEnd?: Date | null;
  deepTimeYears?: number | null;
  /**
   * Absent is **inferred**, not defaulted, and only for compatibility.
   *
   * A write queued offline by an older build carries no precision, and so does
   * a row written before this field existed. Inferring midnight-UTC as a date
   * and anything else as an instant reproduces exactly what those rows meant
   * under the old rendering, which is the only reading that does not move
   * somebody's existing entries. New clients always send it.
   */
  eventPrecision?: EventPrecision | null | undefined;
}): Result<Placement, DomainError> {
  const { eventStart = null, eventEnd = null, deepTimeYears = null } = input;

  if (deepTimeYears !== null && (eventStart !== null || eventEnd !== null)) {
    return err(timeConflict());
  }

  if (deepTimeYears !== null) {
    const years = parseDeepTimeYears(deepTimeYears);
    if (!years.ok) return years;
    return ok({ kind: 'deep-time', years: years.value });
  }

  // An end with no start is not a range, it is a missing start. Treating it as
  // a moment would silently move the date the user typed into a field they did
  // not fill in.
  if (eventStart === null) {
    if (eventEnd !== null) return err(eventRangeInverted());
    return ok({ kind: 'none' });
  }

  const precision = input.eventPrecision ?? inferPrecision(eventStart, eventEnd);

  /*
   * Refused, not truncated. A caller claiming `'date'` while sending a real
   * instant has a bug, and quietly moving their timestamp to midnight would
   * hide it while silently changing what the verse says — in a zone west of
   * UTC, by a whole day.
   */
  if (precision === 'date') {
    if (!isUtcMidnight(eventStart)) {
      return err(
        eventPrecisionInvalid('a date has no time of day, so it must be midnight UTC'),
      );
    }
    if (eventEnd !== null && !isUtcMidnight(eventEnd)) {
      return err(
        eventPrecisionInvalid('the end of a date range must also be midnight UTC'),
      );
    }
  }

  if (eventEnd === null) return ok({ kind: 'moment', at: eventStart, precision });
  if (eventEnd.getTime() < eventStart.getTime()) return err(eventRangeInverted());

  return ok({ kind: 'range', start: eventStart, end: eventEnd, precision });
}

/**
 * A precision as it arrives from outside — a request body, or an export file.
 *
 * In the domain rather than at each edge because it is a domain value with two
 * legal spellings, and there are now two callers (the write path and the
 * importer) that must agree about them.
 *
 * `undefined` survives as `undefined` so `parsePlacement` can infer it for a
 * caller that predates the field. An unrecognised string is refused rather than
 * falling back: a silent fallback to `'minute'` would render somebody's bare
 * date in their own zone, which west of Greenwich moves it to the day before.
 */
export function parseEventPrecision(
  value: string | null | undefined,
): Result<EventPrecision | null | undefined, DomainError> {
  if (value === undefined) return ok(undefined);
  if (value === null) return ok(null);
  if (value === 'date' || value === 'minute') return ok(value);
  return err(eventPrecisionInvalid(`"${value}" is not a precision this app knows`));
}

/**
 * What a placement meant before precision was recorded.
 *
 * Midnight UTC is a date, anything else is an instant. That is not a guess: the
 * old client wrote a typed `datetime-local` straight through as UTC, so a
 * date-only entry landed on exactly midnight and a timed one did not. Reading
 * old rows this way is what makes the migration a no-op on screen.
 */
const inferPrecision = (start: Date, end: Date | null): EventPrecision =>
  isUtcMidnight(start) && (end === null || isUtcMidnight(end)) ? 'date' : 'minute';

const placementFields = (
  placement: Placement,
): Pick<Verse, 'eventStart' | 'eventEnd' | 'deepTimeYears' | 'eventPrecision'> => {
  switch (placement.kind) {
    case 'none':
      return {
        eventStart: null,
        eventEnd: null,
        deepTimeYears: null,
        eventPrecision: null,
      };
    case 'moment':
      return {
        eventStart: placement.at,
        eventEnd: null,
        deepTimeYears: null,
        eventPrecision: placement.precision,
      };
    case 'range':
      return {
        eventStart: placement.start,
        eventEnd: placement.end,
        deepTimeYears: null,
        eventPrecision: placement.precision,
      };
    case 'deep-time':
      return {
        eventStart: null,
        eventEnd: null,
        deepTimeYears: placement.years,
        // Deep time is its own scale and carries no time of day. Precision
        // belongs to the calendar fields, which are null here.
        eventPrecision: null,
      };
  }
};

export function parseRating(value: number): Result<number, DomainError> {
  if (!Number.isFinite(value) || value < MIN_RATING || value > MAX_RATING) {
    return err(ratingOutOfRange(MIN_RATING, MAX_RATING));
  }
  return ok(value);
}

export function parseXp(value: string): Result<string, DomainError> {
  // Counted in code points, not UTF-16 units: a note of emoji would otherwise
  // hit the limit at half the characters the user can see.
  if ([...value].length > MAX_XP_LENGTH) return err(xpTooLong(MAX_XP_LENGTH));
  return ok(value);
}

export function parseLocation(value: string): Result<string, DomainError> {
  const trimmed = value.trim();
  if (trimmed.length === 0) return err(locationInvalid('it is empty'));
  if ([...trimmed].length > MAX_LOCATION_LENGTH) {
    return err(locationInvalid(`it is longer than ${MAX_LOCATION_LENGTH} characters`));
  }
  return ok(trimmed);
}

/**
 * Validates and normalises the free-form property bag.
 *
 * Keys are normalised the same way tag names are, so `Flight Number` and
 * `flight-number` are one property. Values are kept verbatim apart from a
 * length cap — they are the user's data, and "cleaning" them would lose
 * meaning the user put there.
 */
export function parseProperties(
  input: Readonly<Record<string, unknown>>,
): Result<Record<string, string>, DomainError> {
  const entries = Object.entries(input);
  if (entries.length > MAX_PROPERTIES) return err(tooManyProperties(MAX_PROPERTIES));

  const out: Record<string, string> = {};

  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim().toLowerCase().replace(/\s+/g, '-');

    if (key.length === 0) return err(propertyKeyInvalid(rawKey, 'it is empty'));
    if (key.length > MAX_PROPERTY_KEY_LENGTH) {
      return err(
        propertyKeyInvalid(
          rawKey,
          `it is longer than ${MAX_PROPERTY_KEY_LENGTH} characters`,
        ),
      );
    }
    if (!PROPERTY_KEY.test(key)) {
      return err(propertyKeyInvalid(rawKey, 'use letters, digits and hyphens'));
    }

    // Numbers and booleans are accepted and stringified: a client sending
    // {"year": 1998} means the same thing as {"year": "1998"}, and refusing it
    // would be a distinction the user never made. Objects and arrays are not —
    // silently JSON-encoding one would produce a search-indexed blob of braces.
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue === 'object') {
      return err(propertyKeyInvalid(rawKey, 'values must be text, numbers or booleans'));
    }

    const value = String(rawValue);
    if ([...value].length > MAX_PROPERTY_VALUE_LENGTH) {
      return err(propertyValueTooLong(key, MAX_PROPERTY_VALUE_LENGTH));
    }

    out[key] = value;
  }

  return ok(out);
}

export interface NewVerse {
  ownerId: string;
  tagIds: readonly string[];
  placement?: Placement;
  location?: string | null;
  rating?: number | null;
  xp?: string | null;
  properties?: Readonly<Record<string, string>>;
  visibility?: Visibility | null;
  mediaIds?: readonly string[];
  /** Client-generated (architecture.md §2). Minted here when absent. */
  id?: string;
  clock: Clock;
}

export function createVerse(input: NewVerse): Result<Verse, DomainError> {
  if (input.tagIds.length === 0) return err(noTags());

  const now = input.clock.now();
  const placement = input.placement ?? { kind: 'none' };

  return ok({
    id: input.id ?? uuidv7(now.getTime()),
    ownerId: input.ownerId,
    ...placementFields(placement),
    location: input.location ?? null,
    rating: input.rating ?? null,
    xp: input.xp ?? null,
    properties: Object.freeze({ ...input.properties }),
    visibility: input.visibility ?? null,
    tagIds: dedupe(input.tagIds),
    mediaIds: dedupe(input.mediaIds ?? []),
    createdAt: now,
    updatedAt: now,
    version: 0,
  });
}

/**
 * Fields a caller may change. Every one is optional and `undefined` means
 * "leave alone", which is what separates it from `null` — "clear this". A
 * PATCH that could not distinguish the two would make clearing a rating
 * impossible without a second endpoint.
 */
export interface VerseChanges {
  placement?: Placement;
  location?: string | null;
  rating?: number | null;
  xp?: string | null;
  properties?: Readonly<Record<string, string>>;
  visibility?: Visibility | null;
  tagIds?: readonly string[];
  mediaIds?: readonly string[];
}

/**
 * Applies changes, bumping the version.
 *
 * Returns a new Verse rather than mutating, for the same reason identity's User
 * is readonly: a value read before the change cannot become the value after it
 * while another code path still holds it.
 */
export function applyChanges(
  verse: Verse,
  changes: VerseChanges,
  clock: Clock,
): Result<Verse, DomainError> {
  const tagIds = changes.tagIds === undefined ? verse.tagIds : dedupe(changes.tagIds);
  if (tagIds.length === 0) return err(noTags());

  const placementPart =
    changes.placement === undefined
      ? {
          eventStart: verse.eventStart,
          eventEnd: verse.eventEnd,
          deepTimeYears: verse.deepTimeYears,
        }
      : placementFields(changes.placement);

  return ok({
    ...verse,
    ...placementPart,
    location: changes.location === undefined ? verse.location : changes.location,
    rating: changes.rating === undefined ? verse.rating : changes.rating,
    xp: changes.xp === undefined ? verse.xp : changes.xp,
    properties:
      changes.properties === undefined
        ? verse.properties
        : Object.freeze({ ...changes.properties }),
    visibility: changes.visibility === undefined ? verse.visibility : changes.visibility,
    tagIds,
    mediaIds: changes.mediaIds === undefined ? verse.mediaIds : dedupe(changes.mediaIds),
    updatedAt: clock.now(),
    version: verse.version + 1,
  });
}

/**
 * Order-preserving deduplication. Tags are a set, but the order a user added
 * them in is the order they read best in, so this keeps first occurrence rather
 * than sorting.
 */
const dedupe = (values: readonly string[]): readonly string[] => [...new Set(values)];

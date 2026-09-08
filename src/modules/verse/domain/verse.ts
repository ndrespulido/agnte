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
export type Placement =
  | { readonly kind: 'none' }
  | { readonly kind: 'moment'; readonly at: Date }
  | { readonly kind: 'range'; readonly start: Date; readonly end: Date }
  | { readonly kind: 'deep-time'; readonly years: number };

export function placementOf(verse: Verse): Placement {
  if (verse.deepTimeYears !== null) {
    return { kind: 'deep-time', years: verse.deepTimeYears };
  }
  if (verse.eventStart === null) return { kind: 'none' };
  if (verse.eventEnd === null) return { kind: 'moment', at: verse.eventStart };
  return { kind: 'range', start: verse.eventStart, end: verse.eventEnd };
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

  if (eventEnd === null) return ok({ kind: 'moment', at: eventStart });
  if (eventEnd.getTime() < eventStart.getTime()) return err(eventRangeInverted());

  return ok({ kind: 'range', start: eventStart, end: eventEnd });
}

const placementFields = (
  placement: Placement,
): Pick<Verse, 'eventStart' | 'eventEnd' | 'deepTimeYears'> => {
  switch (placement.kind) {
    case 'none':
      return { eventStart: null, eventEnd: null, deepTimeYears: null };
    case 'moment':
      return { eventStart: placement.at, eventEnd: null, deepTimeYears: null };
    case 'range':
      return {
        eventStart: placement.start,
        eventEnd: placement.end,
        deepTimeYears: null,
      };
    case 'deep-time':
      return { eventStart: null, eventEnd: null, deepTimeYears: placement.years };
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

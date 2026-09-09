import { type Clock, type DomainError, type Result, err, ok } from '@/shared/kernel';
import type {
  MediaOwnership,
  ShareRepository,
  TagRepository,
  VerseRepository,
} from '../domain/ports';
import {
  applyChanges,
  createVerse,
  parseLocation,
  parsePlacement,
  parseProperties,
  parseRating,
  parseXp,
  type Placement,
  type Verse,
  type VerseChanges,
} from '../domain/verse';
import { isVisibility, type Visibility } from '../domain/visibility';
import {
  dateInvalid,
  forbidden,
  mediaNotFound,
  noTags,
  tagNotFound,
  versionConflict,
  visibilityInvalid,
} from '../domain/errors';

export interface WriteDeps {
  verses: VerseRepository;
  tags: TagRepository;
  shares: ShareRepository;
  media: MediaOwnership;
  clock: Clock;
}

/**
 * Refuses a mediaId list containing anything the owner does not hold.
 *
 * Mirrors the tag-ownership check just above each call site: a request
 * naming someone else's media must not be silently accepted onto this
 * verse, since the verse's read path (`application/read-verse.ts`) would
 * later resolve it into a real, working signed URL using this verse's own
 * owner id — the exact leak CLAUDE.md's Visibility section warns a single
 * mis-tag must not cause.
 */
async function assertOwnedMedia(
  ownerId: string,
  mediaIds: readonly string[],
  deps: Pick<WriteDeps, 'media'>,
): Promise<DomainError | null> {
  if (mediaIds.length === 0) return null;
  const owned = await deps.media.ownedMediaIds(ownerId, mediaIds);
  return owned.size === new Set(mediaIds).size ? null : mediaNotFound();
}

/**
 * The fields a write accepts, before any of them have been trusted.
 *
 * Everything is `unknown`-ish on purpose: this is the boundary where a request
 * body becomes domain values, and typing it as though it were already valid
 * would move that boundary somewhere less obvious.
 */
export interface VerseFields {
  eventStart?: string | null | undefined;
  eventEnd?: string | null | undefined;
  deepTimeYears?: number | null | undefined;
  location?: string | null | undefined;
  rating?: number | null | undefined;
  xp?: string | null | undefined;
  properties?: Record<string, unknown> | undefined;
  visibility?: string | null | undefined;
  tagIds?: readonly string[] | undefined;
  mediaIds?: readonly string[] | undefined;
}

interface Parsed {
  placement?: Placement;
  location?: string | null;
  rating?: number | null;
  xp?: string | null;
  properties?: Record<string, string>;
  visibility?: Visibility | null;
}

/**
 * Turns request fields into domain values, one at a time, stopping at the first
 * refusal.
 *
 * `undefined` and `null` stay distinct all the way through: absent means "leave
 * this alone" and null means "clear it". Collapsing them here would make
 * clearing a rating impossible, which is the sort of thing that ends up as a
 * second endpoint.
 */
function parseFields(fields: VerseFields): Result<Parsed, DomainError> {
  const parsed: Parsed = {};

  const touchesTime =
    fields.eventStart !== undefined ||
    fields.eventEnd !== undefined ||
    fields.deepTimeYears !== undefined;

  if (touchesTime) {
    const eventStart = toDate(fields.eventStart, 'eventStart');
    if (!eventStart.ok) return eventStart;

    const eventEnd = toDate(fields.eventEnd, 'eventEnd');
    if (!eventEnd.ok) return eventEnd;

    const placement = parsePlacement({
      eventStart: eventStart.value,
      eventEnd: eventEnd.value,
      deepTimeYears: fields.deepTimeYears ?? null,
    });
    if (!placement.ok) return placement;
    parsed.placement = placement.value;
  }

  if (fields.location !== undefined) {
    if (fields.location === null) parsed.location = null;
    else {
      const location = parseLocation(fields.location);
      if (!location.ok) return location;
      parsed.location = location.value;
    }
  }

  if (fields.rating !== undefined) {
    if (fields.rating === null) parsed.rating = null;
    else {
      const rating = parseRating(fields.rating);
      if (!rating.ok) return rating;
      parsed.rating = rating.value;
    }
  }

  if (fields.xp !== undefined) {
    if (fields.xp === null) parsed.xp = null;
    else {
      const xp = parseXp(fields.xp);
      if (!xp.ok) return xp;
      parsed.xp = xp.value;
    }
  }

  if (fields.properties !== undefined) {
    const properties = parseProperties(fields.properties);
    if (!properties.ok) return properties;
    parsed.properties = properties.value;
  }

  if (fields.visibility !== undefined) {
    if (fields.visibility === null) parsed.visibility = null;
    else if (!isVisibility(fields.visibility)) return err(visibilityInvalid());
    else parsed.visibility = fields.visibility;
  }

  return ok(parsed);
}

/** Dates arrive as strings; an unparseable one is refused, not silently null. */
function toDate(
  value: string | null | undefined,
  field: string,
): Result<Date | null, DomainError> {
  if (value === undefined || value === null) return ok(null);

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return err(dateInvalid(field));
  return ok(date);
}

export interface CreateVerseInput extends VerseFields {
  ownerId: string;
  tagIds: readonly string[];
  /** Client-generated UUIDv7 (architecture.md §2), when the client made one. */
  id?: string | undefined;
}

export async function createVerseFor(
  input: CreateVerseInput,
  deps: WriteDeps,
): Promise<Result<Verse, DomainError>> {
  if (input.tagIds.length === 0) return err(noTags());

  // Every tag must be one of the caller's own. `findManyByIds` is scoped to the
  // owner, so a request naming someone else's tag comes back short — and short
  // is refused rather than silently dropping the tag, which would file the
  // verse somewhere the user did not ask for.
  const owned = await deps.tags.findManyByIds(input.ownerId, input.tagIds);
  if (owned.length !== new Set(input.tagIds).size) return err(tagNotFound());

  const mediaError = await assertOwnedMedia(input.ownerId, input.mediaIds ?? [], deps);
  if (mediaError) return err(mediaError);

  const parsed = parseFields(input);
  if (!parsed.ok) return parsed;

  const verse = createVerse({
    ownerId: input.ownerId,
    tagIds: input.tagIds,
    ...(input.id === undefined ? {} : { id: input.id }),
    ...parsed.value,
    ...(input.mediaIds === undefined ? {} : { mediaIds: input.mediaIds }),
    clock: deps.clock,
  });
  if (!verse.ok) return verse;

  await deps.verses.create(verse.value);
  return ok(verse.value);
}

export interface UpdateVerseInput extends VerseFields {
  ownerId: string;
  verseId: string;
  expectedVersion: number;
}

export async function updateVerseFor(
  input: UpdateVerseInput,
  deps: WriteDeps,
): Promise<Result<Verse, DomainError>> {
  const existing = await deps.verses.findById(input.verseId);

  // "Not yours" and "not there" get the same answer, for the same reason
  // identity gives the same answer to an unknown address on sign-in: telling a
  // caller which ids exist is an enumeration leak.
  if (!existing || existing.ownerId !== input.ownerId) return err(forbidden());

  if (input.tagIds !== undefined) {
    if (input.tagIds.length === 0) return err(noTags());
    const owned = await deps.tags.findManyByIds(input.ownerId, input.tagIds);
    if (owned.length !== new Set(input.tagIds).size) return err(tagNotFound());
  }

  if (input.mediaIds !== undefined) {
    const mediaError = await assertOwnedMedia(input.ownerId, input.mediaIds, deps);
    if (mediaError) return err(mediaError);
  }

  const parsed = parseFields(input);
  if (!parsed.ok) return parsed;

  const changes: VerseChanges = {
    ...parsed.value,
    ...(input.tagIds === undefined ? {} : { tagIds: input.tagIds }),
    ...(input.mediaIds === undefined ? {} : { mediaIds: input.mediaIds }),
  };

  const next = applyChanges(existing, changes, deps.clock);
  if (!next.ok) return next;

  const applied = await deps.verses.update(next.value, input.expectedVersion);
  if (!applied) {
    const current = await deps.verses.findById(input.verseId);
    return err(versionConflict(input.expectedVersion, current?.version ?? -1));
  }

  return ok(next.value);
}

export async function deleteVerseFor(
  input: { ownerId: string; verseId: string; expectedVersion: number },
  deps: Pick<WriteDeps, 'verses'>,
): Promise<Result<null, DomainError>> {
  const existing = await deps.verses.findById(input.verseId);
  if (!existing || existing.ownerId !== input.ownerId) return err(forbidden());

  const deleted = await deps.verses.delete(input.verseId, input.expectedVersion);
  if (!deleted) {
    const current = await deps.verses.findById(input.verseId);
    return err(versionConflict(input.expectedVersion, current?.version ?? -1));
  }

  return ok(null);
}

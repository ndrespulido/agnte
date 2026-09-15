import {
  DomainError,
  type Clock,
  type Result,
  derivedUuidv7,
  err,
  isUuid,
  ok,
  uuidv7,
} from '@/shared/kernel';
import { createVerse, parsePlacement, parseProperties } from '../domain/verse';
import { isVisibility, type Visibility } from '../domain/visibility';
import { parseTagName } from '../domain/tag';
import type { TagRepository, VerseRepository } from '../domain/ports';
import { PrismaTagRepository } from '../infrastructure/prisma-tag-repository';
import { PrismaVerseRepository } from '../infrastructure/prisma-verse-repository';

/**
 * Writes an exported document's verses and tags back into this module.
 *
 * Every row goes through the domain's own constructors — `parseTagName`,
 * `parsePlacement`, `parseProperties`, `createVerse` — rather than being
 * inserted directly. That is the whole design of this file, and the reason is
 * that an import is the one write path where the data did not come from the
 * app: it came from a file, possibly hand-edited, possibly converted from v1 by
 * a script nobody has reviewed. Bypassing the domain to "just insert what is
 * there" would mean the one entry point carrying the least trustworthy data is
 * also the only one exempt from the rules.
 *
 * Visibility in particular. `visibility` in an exported verse is the *explicit*
 * setting, which may be null — and a null explicit setting resolves through the
 * tags, most restrictive wins (§2). Anything the file offers that is not a
 * known visibility is refused rather than defaulted, because the two plausible
 * defaults are "private" (silently changing what someone exported) and
 * "inherit" (silently widening it), and the second is a disclosure.
 */

export interface ImportedTag {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly display_name?: unknown;
  readonly visibility?: unknown;
  readonly shortcut?: unknown;
}

export interface ImportedVerse {
  readonly id?: unknown;
  readonly event_start?: unknown;
  readonly event_end?: unknown;
  readonly deep_time_years?: unknown;
  readonly location?: unknown;
  readonly rating?: unknown;
  readonly xp?: unknown;
  readonly properties?: unknown;
  readonly visibility?: unknown;
  readonly tag_ids?: unknown;
}

export interface ImportSummary {
  readonly tags: number;
  readonly verses: number;
  /** Rows already present, matched by id. Re-running an import is a no-op. */
  readonly skipped: number;
  /** Rows the domain refused, with the reason. Never silently dropped. */
  readonly rejected: { readonly what: string; readonly why: string }[];
}

/**
 * The most rows one request will take.
 *
 * Cloud Run kills a container when the response returns and has a finite
 * request deadline (§1.3), so an import large enough to outlive it would be
 * cut off partway with no way to say how far it got. Refusing up front says
 * that plainly instead. Splitting is safe precisely because a re-run is a
 * no-op: pieces may overlap without duplicating anything.
 */
export const MAX_ROWS = 1000;

export interface ImportDeps {
  readonly verses: VerseRepository;
  readonly tags: TagRepository;
  readonly clock: Clock;
}

const badDocument = (detail: string) => new DomainError('verse.invalid_import', detail);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null;

const asDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

/**
 * The id a row from the file takes in this account.
 *
 * Three cases, and the middle one is the whole reason this function exists:
 *
 *   - no id in the file      → a fresh one; nothing to be idempotent about
 *   - an id nobody holds     → itself, so a re-import recognises the row
 *   - an id somebody holds   → derived from the owner and that id
 *
 * The third case is what makes an export portable between accounts. Honouring
 * the file's id there would either fail on the primary key or, worse, be a way
 * for a hand-written document to aim at a row it does not own. Minting a random
 * one instead would work once and duplicate on every run after. Deriving it is
 * neither: stable across runs, and never anyone else's.
 *
 * Ids that are not UUIDs at all are not refused — v1's ids were not UUIDs, and
 * a converter that had to renumber them would lose the very thing that makes a
 * second run safe. They go straight to the derived case.
 */
async function localIdFor(
  ownerId: string,
  sourceId: string | null,
  holderOf: (id: string) => Promise<{ ownerId: string } | null>,
): Promise<{ id: string; existing: { ownerId: string } | null }> {
  if (!sourceId) return { id: uuidv7(), existing: null };

  if (!isUuid(sourceId)) {
    const id = derivedUuidv7(ownerId, sourceId);
    return { id, existing: await holderOf(id) };
  }

  const holder = await holderOf(sourceId);
  if (!holder) return { id: sourceId, existing: null };
  if (holder.ownerId === ownerId) return { id: sourceId, existing: holder };

  const id = derivedUuidv7(ownerId, sourceId);
  return { id, existing: await holderOf(id) };
}

function readVisibility(value: unknown): Result<Visibility | null, DomainError> {
  // Absent and null both mean "inherit from the tags", which is a legitimate
  // stored state rather than missing data.
  if (value === null || value === undefined) return ok(null);
  if (typeof value === 'string' && isVisibility(value)) return ok(value);
  return err(
    badDocument(
      `"${String(value)}" is not a visibility. Refusing rather than guessing: ` +
        'the plausible defaults either change what was exported or widen it.',
    ),
  );
}

/**
 * Imports tags first, then verses.
 *
 * The order is forced: a verse needs at least one tag to exist (`noTags`), and
 * the tag ids in a verse row point at tags in the same document. Importing them
 * together would mean either two passes anyway or a verse referring to a tag
 * that has not been written.
 *
 * Ids are kept when they are free. That is what makes the import idempotent —
 * a second run finds the rows and skips them — and it is only possible because
 * ids are client-generated UUIDv7 rather than sequence values (§2).
 *
 * An id already held by someone else is a claim the file does not get to make;
 * the row is written under a *derived* id instead (`derivedUuidv7`), which is
 * what lets a friend's export be imported without either duplicating on a
 * second run or reaching into their rows. See `localIdFor`.
 */
export async function importVerses(
  ownerId: string,
  document: { tags?: unknown; verses?: unknown },
  deps: ImportDeps,
): Promise<Result<ImportSummary, DomainError>> {
  const tagRows = Array.isArray(document.tags) ? (document.tags as ImportedTag[]) : [];
  const verseRows = Array.isArray(document.verses)
    ? (document.verses as ImportedVerse[])
    : [];

  if (tagRows.length === 0 && verseRows.length === 0) {
    return err(badDocument('That document has no tags and no verses in it.'));
  }

  if (tagRows.length > MAX_ROWS || verseRows.length > MAX_ROWS) {
    return err(
      badDocument(
        `That document is too large to import in one request (limit ${MAX_ROWS} ` +
          `tags and ${MAX_ROWS} verses). Split it and run the pieces in order — ` +
          'tags before the verses that carry them. Re-running a piece is a no-op, ' +
          'so overlapping splits are safe.',
      ),
    );
  }

  const rejected: { what: string; why: string }[] = [];
  let skipped = 0;
  let tagCount = 0;
  let verseCount = 0;

  /** Ids in the file mapped to ids in this database. */
  const tagIdMap = new Map<string, string>();

  for (const row of tagRows) {
    const rawName = asString(row.name);
    if (!rawName) {
      rejected.push({ what: 'tag', why: 'A tag with no name.' });
      continue;
    }

    const name = parseTagName(rawName);
    if (!name.ok) {
      rejected.push({ what: `tag "${rawName}"`, why: name.error.message });
      continue;
    }

    const visibility = readVisibility(row.visibility);
    if (!visibility.ok) {
      rejected.push({ what: `tag "${rawName}"`, why: visibility.error.message });
      continue;
    }

    // Matched by name, not id: a person importing into an account that already
    // has `.barcelona` wants their verses filed under the tag they are looking
    // at, not a second one with the same name and a different id. Name is the
    // natural key here — unique per owner — so this is the check that makes a
    // second run of the same file a no-op.
    const sourceId = asString(row.id);
    const existing = await deps.tags.findByName(ownerId, name.value);

    if (existing) {
      if (sourceId) tagIdMap.set(sourceId, existing.id);
      skipped += 1;
      continue;
    }

    const local = await localIdFor(ownerId, sourceId, (candidate) =>
      deps.tags.findById(candidate),
    );

    const now = deps.clock.now();
    const tag = {
      id: local.id,
      ownerId,
      name: name.value,
      displayName: asString(row.display_name),
      visibility: visibility.value ?? 'private',
      shortcut: asString(row.shortcut),
      vertical: null,
      createdAt: now,
      updatedAt: now,
      version: 0,
    };

    const outcome = await deps.tags.create(tag);
    if (outcome.kind !== 'created') {
      // A shortcut collision, most likely — the name was checked above. Reported
      // rather than retried without the shortcut: quietly dropping it would lose
      // something the person set, and an import that silently edits data is
      // worse than one that refuses a row and says which.
      rejected.push({
        what: `tag "${rawName}"`,
        why: `Could not create it (${outcome.kind}).`,
      });
      continue;
    }

    if (sourceId) tagIdMap.set(sourceId, tag.id);
    tagCount += 1;
  }

  for (const row of verseRows) {
    const sourceId = asString(row.id);
    const local = await localIdFor(ownerId, sourceId, (candidate) =>
      deps.verses.findById(candidate),
    );

    // A verse has no natural key the way a tag has its name, so this is the
    // only thing standing between a second run and a second copy.
    if (local.existing) {
      skipped += 1;
      continue;
    }

    const id = local.id;
    /** What to call this row when reporting it: the file's name for it. */
    const label = sourceId ?? '(no id)';

    const fileTagIds = Array.isArray(row.tag_ids) ? (row.tag_ids as unknown[]) : [];
    // A tag id the document also carried is rewritten to whatever that tag
    // became here. One it did not carry is passed through unchanged — it may
    // name a tag this account already has, which a partial document is entitled
    // to do — and the two checks below catch everything else.
    const tagIds = fileTagIds.map((value) => {
      const named = asString(value);
      return named === null ? null : (tagIdMap.get(named) ?? named);
    });

    if (tagIds.length === 0) {
      rejected.push({ what: `verse ${label}`, why: 'It carries no tags.' });
      continue;
    }

    // Anything that did not come out of this document and is not an id at all
    // cannot be looked up, and passing it to a query would fail the whole
    // import on a cast rather than this one row.
    const resolved = tagIds.filter(
      (value): value is string => value !== null && isUuid(value),
    );
    if (resolved.length !== tagIds.length) {
      rejected.push({
        what: `verse ${label}`,
        why: 'It names a tag that is not in this document and not an id here.',
      });
      continue;
    }

    // The tags must actually be this owner's. A document naming a tag id that
    // belongs to someone else would otherwise file a verse into their tag —
    // and since tag visibility drives verse visibility (§2), that is a
    // disclosure route rather than untidy data.
    const owned = await deps.tags.findManyByIds(ownerId, resolved);
    if (owned.length !== resolved.length) {
      rejected.push({
        what: `verse ${label}`,
        why: 'It refers to a tag that is not yours.',
      });
      continue;
    }

    const placement = parsePlacement({
      eventStart: asDate(row.event_start),
      eventEnd: asDate(row.event_end),
      deepTimeYears: typeof row.deep_time_years === 'number' ? row.deep_time_years : null,
    });
    if (!placement.ok) {
      rejected.push({ what: `verse ${label}`, why: placement.error.message });
      continue;
    }

    const properties = parseProperties(
      row.properties && typeof row.properties === 'object'
        ? (row.properties as Record<string, unknown>)
        : {},
    );
    if (!properties.ok) {
      rejected.push({ what: `verse ${label}`, why: properties.error.message });
      continue;
    }

    const visibility = readVisibility(row.visibility);
    if (!visibility.ok) {
      rejected.push({ what: `verse ${label}`, why: visibility.error.message });
      continue;
    }

    const verse = createVerse({
      id,
      ownerId,
      tagIds: resolved,
      placement: placement.value,
      location: asString(row.location),
      rating: typeof row.rating === 'number' ? row.rating : null,
      xp: asString(row.xp),
      properties: properties.value,
      visibility: visibility.value,
      clock: deps.clock,
    });

    if (!verse.ok) {
      rejected.push({ what: `verse ${label}`, why: verse.error.message });
      continue;
    }

    await deps.verses.create(verse.value);
    verseCount += 1;
  }

  return ok({ tags: tagCount, verses: verseCount, skipped, rejected });
}

/**
 * The wired counterpart to `exportForUser`, and the only import entry point
 * another module may use.
 *
 * `importVerses` takes its ports explicitly so it can be driven against fakes;
 * this is the one line of composition that gives it this module's own adapters.
 * It lives here rather than in the caller because a caller able to construct a
 * repository would also be able to reach past the visibility rule — the single
 * thing the module boundary exists to prevent (§1.1).
 */
export function importForUser(
  ownerId: string,
  document: { tags?: unknown; verses?: unknown },
  clock: Clock,
): Promise<Result<ImportSummary, DomainError>> {
  return importVerses(ownerId, document, {
    verses: new PrismaVerseRepository(),
    tags: new PrismaTagRepository(),
    clock,
  });
}

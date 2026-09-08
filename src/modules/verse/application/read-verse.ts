import { type DomainError, type Result, err, ok } from '@/shared/kernel';
import type { ShareRepository, VerseRepository, VisibleVerse } from '../domain/ports';
import type { Verse } from '../domain/verse';
import { canRead, resolveVisibility } from '../domain/visibility';
import { forbidden } from '../domain/errors';

/**
 * The read path, and the only one.
 *
 * Every way of getting a Verse out of this module goes through `visible` or
 * `visibleMany` below. Nothing else may hand a caller a Verse, because a caller
 * holding a bare Verse has to remember to resolve visibility, and "remember to"
 * is how the leak happens (CLAUDE.md; architecture.md §2).
 *
 * The two functions differ only in how many rows they load at once — the
 * decision itself is `resolveVisibility` + `canRead` in both cases, never a
 * predicate written here.
 */

export interface ReadDeps {
  verses: VerseRepository;
  shares: ShareRepository;
}

/**
 * One verse, if this viewer may see it.
 *
 * A refusal is `forbidden()`, whose message is "That verse does not exist" and
 * which the API answers with 404. Distinguishing "not yours" from "not there"
 * would let anyone confirm which ids are real.
 */
export async function visible(
  verseId: string,
  viewerId: string | null,
  deps: ReadDeps,
): Promise<Result<VisibleVerse, DomainError>> {
  const verse = await deps.verses.findById(verseId);
  if (!verse) return err(forbidden());

  const tags = await deps.verses.tagsOf(verseId);
  const effective = resolveVisibility(
    verse.visibility,
    tags.map((t) => t.visibility),
  );

  // The share lookup is skipped unless it can change the answer. Not for
  // speed — for the invariant: `canRead` only consults `viewerHasShare` when
  // the verse resolved to `shared`, so passing it in other cases could only
  // ever mislead a future reader into thinking a share opens a private verse.
  const viewerHasShare =
    effective === 'shared' && viewerId !== null
      ? await deps.shares.viewerHasShare(verseId, viewerId)
      : false;

  if (!canRead({ ownerId: verse.ownerId, viewerId, effective, viewerHasShare })) {
    return err(forbidden());
  }

  return ok({ verse, tags, effectiveVisibility: effective });
}

/**
 * A page of verses, filtered to what this viewer may see.
 *
 * Two batched lookups rather than two per verse: tags for the whole page, and
 * shares for the whole page. A timeline of twenty would otherwise be forty-one
 * queries, and the version of this that "optimises" by skipping the resolution
 * for some rows is the bug this module exists to prevent.
 *
 * Rows the viewer may not see are dropped, not redacted. A placeholder saying
 * "something is here" still discloses that something is here.
 */
export async function visibleMany(
  verses: readonly Verse[],
  viewerId: string | null,
  deps: ReadDeps,
): Promise<VisibleVerse[]> {
  if (verses.length === 0) return [];

  const ids = verses.map((v) => v.id);
  const tagsByVerse = await deps.verses.tagsOfMany(ids);

  const resolved = verses.map((verse) => ({
    verse,
    tags: tagsByVerse.get(verse.id) ?? [],
    effectiveVisibility: resolveVisibility(
      verse.visibility,
      (tagsByVerse.get(verse.id) ?? []).map((t) => t.visibility),
    ),
  }));

  // Only rows that resolved to `shared` can be opened by a share, so only those
  // are worth asking about.
  const needShare = resolved
    .filter((r) => r.effectiveVisibility === 'shared' && r.verse.ownerId !== viewerId)
    .map((r) => r.verse.id);

  const shared =
    viewerId !== null && needShare.length > 0
      ? await deps.shares.viewerSharesFor(needShare, viewerId)
      : new Set<string>();

  return resolved.filter((r) =>
    canRead({
      ownerId: r.verse.ownerId,
      viewerId,
      effective: r.effectiveVisibility,
      viewerHasShare: shared.has(r.verse.id),
    }),
  );
}

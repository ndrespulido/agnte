import { type DomainError, type Result, err, ok } from '@/shared/kernel';
import type {
  MediaResolver,
  ShareRepository,
  VerseMedia,
  VerseRepository,
  VisibleVerse,
} from '../domain/ports';
import type { Tag } from '../domain/tag';
import type { Verse } from '../domain/verse';
import type { Visibility } from '../domain/visibility';
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
 *
 * Media is resolved *after* `canRead` succeeds, and always with the verse's
 * own `ownerId` — never the viewer's, including when they are the same
 * person. Media has no visibility concept of its own (CLAUDE.md's Visibility
 * section); it trusts that by the time this call is made, the only question
 * left is "what does this owner's media look like", which is true precisely
 * because everything above this line already decided the viewer may ask it.
 */

export interface ReadDeps {
  verses: VerseRepository;
  shares: ShareRepository;
  media: MediaResolver;
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

  const media = await deps.media.resolveForVerse(verse.ownerId, verse.mediaIds);

  return ok({ verse, tags, media, effectiveVisibility: effective });
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

  const readable = resolved.filter((r) =>
    canRead({
      ownerId: r.verse.ownerId,
      viewerId,
      effective: r.effectiveVisibility,
      viewerHasShare: shared.has(r.verse.id),
    }),
  );

  return attachMedia(readable, deps);
}

/**
 * Batches the media resolution by owner rather than one call per verse — a
 * page from one timeline is always one owner in practice (`TimelineQuery`
 * and `SearchQuery` are both scoped to a single `ownerId`), but grouping
 * here rather than trusting that keeps this correct even if a future caller
 * ever mixes owners in one `visibleMany` call. A verse with no media never
 * reaches `deps.media.resolveForVerse` at all — the common case, since a
 * Verse can be minimal (CLAUDE.md) — so an ordinary timeline page with few
 * photos costs one such call, not one per row.
 */
async function attachMedia(
  rows: readonly {
    verse: Verse;
    tags: readonly Tag[];
    effectiveVisibility: Visibility;
  }[],
  deps: ReadDeps,
): Promise<VisibleVerse[]> {
  const idsByOwner = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.verse.mediaIds.length === 0) continue;
    const ids = idsByOwner.get(row.verse.ownerId) ?? new Set<string>();
    for (const id of row.verse.mediaIds) ids.add(id);
    idsByOwner.set(row.verse.ownerId, ids);
  }

  const mediaByOwner = new Map<string, Map<string, VerseMedia>>();
  await Promise.all(
    [...idsByOwner].map(async ([ownerId, ids]) => {
      const found = await deps.media.resolveForVerse(ownerId, [...ids]);
      mediaByOwner.set(ownerId, new Map(found.map((m) => [m.id, m])));
    }),
  );

  return rows.map((row) => {
    const byId = mediaByOwner.get(row.verse.ownerId);
    const media = byId
      ? row.verse.mediaIds
          .map((id) => byId.get(id))
          .filter((m): m is VerseMedia => m !== undefined)
      : [];
    return { ...row, media };
  });
}

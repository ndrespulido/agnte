import { getMediaBlobStore } from '../infrastructure/blob-store';
import { PrismaMediaRepository } from '../infrastructure/prisma-media-repository';

/**
 * The two calls verse makes into media's public surface (media/index.ts),
 * closing the gap CLAUDE.md's Visibility section describes: verse's
 * `mediaIds` accepted any UUID with no check it belonged to the writer, and
 * a Verse's API response would have handed back a signed URL for whatever it
 * found there — legitimate or not.
 *
 * Both live in media's own vocabulary and both take an owner id supplied by
 * the *caller*, never resolved here: media has no visibility concept of its
 * own (CLAUDE.md), so it is not this function's job to decide who may ask —
 * only to answer truthfully once verse already has.
 */

/** A generous window: a client rendering one timeline page, not a promise the
 * link stays good indefinitely. Re-resolved on every read. */
const SIGNED_URL_TTL_SECONDS = 10 * 60;

/**
 * Which of the given ids actually belong to `ownerId`.
 *
 * Called at verse-write time, the same shape as `TagRepository.findManyByIds`
 * verse already uses for its own tags: a request naming someone else's media
 * comes back short, and a caller that finds the result shorter than what it
 * asked for refuses the write rather than silently dropping the id.
 */
export async function ownedMediaIds(
  ownerId: string,
  mediaIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (mediaIds.length === 0) return new Set();
  const found = await new PrismaMediaRepository().findManyByIds(ownerId, mediaIds);
  return new Set(found.map((media) => media.id));
}

export interface MediaSummaryForVerse {
  readonly id: string;
  readonly status: string;
  /** Null while `pending` — the upload has not been confirmed yet, so there
   * is nothing verified at the key to hand out a link to. */
  readonly originalUrl: string | null;
  /** Null until the thumbnail job has produced this variant. */
  readonly thumbUrl: string | null;
  readonly mediumUrl: string | null;
}

/**
 * Called at verse-read time, using the *verse owner's* id — not the
 * viewer's. By the time this runs, verse has already decided the viewer may
 * see the verse (`application/read-verse.ts`'s `visible`/`visibleMany` call
 * this only after `canRead` succeeds); this call is what turns the ids that
 * survived into links, scoped to whoever actually owns them.
 *
 * Ids in `mediaIds` that do not resolve — deleted since, or never valid —
 * are silently absent from the result rather than an error: a read should
 * not fail because one attachment among several is gone.
 */
export async function resolveMediaForVerse(
  ownerId: string,
  mediaIds: readonly string[],
): Promise<MediaSummaryForVerse[]> {
  if (mediaIds.length === 0) return [];

  const repo = new PrismaMediaRepository();
  const found = await repo.findManyByIds(ownerId, mediaIds);
  if (found.length === 0) return [];

  const blobStore = getMediaBlobStore();
  const variantsByMedia = await repo.variantsForMany(found.map((media) => media.id));

  return Promise.all(
    found.map(async (media): Promise<MediaSummaryForVerse> => {
      const variants = variantsByMedia.get(media.id) ?? [];
      const thumb = variants.find((variant) => variant.kind === 'thumb');
      const medium = variants.find((variant) => variant.kind === 'medium');

      if (!blobStore) {
        return {
          id: media.id,
          status: media.status,
          originalUrl: null,
          thumbUrl: null,
          mediumUrl: null,
        };
      }

      const [originalUrl, thumbUrl, mediumUrl] = await Promise.all([
        media.status === 'pending'
          ? Promise.resolve(null)
          : blobStore.presignDownload(media.storageKey, SIGNED_URL_TTL_SECONDS),
        thumb
          ? blobStore.presignDownload(thumb.storageKey, SIGNED_URL_TTL_SECONDS)
          : Promise.resolve(null),
        medium
          ? blobStore.presignDownload(medium.storageKey, SIGNED_URL_TTL_SECONDS)
          : Promise.resolve(null),
      ]);

      return { id: media.id, status: media.status, originalUrl, thumbUrl, mediumUrl };
    }),
  );
}

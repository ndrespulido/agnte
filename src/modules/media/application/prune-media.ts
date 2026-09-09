import { getMediaBlobStore } from '../infrastructure/blob-store';
import { PrismaMediaRepository } from '../infrastructure/prisma-media-repository';

/**
 * How long an unconfirmed upload is kept before it is assumed abandoned.
 *
 * The presigned URL it was created with is good for five minutes, so anything
 * still `pending` a day later is not a slow client — it is a request-upload
 * whose confirm never arrived, because the app was closed, the network went,
 * or the person changed their mind. A day is far past the window and far short
 * of a retention policy anyone has to think about.
 */
export const PENDING_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes abandoned `pending` rows and whatever bytes they left behind.
 *
 * Two kinds of leak, and the storage one costs money: a client can request an
 * upload, PUT the bytes, and never confirm — leaving an object in R2 that no
 * row will ever point at again once its `pending` row goes. So the keys are
 * read first, the rows deleted, then the objects, which is the same order
 * `deleteMedia` uses and for the same reason: an orphaned blob is a cleanup
 * problem, while bytes deleted out from under a live row are data loss.
 *
 * A `pending` id can legitimately be attached to a Verse — `ownedMediaIds`
 * does not filter by status, because a client composing offline attaches the
 * id before the upload finishes. Pruning it therefore leaves that Verse with
 * a dangling reference, which the read path already tolerates by design:
 * `resolveMediaForVerse` drops ids that no longer resolve rather than
 * failing the read.
 *
 * Only `pending`. A `failed` row is a dead end but its owner may still be
 * looking at it, and `ready` is the point of the whole module.
 */
export async function prunePendingMedia(now: Date): Promise<number> {
  const media = new PrismaMediaRepository();
  const before = new Date(now.getTime() - PENDING_UPLOAD_TTL_MS);

  const abandoned = await media.findAbandonedPending(before);
  if (abandoned.length === 0) return 0;

  const deleted = await media.deleteMany(abandoned.map((row) => row.id));

  const blobStore = getMediaBlobStore();
  if (blobStore) {
    // Best effort, and after the rows: a storage failure here leaves an
    // orphan for the next run to miss, which is a great deal better than a
    // failure that stops the rows being cleared at all.
    await Promise.all(
      abandoned.map((row) => blobStore.delete(row.storageKey).catch(() => undefined)),
    );
  }

  return deleted;
}

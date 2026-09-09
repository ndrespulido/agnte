import { type DomainError, type Result, err, ok } from '@/shared/kernel';
import { notFound, versionConflict } from '../domain/errors';
import type { MediaBlobStore, MediaRepository } from '../domain/ports';

export interface DeleteMediaDeps {
  media: MediaRepository;
  blobStore: MediaBlobStore;
}

export interface DeleteMediaInput {
  ownerId: string;
  mediaId: string;
  expectedVersion: number;
}

/**
 * Removes a Media row and everything it points to in storage: the original
 * and every generated variant.
 *
 * The row first, then storage — not the other way round. Deleting storage
 * before the version-gated row delete would mean a stale `expectedVersion`
 * (someone else already changed this row, or a client retried after the
 * version had moved on) destroys the original and every variant for a row
 * that turns out *not* to be deleted, which would leave a live, still-
 * `ready` Media pointing at nothing. Deleting the row first and storage
 * second can still leak orphaned blobs if this process dies in between, but
 * an orphan is a cleanup problem for a future pruner; a live row with its
 * bytes already gone is user-visible data loss with no way back.
 *
 * Variant keys are read before the row is deleted, since `media_variant`
 * cascades from `media` (see the migration) — once the row is gone, so is
 * the only record of where its variants lived.
 *
 * Does not check whether a Verse still references this id. Media has no way
 * to know — verse is a separate schema this module has no join into
 * (architecture.md §1.1) — so a Verse can end up with a dangling mediaId
 * after this. Closing that gap is verse's side of the integration planned
 * for a later phase, not something this function can do from here.
 */
export async function deleteMedia(
  input: DeleteMediaInput,
  deps: DeleteMediaDeps,
): Promise<Result<null, DomainError>> {
  const media = await deps.media.findById(input.mediaId);
  if (!media || media.ownerId !== input.ownerId) return err(notFound());

  const variants = await deps.media.variantsFor(media.id);

  const deleted = await deps.media.delete(media.id, input.expectedVersion);
  if (!deleted) {
    const current = await deps.media.findById(media.id);
    return err(versionConflict(input.expectedVersion, current?.version ?? -1));
  }

  await Promise.all([
    deps.blobStore.delete(media.storageKey),
    ...variants.map((variant) => deps.blobStore.delete(variant.storageKey)),
  ]);

  return ok(null);
}

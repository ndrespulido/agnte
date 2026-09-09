import { type Clock, type DomainError, type Result, ok } from '@/shared/kernel';
import { createPendingMedia, parseContentType, parseDeclaredSize } from '../domain/media';
import type { Media } from '../domain/media';
import type { MediaBlobStore, MediaRepository, UploadTarget } from '../domain/ports';

export interface UploadRequestDeps {
  media: MediaRepository;
  blobStore: MediaBlobStore;
  clock: Clock;
}

export interface RequestUploadInput {
  ownerId: string;
  contentType: string;
  declaredSizeBytes: number;
  /** Client-generated UUIDv7 (architecture.md §2), when the client made one —
   * an offline-composed Verse (§8.1) needs a Media id to point at before this
   * call, let alone before the bytes exist. */
  id?: string | undefined;
}

export interface RequestedUpload {
  media: Media;
  upload: UploadTarget;
}

/**
 * Creates a `pending` Media row and hands back where to put its bytes.
 *
 * The row is written before the upload URL is even asked for, not after: the
 * id needs to exist the moment this call returns, because the same id may
 * already be sitting in a Verse a client composed while offline.
 *
 * Calling this twice with the same client-supplied `id` (a retried request
 * under a flaky connection) is not handled here — that is what wraps this at
 * the API layer with `idempotently()` (api/idempotent.ts), the same guard
 * verse's writes use, rather than every application function re-implementing
 * replay detection for itself.
 */
export async function requestUpload(
  input: RequestUploadInput,
  deps: UploadRequestDeps,
): Promise<Result<RequestedUpload, DomainError>> {
  const contentType = parseContentType(input.contentType);
  if (!contentType.ok) return contentType;

  const declaredSizeBytes = parseDeclaredSize(input.declaredSizeBytes);
  if (!declaredSizeBytes.ok) return declaredSizeBytes;

  const media = createPendingMedia({
    ...(input.id === undefined ? {} : { id: input.id }),
    ownerId: input.ownerId,
    contentType: contentType.value,
    declaredSizeBytes: declaredSizeBytes.value,
    clock: deps.clock,
  });

  await deps.media.create(media);

  const upload = await deps.blobStore.presignUpload({
    key: media.storageKey,
    contentType: media.contentType,
  });

  return ok({ media, upload });
}

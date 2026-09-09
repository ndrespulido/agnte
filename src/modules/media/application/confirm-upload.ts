import { type Clock, type DomainError, type Result, err, ok } from '@/shared/kernel';
import { MAX_DECLARED_BYTES, transition, type Media } from '../domain/media';
import { notFound, notPending, uploadMismatch, versionConflict } from '../domain/errors';
import type {
  MediaBlobStore,
  MediaRepository,
  StoredObjectInfo,
  ThumbnailQueue,
} from '../domain/ports';

export interface ConfirmUploadDeps {
  media: MediaRepository;
  blobStore: MediaBlobStore;
  /**
   * Undefined in a deployed environment missing its Cloud Tasks configuration
   * (`getThumbnailQueue`) — never undefined locally. Optional here rather
   * than required so that gap degrades to "no thumbnails yet", the same
   * "missing convenience, not a broken upload" reasoning `shared/infra/
   * deferred-jobs.ts` already documents for `getDeferredJobs`.
   */
  queue: ThumbnailQueue | undefined;
  clock: Clock;
}

export interface ConfirmUploadInput {
  ownerId: string;
  mediaId: string;
  expectedVersion: number;
}

/**
 * The real check behind an upload: does what actually landed in storage
 * agree with what was declared when the upload URL was requested. See
 * `domain/ports.ts`'s `UploadTarget` doc comment for why this, not the
 * presigned request's signed headers, is the boundary this codebase actually
 * relies on.
 *
 * A size over the hard cap is refused even though `head()` cannot know what
 * the client originally declared it would be — `MAX_DECLARED_BYTES` is the
 * one number every upload is judged against, not a per-row promise a client
 * made about itself.
 */
export function checkUpload(
  media: Media,
  info: StoredObjectInfo | null,
): DomainError | null {
  if (!info) return uploadMismatch('no file was found at the upload location');
  if (info.sizeBytes <= 0) return uploadMismatch('the uploaded file is empty');
  if (info.sizeBytes > MAX_DECLARED_BYTES) {
    return uploadMismatch('the uploaded file is larger than allowed');
  }
  if (info.contentType !== media.contentType) {
    return uploadMismatch(
      `expected ${media.contentType}, got ${info.contentType ?? 'an unrecognised content type'}`,
    );
  }
  return null;
}

/**
 * Moves a Media from `pending` to `processing` once its upload checks out,
 * and enqueues thumbnail generation.
 *
 * A mismatch marks the row `failed` rather than leaving it `pending` forever:
 * `failed` is a dead end (domain/media.ts), the same rule a thumbnailing
 * failure follows, so a client that hits it uploads again as a new Media
 * (`requestUpload`) rather than this row ever being retried in place. Best
 * effort — if the write to record `failed` itself fails, the mismatch error
 * is still what the caller sees; a database that cannot take that write
 * cannot take the real fix either.
 */
export async function confirmUpload(
  input: ConfirmUploadInput,
  deps: ConfirmUploadDeps,
): Promise<Result<Media, DomainError>> {
  const media = await deps.media.findById(input.mediaId);
  // "Not yours" and "not there" get the same answer — the same enumeration-
  // avoidance rule verse's write layer applies to a verse or tag id.
  if (!media || media.ownerId !== input.ownerId) return err(notFound());

  if (media.status !== 'pending') return err(notPending());

  const info = await deps.blobStore.head(media.storageKey);
  const mismatch = checkUpload(media, info);
  if (mismatch) {
    const failed = transition(media, 'failed', deps.clock);
    if (failed.ok)
      await deps.media.update(failed.value, media.version).catch(() => false);
    return err(mismatch);
  }

  const processing = transition(media, 'processing', deps.clock);
  if (!processing.ok) return processing;

  const applied = await deps.media.update(processing.value, input.expectedVersion);
  if (!applied) {
    const current = await deps.media.findById(input.mediaId);
    return err(versionConflict(input.expectedVersion, current?.version ?? -1));
  }

  // Best effort: see the ConfirmUploadDeps.queue doc comment above for why an
  // unconfigured or failing queue does not fail an upload that already
  // checked out.
  await deps.queue?.enqueueThumbnailJob(media.id).catch(() => undefined);

  // Re-read rather than return `processing.value` directly: locally, the
  // queue above just *ran* the thumbnail job in-process to completion
  // (architecture.md §7.1) rather than merely scheduling it, so the row this
  // function read a moment ago as `processing` may already be `ready` or
  // `failed` by now. In a deployed environment this is one extra cheap read
  // that comes back unchanged, but it is what keeps the response honest about
  // which of those two worlds actually ran.
  const latest = await deps.media.findById(input.mediaId);
  return ok(latest ?? processing.value);
}

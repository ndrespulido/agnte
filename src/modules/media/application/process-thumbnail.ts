import type { Clock } from '@/shared/kernel';
import { transition, type Media, type MediaStatus } from '../domain/media';
import { variantKeyFor, VARIANT_CONTENT_TYPE } from '../domain/variant';
import type {
  MediaBlobStore,
  MediaRepository,
  ThumbnailGenerator,
} from '../domain/ports';

export interface ThumbnailDeps {
  media: MediaRepository;
  blobStore: MediaBlobStore;
  generator: ThumbnailGenerator;
  clock: Clock;
}

/**
 * Turns one `processing` Media's original into its `thumb` and `medium`
 * variants (architecture.md §8.3). This is the job body Cloud Tasks calls
 * back into via `/internal/media/thumbnail`, and what the local queue calls
 * directly in-process (architecture.md §7.1) — both paths converge here so
 * there is exactly one thumbnailing implementation to keep correct.
 *
 * At-least-once delivery (Cloud Tasks, or a client-side bug that enqueues
 * twice) is handled by checking status rather than by an idempotency key:
 * a second delivery finds the row already `ready` (or `failed`) and returns
 * without redoing the work. The gap this leaves — two deliveries both seeing
 * `processing` and racing to write the same variants — is closed by every
 * write downstream being an overwrite (`writeBuffer`, `createVariant`'s
 * `ON CONFLICT DO UPDATE`) rather than an insert that could conflict, so a
 * lost race is a wasted second attempt, not a corrupt one.
 */
export async function processThumbnailJob(
  mediaId: string,
  deps: ThumbnailDeps,
): Promise<void> {
  const media = await deps.media.findById(mediaId);
  if (!media || media.status !== 'processing') return;

  try {
    const original = await deps.blobStore.readBuffer(media.storageKey);
    if (!original) {
      throw new Error(
        `thumbnail job ${mediaId}: original missing at ${media.storageKey}`,
      );
    }

    const variants = await deps.generator.generate(original);

    for (const variant of variants) {
      const key = variantKeyFor(media.ownerId, media.id, variant.kind);
      await deps.blobStore.writeBuffer(key, variant.buffer, VARIANT_CONTENT_TYPE);
      await deps.media.createVariant({
        mediaId: media.id,
        kind: variant.kind,
        storageKey: key,
        width: variant.width,
        height: variant.height,
        sizeBytes: variant.buffer.length,
        createdAt: deps.clock.now(),
      });
    }

    await setStatus(media, 'ready', deps);
  } catch {
    /**
     * `failed` is a dead end (domain/media.ts's state machine), the same as a
     * confirm that finds a mismatched upload: a corrupt original or a format
     * sharp cannot decode is a data problem this row will never recover from
     * by itself, not a transient one, so the error is swallowed here rather
     * than rethrown. The caller (the internal route) answers Cloud Tasks with
     * 200 regardless, which stops it from burning retries against a task that
     * would only ever fail the same way again — the outcome a caller cares
     * about was already written to `media.status`, not to this response.
     *
     * An error escaping this catch — `setStatus` itself throwing while trying
     * to record `failed` — is left to propagate, because that is the one
     * case that is a real infrastructure problem (the database is
     * unreachable) rather than a bad image, and it is exactly the case where
     * a retry might actually help.
     */
    await setStatus(media, 'failed', deps);
  }
}

async function setStatus(
  media: Media,
  to: MediaStatus,
  deps: Pick<ThumbnailDeps, 'media' | 'clock'>,
): Promise<void> {
  const next = transition(media, to, deps.clock);
  // Not reachable in practice — nothing else calls transition() on this row
  // between the read above and here — but transition() returns a Result
  // rather than throwing, so this stays a no-op instead of an unchecked cast
  // if that ever stops being true.
  if (next.ok) await deps.media.update(next.value, media.version);
}

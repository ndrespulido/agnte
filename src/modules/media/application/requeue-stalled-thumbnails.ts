import { PrismaMediaRepository } from '../infrastructure/prisma-media-repository';
import { getThumbnailQueue } from '../infrastructure/thumbnail-queue';

/**
 * How long a Media may sit in `processing` before its thumbnail job is
 * assumed lost.
 *
 * The job itself takes seconds, and Cloud Tasks retries a failing one up to
 * five times on its own. An hour is far past both, and far short of a person
 * noticing their photo never appeared.
 */
export const STALLED_PROCESSING_TTL_MS = 60 * 60 * 1000;

/**
 * Re-enqueues thumbnail jobs for Media stuck in `processing`.
 *
 * This exists because of a real, silent failure: the Cloud Tasks API was not
 * enabled on the project, so every `enqueueThumbnailJob` threw, and
 * `confirmUpload` swallowed it by design — an upload that landed correctly
 * should not fail because a convenience behind it did. The cost of that
 * choice was that the swallow was *terminal*: nothing else ever revisited a
 * `processing` row, so those photos were invisible permanently, and enabling
 * the API later fixed only uploads made after it.
 *
 * Enqueueing again is safe to repeat. `processThumbnailJob` re-reads the row
 * and returns immediately unless it is still `processing`, so a job that is
 * merely slow rather than lost costs one wasted dispatch, not a double
 * write — the same at-least-once reasoning that job already documents.
 *
 * Best effort per row, and sequential: a queue that is still broken should
 * leave the rest of the daily run untouched, and a hundred concurrent
 * dispatches is not something a free tier should do at 03:00 unasked.
 */
export async function requeueStalledThumbnails(now: Date): Promise<number> {
  const queue = getThumbnailQueue();
  // No queue configured at all — the same "deployed without Cloud Tasks"
  // case getThumbnailQueue documents. Nothing to re-enqueue onto.
  if (!queue) return 0;

  const media = new PrismaMediaRepository();
  const stalled = await media.findStalledProcessing(
    new Date(now.getTime() - STALLED_PROCESSING_TTL_MS),
  );

  let requeued = 0;
  for (const row of stalled) {
    try {
      await queue.enqueueThumbnailJob(row.id);
      requeued += 1;
    } catch {
      // Left for tomorrow's run. The row stays `processing`, which is the
      // same state it was already in, so a failure here loses nothing.
    }
  }

  return requeued;
}

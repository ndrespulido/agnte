import type { ThumbnailQueue } from '../domain/ports';

/**
 * Local dev has no Cloud Tasks: calls the same job handler directly,
 * in-process (architecture.md §7.1 — "in-process queue calling the same
 * handler directly"). `next dev` is a process that keeps running, unlike
 * Cloud Run, so there is nothing to protect against by deferring the call the
 * way `RemoteThumbnailQueue` has to.
 *
 * Takes a function reference rather than looking up `processThumbnailJob`
 * itself, so this class stays a thin adapter and the factory in
 * `thumbnail-queue.ts` is the one place that wires it to a concrete job.
 */
export class LocalThumbnailQueue implements ThumbnailQueue {
  constructor(private readonly handler: (mediaId: string) => Promise<void>) {}

  async enqueueThumbnailJob(mediaId: string): Promise<void> {
    await this.handler(mediaId);
  }
}

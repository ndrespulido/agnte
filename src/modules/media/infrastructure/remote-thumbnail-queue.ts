import type { DeferredJobs } from '@/shared/infra/deferred-jobs';
import type { ThumbnailQueue } from '../domain/ports';

/**
 * Deployed environments: hands the job to Cloud Tasks, which calls back into
 * `/internal/media/thumbnail` (architecture.md §1.3) once this request has
 * already returned — Cloud Run may kill the container the moment it does.
 */
export class RemoteThumbnailQueue implements ThumbnailQueue {
  constructor(private readonly jobs: DeferredJobs) {}

  async enqueueThumbnailJob(mediaId: string): Promise<void> {
    await this.jobs.enqueue({ path: '/internal/media/thumbnail', body: { mediaId } });
  }
}

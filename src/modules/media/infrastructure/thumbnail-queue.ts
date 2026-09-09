import { systemClock } from '@/shared/kernel';
import { loadConfig } from '@/shared/infra/config';
import { getDeferredJobs } from '@/shared/infra/deferred-jobs';
import type { ThumbnailQueue } from '../domain/ports';
import { processThumbnailJob } from '../application/process-thumbnail';
import { getMediaBlobStore } from './blob-store';
import { LocalThumbnailQueue } from './local-thumbnail-queue';
import { PrismaMediaRepository } from './prisma-media-repository';
import { RemoteThumbnailQueue } from './remote-thumbnail-queue';
import { SharpThumbnailGenerator } from './sharp-thumbnail-generator';

/**
 * The configured `ThumbnailQueue`: Cloud Tasks in a deployed environment,
 * the in-process local queue otherwise — the same dual-adapter shape as
 * `getMediaBlobStore` and `getObjectStorage`, but with no memoisation of its
 * own. Both branches only wrap an already-cached factory (`getDeferredJobs`,
 * `getMediaBlobStore`), so there is no expensive work here to cache — just
 * two constructors — and skipping it means one less cache for a test to
 * remember to reset.
 *
 * Undefined return means no queue could be built at all: deployed without
 * the Cloud Tasks configuration `getDeferredJobs` needs. `confirmUpload`
 * treats that the same way it treats an enqueue that failed after a queue was
 * found — see its own doc comment for why that is a missing convenience, not
 * a broken upload.
 */
export function getThumbnailQueue(): ThumbnailQueue | undefined {
  const jobs = getDeferredJobs();
  if (jobs) return new RemoteThumbnailQueue(jobs);

  if (loadConfig().APP_ENV !== 'local') return undefined;

  return new LocalThumbnailQueue(async (mediaId) => {
    const blobStore = getMediaBlobStore();
    // Never actually undefined locally — the filesystem adapter has no
    // configuration to be missing — but the port is typed as optional
    // because a deployed environment's is, so this stays honest about that.
    if (!blobStore) return;

    await processThumbnailJob(mediaId, {
      media: new PrismaMediaRepository(),
      blobStore,
      generator: new SharpThumbnailGenerator(),
      clock: systemClock,
    });
  });
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetDeferredJobsForTests } from '@/shared/infra/deferred-jobs';
import { LocalThumbnailQueue } from '@/modules/media/infrastructure/local-thumbnail-queue';
import { RemoteThumbnailQueue } from '@/modules/media/infrastructure/remote-thumbnail-queue';
import { getThumbnailQueue } from '@/modules/media/infrastructure/thumbnail-queue';
import { resetMediaBlobStoreForTests } from '@/modules/media/infrastructure/blob-store';
import type { DeferredJobs } from '@/shared/infra/deferred-jobs';

describe('LocalThumbnailQueue', () => {
  it('calls its handler directly, in-process, with the mediaId', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const queue = new LocalThumbnailQueue(handler);

    await queue.enqueueThumbnailJob('m1');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('m1');
  });

  it('propagates a handler failure rather than swallowing it', async () => {
    const queue = new LocalThumbnailQueue(() => Promise.reject(new Error('boom')));
    await expect(queue.enqueueThumbnailJob('m1')).rejects.toThrow('boom');
  });
});

describe('RemoteThumbnailQueue', () => {
  it('enqueues to /internal/media/thumbnail with the mediaId as the body', async () => {
    const jobs: DeferredJobs = {
      description: 'fake',
      enqueue: vi.fn().mockResolvedValue(undefined),
    };
    const queue = new RemoteThumbnailQueue(jobs);

    await queue.enqueueThumbnailJob('m1');

    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      path: '/internal/media/thumbnail',
      body: { mediaId: 'm1' },
    });
  });
});

describe('getThumbnailQueue', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetDeferredJobsForTests();
    resetMediaBlobStoreForTests();
  });

  const configure = (env: Record<string, string | undefined>) => {
    process.env = { ...ORIGINAL_ENV, ...env };
    resetConfigForTests();
    resetDeferredJobsForTests();
    resetMediaBlobStoreForTests();
  };

  it('prefers the remote queue when Cloud Tasks is fully configured', () => {
    configure({
      APP_ENV: 'production',
      DATABASE_URL: undefined,
      GCP_PROJECT_ID: 'agnte-prod',
      GCP_REGION: 'europe-west3',
      APP_BASE_URL: 'https://agnte.example.com',
      INTERNAL_TASKS_SECRET: 'a'.repeat(32),
    });
    expect(getThumbnailQueue()).toBeInstanceOf(RemoteThumbnailQueue);
  });

  it('falls back to the local queue when APP_ENV is local and Cloud Tasks is not configured', () => {
    configure({
      APP_ENV: 'local',
      DATABASE_URL: undefined,
      GCP_PROJECT_ID: undefined,
      GCP_REGION: undefined,
      APP_BASE_URL: undefined,
      INTERNAL_TASKS_SECRET: undefined,
    });
    expect(getThumbnailQueue()).toBeInstanceOf(LocalThumbnailQueue);
  });

  it('is undefined when deployed with neither Cloud Tasks nor local storage', () => {
    configure({
      APP_ENV: 'production',
      DATABASE_URL: undefined,
      GCP_PROJECT_ID: undefined,
      GCP_REGION: undefined,
      APP_BASE_URL: undefined,
      INTERNAL_TASKS_SECRET: undefined,
    });
    expect(getThumbnailQueue()).toBeUndefined();
  });
});

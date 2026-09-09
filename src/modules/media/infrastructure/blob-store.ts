import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '@/shared/infra/config';
import type { MediaBlobStore } from '../domain/ports';
import { LocalMediaBlobStore } from './local-media-blob-store';
import { R2MediaBlobStore } from './r2-media-blob-store';

/**
 * The configured blob store: R2 in a deployed environment, the filesystem
 * locally — the same dual-adapter shape as `shared/infra/object-storage.ts`,
 * kept separate from it because media needs presigned URLs and buffer
 * read/write that Phase 0's text-only port never had to offer.
 */

let cached: MediaBlobStore | undefined;
let cachedFor: string | undefined;

export function getMediaBlobStore(): MediaBlobStore | undefined {
  const config = loadConfig();

  const key = createHash('sha256')
    .update(
      [
        config.APP_ENV,
        config.R2_ENDPOINT ?? '',
        config.R2_BUCKET ?? '',
        config.R2_ACCESS_KEY_ID ?? '',
        config.R2_PREFIX,
      ].join('|'),
    )
    .digest('hex');

  if (cached && cachedFor === key) return cached;

  let store: MediaBlobStore | undefined;

  if (
    config.R2_ENDPOINT &&
    config.R2_BUCKET &&
    config.R2_ACCESS_KEY_ID &&
    config.R2_SECRET_ACCESS_KEY
  ) {
    const client = new S3Client({
      region: 'auto',
      endpoint: config.R2_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      },
    });
    store = new R2MediaBlobStore(client, config.R2_BUCKET, config.R2_PREFIX);
  } else if (config.APP_ENV === 'local') {
    store = new LocalMediaBlobStore();
  }

  cached = store;
  cachedFor = key;
  return store;
}

/** Test seam: forget the memoised adapter so a test can vary the environment. */
export function resetMediaBlobStoreForTests(): void {
  cached = undefined;
  cachedFor = undefined;
}

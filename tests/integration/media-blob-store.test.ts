import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import S3rver from 's3rver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import {
  getMediaBlobStore,
  resetMediaBlobStoreForTests,
} from '@/modules/media/infrastructure/blob-store';
import { LocalMediaBlobStore } from '@/modules/media/infrastructure/local-media-blob-store';
import { R2MediaBlobStore } from '@/modules/media/infrastructure/r2-media-blob-store';

/**
 * `R2MediaBlobStore` is exercised against a local S3-compatible server rather
 * than mocked, for the same reason `tests/integration/object-storage.test.ts`
 * does: a mock would confirm which SDK methods were called, this confirms the
 * request actually signs, sends, and round-trips.
 *
 * One thing this cannot confirm, documented on `MediaBlobStore.presignUpload`
 * in domain/ports.ts: s3rver does not enforce the content-type it signed into
 * the URL, so a test asserting that mismatch is rejected would pass here and
 * say nothing true about real R2. That is why `confirmUpload` (application
 * layer, Phase 4.5) checks `head()` rather than trusting the signed request —
 * these tests cover `head()` itself instead.
 */
const BUCKET = 'agnte-media-test';
const PORT = 4570;

let server: S3rver;
let directory: string;

const ORIGINAL = { ...process.env };

const useEnv = (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL, ...env };
  resetConfigForTests();
  resetMediaBlobStoreForTests();
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 's3rver-media-'));
  server = new S3rver({
    port: PORT,
    address: '127.0.0.1',
    silent: true,
    directory,
    configureBuckets: [{ name: BUCKET, configs: [] }],
  });
  await server.run();
}, 30_000);

afterAll(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
  process.env = { ...ORIGINAL };
  resetConfigForTests();
  resetMediaBlobStoreForTests();
});

const r2Env = (extra: Record<string, string> = {}) => ({
  APP_ENV: 'production',
  DATABASE_URL: undefined,
  R2_ENDPOINT: `http://127.0.0.1:${PORT}`,
  R2_BUCKET: BUCKET,
  R2_ACCESS_KEY_ID: 'S3RVER',
  R2_SECRET_ACCESS_KEY: 'S3RVER',
  ...extra,
});

const client = (bucket = BUCKET, prefix = '') =>
  new R2MediaBlobStore(
    new S3Client({
      region: 'auto',
      endpoint: `http://127.0.0.1:${PORT}`,
      forcePathStyle: true,
      credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
    }),
    bucket,
    prefix,
  );

describe('R2MediaBlobStore against a real S3 server', () => {
  it('signs an upload URL that a real PUT can use, then reads it back via head and readBuffer', async () => {
    const store = client();
    const key = 'media/owner-1/m1/original.jpg';
    const body = Buffer.from('fake-jpeg-bytes');

    const target = await store.presignUpload({ key, contentType: 'image/jpeg' });
    expect(target.method).toBe('PUT');

    const response = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body,
    });
    expect(response.ok).toBe(true);

    const info = await store.head(key);
    expect(info).toEqual({ sizeBytes: body.length, contentType: 'image/jpeg' });
    expect(await store.readBuffer(key)).toEqual(body);
  });

  it('head returns null for a key that does not exist', async () => {
    const store = client();
    expect(await store.head('media/owner-1/nope/original.jpg')).toBeNull();
  });

  it('readBuffer returns null for a key that does not exist', async () => {
    const store = client();
    expect(await store.readBuffer('media/owner-1/nope/original.jpg')).toBeNull();
  });

  it('writeBuffer then delete removes the object', async () => {
    const store = client();
    const key = 'media/owner-1/m2/original.png';
    await store.writeBuffer(key, Buffer.from('png-bytes'), 'image/png');
    expect(await store.head(key)).not.toBeNull();

    await store.delete(key);
    expect(await store.head(key)).toBeNull();
  });

  it('presignDownload produces a URL that actually returns the object', async () => {
    const store = client();
    const key = 'media/owner-1/m3/original.webp';
    await store.writeBuffer(key, Buffer.from('webp-bytes'), 'image/webp');

    const url = await store.presignDownload(key, 60);
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('webp-bytes'));
  });

  it('isolates keys by prefix', async () => {
    const a = client(BUCKET, 'pr-a/');
    const b = client(BUCKET, 'pr-b/');
    await a.writeBuffer('shared.jpg', Buffer.from('from-a'), 'image/jpeg');
    await b.writeBuffer('shared.jpg', Buffer.from('from-b'), 'image/jpeg');

    expect(await a.readBuffer('shared.jpg')).toEqual(Buffer.from('from-a'));
    expect(await b.readBuffer('shared.jpg')).toEqual(Buffer.from('from-b'));
  });

  it('getMediaBlobStore selects the R2 adapter when fully configured', async () => {
    useEnv(r2Env());
    const store = getMediaBlobStore();
    expect(store).toBeInstanceOf(R2MediaBlobStore);
  });
});

describe('LocalMediaBlobStore', () => {
  const root = () => mkdtemp(join(tmpdir(), 'local-media-'));

  it('round-trips a buffer and reports its size and inferred content type', async () => {
    const store = new LocalMediaBlobStore(await root());
    const key = 'media/owner-1/m1/original.jpg';
    const body = Buffer.from('fake-jpeg-bytes');

    await store.writeBuffer(key, body);

    expect(await store.readBuffer(key)).toEqual(body);
    expect(await store.head(key)).toEqual({
      sizeBytes: body.length,
      contentType: 'image/jpeg',
    });
  });

  it('returns null from head and readBuffer for a missing key', async () => {
    const store = new LocalMediaBlobStore(await root());
    expect(await store.head('media/owner-1/nope/original.jpg')).toBeNull();
    expect(await store.readBuffer('media/owner-1/nope/original.jpg')).toBeNull();
  });

  it('delete is a no-op when the key does not exist', async () => {
    const store = new LocalMediaBlobStore(await root());
    await expect(
      store.delete('media/owner-1/nope/original.jpg'),
    ).resolves.toBeUndefined();
  });

  it('delete removes an existing object', async () => {
    const store = new LocalMediaBlobStore(await root());
    const key = 'media/owner-1/m1/original.png';
    await store.writeBuffer(key, Buffer.from('x'));
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
  });

  it('presignUpload and presignDownload hand back the same-origin dev route path', async () => {
    const store = new LocalMediaBlobStore(await root());
    const key = 'media/owner-1/m1/original.webp';

    const target = await store.presignUpload({ key, contentType: 'image/webp' });
    expect(target).toEqual({
      url: `/dev/media/${key}`,
      method: 'PUT',
      headers: { 'content-type': 'image/webp' },
    });
    expect(await store.presignDownload(key)).toBe(`/dev/media/${key}`);
  });

  it('rejects a key that would escape the storage root', async () => {
    const store = new LocalMediaBlobStore(await root());
    await expect(
      store.writeBuffer('../escaped/original.jpg', Buffer.from('x')),
    ).rejects.toThrow(/Unsafe/);
  });

  it('getMediaBlobStore selects the local adapter when APP_ENV is local and R2 is unconfigured', () => {
    useEnv({
      APP_ENV: 'local',
      DATABASE_URL: undefined,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
    });
    expect(getMediaBlobStore()).toBeInstanceOf(LocalMediaBlobStore);
  });
});

describe('getMediaBlobStore deployed without R2', () => {
  it('returns undefined rather than falling back to the filesystem', () => {
    useEnv({
      APP_ENV: 'production',
      DATABASE_URL: undefined,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
    });
    expect(getMediaBlobStore()).toBeUndefined();
  });
});

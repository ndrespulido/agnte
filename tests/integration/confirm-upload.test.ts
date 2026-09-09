import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import S3rver from 's3rver';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { createPendingMedia } from '@/modules/media/domain/media';
import { MediaErrorCode } from '@/modules/media/domain/errors';
import type { ThumbnailQueue } from '@/modules/media/domain/ports';
import { R2MediaBlobStore } from '@/modules/media/infrastructure/r2-media-blob-store';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';
import { confirmUpload } from '@/modules/media/application/confirm-upload';

/**
 * Against R2MediaBlobStore + s3rver, not the filesystem adapter: the
 * mismatched-content-type case this suite exists to prove can only be
 * produced this way. `LocalMediaBlobStore.head()` derives its content type
 * from the storage key's own extension, which is itself derived from the
 * row's declared content type — the two can never disagree there. s3rver, by
 * contrast, does not enforce the content-type signed into a presigned PUT
 * (see domain/ports.ts's `UploadTarget` doc comment), which is exactly what
 * lets this suite upload something real R2 would likely have rejected and
 * confirm that `confirmUpload` catches it anyway.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const BUCKET = 'agnte-confirm-test';
const PORT = 4571;
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const media = new PrismaMediaRepository();
let server: S3rver;
let directory: string;
let blobStore: R2MediaBlobStore;

class RecordingQueue implements ThumbnailQueue {
  calls: string[] = [];
  async enqueueThumbnailJob(mediaId: string): Promise<void> {
    this.calls.push(mediaId);
  }
}

describe.skipIf(!DATABASE_URL)('confirmUpload against real Postgres and S3', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 's3rver-confirm-'));
    server = new S3rver({
      port: PORT,
      address: '127.0.0.1',
      silent: true,
      directory,
      configureBuckets: [{ name: BUCKET, configs: [] }],
    });
    await server.run();
    blobStore = new R2MediaBlobStore(
      new S3Client({
        region: 'auto',
        endpoint: `http://127.0.0.1:${PORT}`,
        forcePathStyle: true,
        credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
      }),
      BUCKET,
      '',
    );
  }, 30_000);

  afterAll(async () => {
    await server.close();
    await rm(directory, { recursive: true, force: true });
    await getDatabase()?.$disconnect();
  });

  beforeEach(async () => {
    await getDatabase()!.$executeRawUnsafe('DELETE FROM media.media');
  });

  const pendingRow = async () => {
    const row = createPendingMedia({
      ownerId: uuidv7(NOW.getTime()),
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      clock,
    });
    await media.create(row);
    return row;
  };

  it('confirms a matching upload, moves it to processing, and enqueues a thumbnail job', async () => {
    const row = await pendingRow();
    await blobStore.writeBuffer(
      row.storageKey,
      Buffer.from('a real jpeg, promise'),
      'image/jpeg',
    );
    const queue = new RecordingQueue();

    const result = await confirmUpload(
      { ownerId: row.ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore, queue, clock },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('processing');
    expect((await media.findById(row.id))?.status).toBe('processing');
    expect(queue.calls).toEqual([row.id]);
  });

  it('does not fail the confirm when there is no queue configured', async () => {
    const row = await pendingRow();
    await blobStore.writeBuffer(row.storageKey, Buffer.from('bytes'), 'image/jpeg');

    const result = await confirmUpload(
      { ownerId: row.ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore, queue: undefined, clock },
    );

    expect(result.ok).toBe(true);
  });

  it('marks the row failed and refuses when nothing was ever uploaded', async () => {
    const row = await pendingRow();
    const queue = new RecordingQueue();

    const result = await confirmUpload(
      { ownerId: row.ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore, queue, clock },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MediaErrorCode.UploadMismatch);
    expect((await media.findById(row.id))?.status).toBe('failed');
    expect(queue.calls).toEqual([]);
  });

  it('marks the row failed when the real object does not match the declared content type', async () => {
    // The scenario the whole design is about: a presigned PUT signed for
    // image/jpeg, but s3rver does not enforce that header, so a caller can
    // send something else and have it round-trip successfully anyway.
    const row = await pendingRow();
    const target = await blobStore.presignUpload({
      key: row.storageKey,
      contentType: 'image/jpeg',
    });
    const response = await fetch(target.url, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('actually a png'),
    });
    expect(response.ok).toBe(true);

    const result = await confirmUpload(
      { ownerId: row.ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore, queue: new RecordingQueue(), clock },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MediaErrorCode.UploadMismatch);
    expect((await media.findById(row.id))?.status).toBe('failed');
  });

  it('refuses a row that does not belong to the caller, the same as one that does not exist', async () => {
    const row = await pendingRow();
    const result = await confirmUpload(
      { ownerId: uuidv7(NOW.getTime()), mediaId: row.id, expectedVersion: row.version },
      { media, blobStore, queue: new RecordingQueue(), clock },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MediaErrorCode.NotFound);
    // Refused before ever reaching storage or changing status.
    expect((await media.findById(row.id))?.status).toBe('pending');
  });

  it('refuses a row that is not pending', async () => {
    const row = await pendingRow();
    await blobStore.writeBuffer(row.storageKey, Buffer.from('bytes'), 'image/jpeg');
    const first = await confirmUpload(
      { ownerId: row.ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore, queue: new RecordingQueue(), clock },
    );
    expect(first.ok).toBe(true);

    const second = await confirmUpload(
      { ownerId: row.ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore, queue: new RecordingQueue(), clock },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe(MediaErrorCode.NotPending);
  });

  it('answers a version conflict when expectedVersion is stale', async () => {
    const row = await pendingRow();
    await blobStore.writeBuffer(row.storageKey, Buffer.from('bytes'), 'image/jpeg');

    const result = await confirmUpload(
      { ownerId: row.ownerId, mediaId: row.id, expectedVersion: row.version + 5 },
      { media, blobStore, queue: new RecordingQueue(), clock },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MediaErrorCode.VersionConflict);
    // A version conflict is not a mismatch — the row is left exactly where it
    // was, not knocked into `failed`.
    expect((await media.findById(row.id))?.status).toBe('pending');
  });
});

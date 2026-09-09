import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { createPendingMedia } from '@/modules/media/domain/media';
import { MediaErrorCode } from '@/modules/media/domain/errors';
import { LocalMediaBlobStore } from '@/modules/media/infrastructure/local-media-blob-store';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';
import { deleteMedia } from '@/modules/media/application/delete-media';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const media = new PrismaMediaRepository();
let root: string;
let blobStore: LocalMediaBlobStore;

describe.skipIf(!DATABASE_URL)('deleteMedia against real Postgres', () => {
  beforeEach(async () => {
    await getDatabase()!.$executeRawUnsafe('DELETE FROM media.media');
    root = await mkdtemp(join(tmpdir(), 'delete-media-'));
    blobStore = new LocalMediaBlobStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const pendingRow = async (ownerId: string) => {
    const row = createPendingMedia({
      ownerId,
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      clock,
    });
    await media.create(row);
    return row;
  };

  it('removes the row and the original blob', async () => {
    const ownerId = uuidv7(NOW.getTime());
    const row = await pendingRow(ownerId);
    await blobStore.writeBuffer(row.storageKey, Buffer.from('bytes'));

    const result = await deleteMedia(
      { ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore },
    );

    expect(result.ok).toBe(true);
    expect(await media.findById(row.id)).toBe(null);
    expect(await blobStore.head(row.storageKey)).toBe(null);
  });

  it('also removes every variant blob', async () => {
    const ownerId = uuidv7(NOW.getTime());
    const row = await pendingRow(ownerId);
    await blobStore.writeBuffer(row.storageKey, Buffer.from('bytes'));

    const thumbKey = `media/${ownerId}/${row.id}/thumb.jpg`;
    const mediumKey = `media/${ownerId}/${row.id}/medium.jpg`;
    await blobStore.writeBuffer(thumbKey, Buffer.from('thumb'));
    await blobStore.writeBuffer(mediumKey, Buffer.from('medium'));
    await media.createVariant({
      mediaId: row.id,
      kind: 'thumb',
      storageKey: thumbKey,
      width: 256,
      height: 192,
      sizeBytes: 5,
      createdAt: NOW,
    });
    await media.createVariant({
      mediaId: row.id,
      kind: 'medium',
      storageKey: mediumKey,
      width: 1024,
      height: 768,
      sizeBytes: 6,
      createdAt: NOW,
    });

    const result = await deleteMedia(
      { ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore },
    );

    expect(result.ok).toBe(true);
    expect(await blobStore.head(thumbKey)).toBe(null);
    expect(await blobStore.head(mediumKey)).toBe(null);
  });

  it('is a no-op on storage for a key that was never uploaded', async () => {
    const ownerId = uuidv7(NOW.getTime());
    const row = await pendingRow(ownerId);
    // Never written — a pending upload that was abandoned.

    const result = await deleteMedia(
      { ownerId, mediaId: row.id, expectedVersion: row.version },
      { media, blobStore },
    );

    expect(result.ok).toBe(true);
    expect(await media.findById(row.id)).toBe(null);
  });

  it('refuses a media id that does not belong to the caller, same as one that does not exist', async () => {
    const ownerId = uuidv7(NOW.getTime());
    const row = await pendingRow(ownerId);
    await blobStore.writeBuffer(row.storageKey, Buffer.from('bytes'));

    const result = await deleteMedia(
      { ownerId: uuidv7(NOW.getTime()), mediaId: row.id, expectedVersion: row.version },
      { media, blobStore },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MediaErrorCode.NotFound);
    // Nothing touched — the row and its blob are both still there.
    expect(await media.findById(row.id)).not.toBeNull();
    expect(await blobStore.head(row.storageKey)).not.toBeNull();
  });

  it('answers a version conflict rather than deleting on a stale expectedVersion, leaving the blob intact', async () => {
    // The order this function has to get right: touching storage before the
    // version-gated row delete would destroy a still-live row's bytes for a
    // delete that was refused.
    const ownerId = uuidv7(NOW.getTime());
    const row = await pendingRow(ownerId);
    await blobStore.writeBuffer(row.storageKey, Buffer.from('bytes'));

    const result = await deleteMedia(
      { ownerId, mediaId: row.id, expectedVersion: row.version + 1 },
      { media, blobStore },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MediaErrorCode.VersionConflict);
    expect(await media.findById(row.id)).not.toBeNull();
    expect(await blobStore.head(row.storageKey)).not.toBeNull();
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { MediaErrorCode } from '@/modules/media/domain/errors';
import { LocalMediaBlobStore } from '@/modules/media/infrastructure/local-media-blob-store';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';
import { requestUpload } from '@/modules/media/application/request-upload';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const media = new PrismaMediaRepository();
let root: string;
let blobStore: LocalMediaBlobStore;

describe.skipIf(!DATABASE_URL)('requestUpload against real Postgres', () => {
  beforeEach(async () => {
    await getDatabase()!.$executeRawUnsafe('DELETE FROM media.media');
    root = await mkdtemp(join(tmpdir(), 'request-upload-'));
    blobStore = new LocalMediaBlobStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const deps = () => ({ media, blobStore, clock });
  const owner = () => uuidv7(NOW.getTime());

  it('creates a pending row and hands back an upload target for it', async () => {
    const ownerId = owner();
    const result = await requestUpload(
      { ownerId, contentType: 'image/jpeg', declaredSizeBytes: 500_000 },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.media.status).toBe('pending');
    expect(result.value.media.ownerId).toBe(ownerId);
    expect(result.value.upload).toEqual({
      url: `/dev/media/${result.value.media.storageKey}`,
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
    });

    // The row exists the moment this returns — an offline-composed Verse
    // (architecture.md §8.1) needs to be able to reference it immediately.
    expect(await media.findById(result.value.media.id)).toEqual(result.value.media);
  });

  it('uses a client-supplied id rather than minting its own', async () => {
    const id = uuidv7(NOW.getTime());
    const result = await requestUpload(
      { id, ownerId: owner(), contentType: 'image/png', declaredSizeBytes: 500_000 },
      deps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.media.id).toBe(id);
  });

  it('refuses a disallowed content type and creates no row', async () => {
    const ownerId = owner();
    const result = await requestUpload(
      { ownerId, contentType: 'image/heic', declaredSizeBytes: 500_000 },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MediaErrorCode.ContentTypeNotAllowed);
    expect(await media.findManyByIds(ownerId, [])).toEqual([]);
    const rows = await getDatabase()!.$queryRawUnsafe<unknown[]>(
      'SELECT id FROM media.media WHERE owner_id = $1::uuid',
      ownerId,
    );
    expect(rows).toEqual([]);
  });

  it('refuses a declared size over the cap and creates no row', async () => {
    const ownerId = owner();
    const result = await requestUpload(
      { ownerId, contentType: 'image/jpeg', declaredSizeBytes: 20_000_000 },
      deps(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(MediaErrorCode.TooLarge);
    const rows = await getDatabase()!.$queryRawUnsafe<unknown[]>(
      'SELECT id FROM media.media WHERE owner_id = $1::uuid',
      ownerId,
    );
    expect(rows).toEqual([]);
  });
});

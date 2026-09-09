import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { handleThumbnailJob } from '@/modules/media';
import { createPendingMedia, transition } from '@/modules/media/domain/media';
import { resetMediaBlobStoreForTests } from '@/modules/media/infrastructure/blob-store';
import { LocalMediaBlobStore } from '@/modules/media/infrastructure/local-media-blob-store';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';

/**
 * `handleThumbnailJob` end to end: real internal-auth check, real Postgres,
 * real sharp, and — via `getMediaBlobStore()`'s own local-adapter selection —
 * the same `.local-storage/` root the dev route serves from. Keys are
 * namespaced by domain/media.ts's own `originalKeyFor`, which already scopes
 * by owner id, so a fresh random owner per test keeps this out of every other
 * suite's way without needing a separate directory.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const SECRET = 'a'.repeat(32);

const media = new PrismaMediaRepository();
const localStore = new LocalMediaBlobStore();

const ORIGINAL_ENV = { ...process.env };

const useLocalEnv = () => {
  process.env = {
    ...ORIGINAL_ENV,
    DATABASE_URL,
    APP_ENV: 'local',
    INTERNAL_TASKS_SECRET: SECRET,
    R2_ENDPOINT: undefined,
    R2_BUCKET: undefined,
    R2_ACCESS_KEY_ID: undefined,
    R2_SECRET_ACCESS_KEY: undefined,
  };
  resetConfigForTests();
  resetMediaBlobStoreForTests();
};

const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://agnte.test/internal/media/thumbnail', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const written: string[] = [];

describe.skipIf(!DATABASE_URL)('handleThumbnailJob', () => {
  beforeEach(async () => {
    await getDatabase()!.$executeRawUnsafe('DELETE FROM media.media');
    useLocalEnv();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetMediaBlobStoreForTests();
    await Promise.all(written.splice(0).map((key) => localStore.delete(key)));
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const processingMedia = async () => {
    const row = createPendingMedia({
      ownerId: uuidv7(NOW.getTime()),
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      clock,
    });
    await media.create(row);
    const processing = transition(row, 'processing', clock);
    if (!processing.ok) throw new Error('unreachable');
    await media.update(processing.value, row.version);
    return processing.value;
  };

  it('401s without the shared secret', async () => {
    const response = await handleThumbnailJob(request({ mediaId: uuidv7() }));
    expect(response.status).toBe(401);
  });

  it('400s a body that is not a valid mediaId', async () => {
    const response = await handleThumbnailJob(
      request({ mediaId: 'not-a-uuid' }, { authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(400);
  });

  it('503s when media storage is not configured', async () => {
    process.env.APP_ENV = 'production';
    resetConfigForTests();
    resetMediaBlobStoreForTests();

    const response = await handleThumbnailJob(
      request({ mediaId: uuidv7() }, { authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(503);
  });

  it('processes the job and answers 204', async () => {
    const row = await processingMedia();
    written.push(row.storageKey);
    const original = await sharp({
      create: { width: 300, height: 200, channels: 3, background: 'purple' },
    })
      .jpeg()
      .toBuffer();
    await localStore.writeBuffer(row.storageKey, original);

    const response = await handleThumbnailJob(
      request({ mediaId: row.id }, { authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(204);

    const found = await media.findById(row.id);
    expect(found?.status).toBe('ready');

    const variants = await media.variantsFor(row.id);
    expect(variants.map((v) => v.kind).sort()).toEqual(['medium', 'thumb']);
    written.push(...variants.map((v) => v.storageKey));
  });

  it('answers 204 for an unknown mediaId rather than leaking whether it exists', async () => {
    // Same enumeration-avoidance reasoning as verse's 404-for-forbidden — this
    // is Cloud Tasks calling back, not a user probing, but the job's own
    // no-op-on-missing-row behaviour (process-thumbnail.ts) means there is no
    // separate "not found" branch here to answer differently anyway.
    const response = await handleThumbnailJob(
      request({ mediaId: uuidv7() }, { authorization: `Bearer ${SECRET}` }),
    );
    expect(response.status).toBe(204);
  });
});

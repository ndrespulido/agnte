import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { POST as prune } from '@/app/internal/prune/route';
import { createPendingMedia } from '@/modules/media/domain/media';
import { PENDING_UPLOAD_TTL_MS } from '@/modules/media/application/prune-media';
import { prunePendingMedia } from '@/modules/media';
import { LocalMediaBlobStore } from '@/modules/media/infrastructure/local-media-blob-store';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';

/**
 * The sweep that nothing used to call.
 *
 * Every pruner behind this route already existed and was tested in isolation;
 * what was missing was anything invoking them, which is why several of them
 * still carry doc comments saying so. These tests are about the composition —
 * that the route is reachable only with the shared secret, and that a row
 * actually disappears when it runs.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const SECRET = 'f'.repeat(48);
const NOW = new Date('2026-09-09T12:00:00.000Z');

const media = new PrismaMediaRepository();
let storageRoot: string;

const request = (headers: Record<string, string> = {}) =>
  new Request('https://agnte.test/internal/prune', { method: 'POST', headers });

describe.skipIf(!DATABASE_URL)('the scheduled prune', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.INTERNAL_TASKS_SECRET = SECRET;
    resetConfigForTests();

    storageRoot = await mkdtemp(join(tmpdir(), 'prune-'));

    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM media.media');
    await db.$executeRawUnsafe('DELETE FROM platform.idempotency_key');
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    await rm(storageRoot, { recursive: true, force: true });
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  it('refuses without the shared secret', async () => {
    expect((await prune(request())).status).toBe(401);
    expect((await prune(request({ authorization: 'Bearer wrong' }))).status).toBe(401);
  });

  it('reports what it swept from every table', async () => {
    const response = await prune(request({ authorization: `Bearer ${SECRET}` }));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { swept: Record<string, number> };
    // The point is that all seven are wired in — a pruner missing from the
    // route is exactly the failure this whole route exists to fix, and it
    // would otherwise look identical to one that found nothing to do.
    expect(Object.keys(body.swept).sort()).toEqual([
      'abandonedUploads',
      'idempotencyKeys',
      'oauthHandoffs',
      'passwordResetTokens',
      'pendingRegistrations',
      'rateLimitWindows',
      'refreshTokens',
    ]);
  });

  it('deletes an abandoned upload and the bytes it left behind', async () => {
    const ownerId = uuidv7(NOW.getTime());
    const stale = createPendingMedia({
      ownerId,
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      // Created a day and a bit ago: past the window, and long past the five
      // minutes its upload URL was good for.
      clock: fixedClock(new Date(NOW.getTime() - PENDING_UPLOAD_TTL_MS - 60_000)),
    });
    await media.create(stale);

    const blobStore = new LocalMediaBlobStore(storageRoot);
    await blobStore.writeBuffer(stale.storageKey, Buffer.from('abandoned bytes'));

    const swept = await prunePendingMedia(NOW);

    expect(swept).toBe(1);
    expect(await media.findById(stale.id)).toBe(null);
  });

  it('leaves a pending upload that is still within its window', async () => {
    const fresh = createPendingMedia({
      ownerId: uuidv7(NOW.getTime()),
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      clock: fixedClock(new Date(NOW.getTime() - 60_000)),
    });
    await media.create(fresh);

    expect(await prunePendingMedia(NOW)).toBe(0);
    expect(await media.findById(fresh.id)).not.toBeNull();
  });

  it('leaves a ready upload alone however old it is', async () => {
    // The one that would be a disaster: pruning by age without checking
    // status would delete every photo in the app after a day.
    const old = createPendingMedia({
      ownerId: uuidv7(NOW.getTime()),
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      clock: fixedClock(new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000)),
    });
    await media.create(old);
    await getDatabase()!.$executeRawUnsafe(
      `UPDATE media.media SET status = 'ready' WHERE id = '${old.id}'`,
    );

    expect(await prunePendingMedia(NOW)).toBe(0);
    expect((await media.findById(old.id))?.status).toBe('ready');
  });
});

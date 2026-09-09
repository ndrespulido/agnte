import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';
import { createPendingMedia, transition } from '@/modules/media/domain/media';

/**
 * Runs against a real Postgres and skips without one (architecture.md §7.1).
 * The adapters are what unit tests with fakes cannot vouch for: SQL,
 * constraints and the upsert that makes confirming an upload twice safe.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const media = new PrismaMediaRepository();

describe.skipIf(!DATABASE_URL)('media repository against real Postgres', () => {
  beforeEach(async () => {
    // media_variant cascades from media.
    await getDatabase()!.$executeRawUnsafe('DELETE FROM media.media');
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const owner = () => uuidv7(NOW.getTime());

  const pending = (
    ownerId: string,
    overrides: Partial<Parameters<typeof createPendingMedia>[0]> = {},
  ) =>
    createPendingMedia({
      ownerId,
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      clock,
      ...overrides,
    });

  it('round-trips a pending row', async () => {
    const row = pending(owner());
    await media.create(row);
    expect(await media.findById(row.id)).toEqual(row);
  });

  it('returns null for an id that does not exist', async () => {
    expect(await media.findById(uuidv7())).toBe(null);
  });

  it('findManyByIds is scoped to the owner', async () => {
    // The call that turns request-supplied ids into rows for a Verse write —
    // a request naming someone else's media must come back short rather than
    // handing back a row the caller can then act on.
    const mine = pending(owner());
    const theirs = pending(owner());
    await media.create(mine);
    await media.create(theirs);

    const found = await media.findManyByIds(mine.ownerId, [mine.id, theirs.id]);
    expect(found.map((m) => m.id)).toEqual([mine.id]);
  });

  it('findManyByIds given nothing asks the database nothing and returns nothing', async () => {
    expect(await media.findManyByIds(owner(), [])).toEqual([]);
  });

  it('updates only on a matching version, and bumps it', async () => {
    const row = pending(owner());
    await media.create(row);

    const processing = transition(row, 'processing', clock);
    expect(processing.ok).toBe(true);
    if (!processing.ok) return;

    expect(await media.update(processing.value, 0)).toBe(true);
    // The row is at version 1 now; a writer still holding 0 must lose.
    const staleAttempt = transition(row, 'failed', clock);
    if (!staleAttempt.ok) return;
    expect(await media.update(staleAttempt.value, 0)).toBe(false);

    const found = await media.findById(row.id);
    expect(found?.status).toBe('processing');
    expect(found?.version).toBe(1);
  });

  it('deletes only on a matching version', async () => {
    const row = pending(owner());
    await media.create(row);

    expect(await media.delete(row.id, 99)).toBe(false);
    expect(await media.delete(row.id, 0)).toBe(true);
    expect(await media.findById(row.id)).toBe(null);
  });

  describe('variants', () => {
    const variant = (mediaId: string, kind: 'thumb' | 'medium') => ({
      mediaId,
      kind,
      storageKey: `media/o/${mediaId}/${kind}.jpg`,
      width: kind === 'thumb' ? 256 : 1024,
      height: kind === 'thumb' ? 192 : 768,
      sizeBytes: 12_345,
      createdAt: NOW,
    });

    it('round-trips both kinds for one media item', async () => {
      const row = pending(owner());
      await media.create(row);

      await media.createVariant(variant(row.id, 'thumb'));
      await media.createVariant(variant(row.id, 'medium'));

      const found = await media.variantsFor(row.id);
      expect(found.map((v) => v.kind).sort()).toEqual(['medium', 'thumb']);
    });

    it('confirming twice overwrites the variant rather than failing', async () => {
      // A retried "process thumbnails" job (Cloud Tasks at-least-once delivery,
      // or the local queue's own retry) must not fail the second time trying
      // to insert the same (media_id, kind) pair.
      const row = pending(owner());
      await media.create(row);

      await media.createVariant(variant(row.id, 'thumb'));
      const second = { ...variant(row.id, 'thumb'), sizeBytes: 999 };
      await media.createVariant(second);

      const found = await media.variantsFor(row.id);
      expect(found).toHaveLength(1);
      expect(found[0]?.sizeBytes).toBe(999);
    });

    it('variantsForMany batches across several media items', async () => {
      const a = pending(owner());
      const b = pending(owner());
      await media.create(a);
      await media.create(b);
      await media.createVariant(variant(a.id, 'thumb'));
      await media.createVariant(variant(b.id, 'thumb'));
      await media.createVariant(variant(b.id, 'medium'));

      const map = await media.variantsForMany([a.id, b.id]);
      expect(map.get(a.id)?.map((v) => v.kind)).toEqual(['thumb']);
      expect(
        map
          .get(b.id)
          ?.map((v) => v.kind)
          .sort(),
      ).toEqual(['medium', 'thumb']);
    });

    it('variantsForMany given nothing asks the database nothing', async () => {
      expect(await media.variantsForMany([])).toEqual(new Map());
    });

    it('cascades when the media row is deleted', async () => {
      const row = pending(owner());
      await media.create(row);
      await media.createVariant(variant(row.id, 'thumb'));

      await media.delete(row.id, 0);
      expect(await media.variantsFor(row.id)).toEqual([]);
    });
  });
});

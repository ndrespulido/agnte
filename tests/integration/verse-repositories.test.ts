import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { fixedClock, unwrap, uuidv7 } from '@/shared/kernel';
import { PrismaTagRepository } from '@/modules/verse/infrastructure/prisma-tag-repository';
import { PrismaVerseRepository } from '@/modules/verse/infrastructure/prisma-verse-repository';
import { PrismaShareRepository } from '@/modules/verse/infrastructure/prisma-share-repository';
import { createTag } from '@/modules/verse/domain/tag';
import { createVerse } from '@/modules/verse/domain/verse';

/**
 * Runs against a real Postgres and skips without one (architecture.md §7.1).
 * The adapters are exactly what unit tests with fakes cannot vouch for: SQL,
 * constraints, transactions and races.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-08T12:00:00.000Z');
const clock = fixedClock(NOW);

const tags = new PrismaTagRepository();
const verses = new PrismaVerseRepository();
const shares = new PrismaShareRepository();

describe.skipIf(!DATABASE_URL)('verse repositories against real Postgres', () => {
  beforeEach(async () => {
    const db = getDatabase()!;
    // verse_tag, tag_share and verse_share all cascade from these two.
    await db.$executeRawUnsafe('DELETE FROM verse.verse');
    await db.$executeRawUnsafe('DELETE FROM verse.tag');
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const owner = () => uuidv7(NOW.getTime());

  const newTag = (ownerId: string, name: string, overrides = {}) =>
    createTag({ ownerId, name, clock, ...overrides });

  const newVerse = (ownerId: string, tagIds: string[], overrides = {}) =>
    unwrap(createVerse({ ownerId, tagIds, clock, ...overrides }));

  describe('tags', () => {
    it('round-trips every field', async () => {
      const ownerId = owner();
      const tag = newTag(ownerId, 'barcelona-trip', {
        displayName: 'Barcelona Trip',
        visibility: 'shared' as const,
        shortcut: 'b',
        vertical: null,
      });

      expect(await tags.create(tag)).toEqual({ kind: 'created' });

      const found = await tags.findById(tag.id);
      expect(found).toEqual(tag);
    });

    it('tells a name collision from a shortcut collision', async () => {
      // The difference decides which field the user is pointed at, so it has to
      // survive the round trip through the driver's error shape.
      const ownerId = owner();
      await tags.create(newTag(ownerId, 'movies', { shortcut: 'm' }));

      expect(await tags.create(newTag(ownerId, 'movies', { shortcut: 'x' }))).toEqual({
        kind: 'name-taken',
      });
      expect(await tags.create(newTag(ownerId, 'medical', { shortcut: 'm' }))).toEqual({
        kind: 'shortcut-taken',
      });
    });

    it('scopes uniqueness to the owner', async () => {
      // Two people may both have .movies with shortcut .m.
      await tags.create(newTag(owner(), 'movies', { shortcut: 'm' }));
      expect(await tags.create(newTag(owner(), 'movies', { shortcut: 'm' }))).toEqual({
        kind: 'created',
      });
    });

    it('lets many tags have no shortcut', async () => {
      // NULLs are distinct in a Postgres unique index. If they were not, a user
      // could only ever have one shortcut-less tag.
      const ownerId = owner();
      await tags.create(newTag(ownerId, 'a'));
      expect(await tags.create(newTag(ownerId, 'b'))).toEqual({ kind: 'created' });
    });

    it("findManyByIds refuses to return another owner's tag", async () => {
      // This is the call that turns request-supplied ids into tags, so it is
      // the place a request naming someone else's tag has to come up short.
      const mine = newTag(owner(), 'mine');
      const theirs = newTag(owner(), 'theirs');
      await tags.create(mine);
      await tags.create(theirs);

      const found = await tags.findManyByIds(mine.ownerId, [mine.id, theirs.id]);
      expect(found.map((t) => t.id)).toEqual([mine.id]);
    });

    it('reports the shortcuts already taken', async () => {
      const ownerId = owner();
      await tags.create(newTag(ownerId, 'movies', { shortcut: 'm' }));
      await tags.create(newTag(ownerId, 'flights', { shortcut: 'f' }));
      await tags.create(newTag(ownerId, 'plain'));

      expect(await tags.takenShortcuts(ownerId)).toEqual(new Set(['m', 'f']));
    });

    it('updates only on a matching version', async () => {
      const tag = newTag(owner(), 'movies');
      await tags.create(tag);

      expect(await tags.update({ ...tag, name: 'films' }, 0)).toEqual({
        kind: 'updated',
      });
      // The row is at version 1 now; a writer still holding 0 must lose.
      expect(await tags.update({ ...tag, name: 'cinema' }, 0)).toEqual({ kind: 'stale' });

      expect((await tags.findById(tag.id))?.name).toBe('films');
      expect((await tags.findById(tag.id))?.version).toBe(1);
    });
  });

  describe('verses', () => {
    it('round-trips a minimal verse', async () => {
      const ownerId = owner();
      const tag = newTag(ownerId, 'movies');
      await tags.create(tag);

      const verse = newVerse(ownerId, [tag.id]);
      await verses.create(verse);

      expect(await verses.findById(verse.id)).toEqual(verse);
    });

    it('round-trips a full verse, properties and media included', async () => {
      const ownerId = owner();
      const tag = newTag(ownerId, 'flights');
      await tags.create(tag);

      const mediaId = uuidv7(NOW.getTime());
      const verse = newVerse(ownerId, [tag.id], {
        placement: {
          kind: 'range' as const,
          start: new Date('2026-07-01T06:00:00.000Z'),
          end: new Date('2026-07-01T09:30:00.000Z'),
        },
        location: 'Barcelona',
        rating: 7.5,
        xp: 'Delayed but fine.',
        properties: { airline: 'IB', 'flight-number': 'IB6250' },
        visibility: 'private' as const,
        mediaIds: [mediaId],
      });

      await verses.create(verse);
      expect(await verses.findById(verse.id)).toEqual(verse);
    });

    it('stores a deep-time verse with no calendar date', async () => {
      const ownerId = owner();
      const tag = newTag(ownerId, 'prehistory');
      await tags.create(tag);

      const verse = newVerse(ownerId, [tag.id], {
        placement: { kind: 'deep-time' as const, years: -66_000_000 },
      });
      await verses.create(verse);

      const found = await verses.findById(verse.id);
      expect(found?.deepTimeYears).toBe(-66_000_000);
      expect(found?.eventStart).toBe(null);
    });

    it('keeps tag order', async () => {
      const ownerId = owner();
      const a = newTag(ownerId, 'aaa');
      const b = newTag(ownerId, 'bbb');
      const c = newTag(ownerId, 'ccc');
      for (const t of [a, b, c]) await tags.create(t);

      // Deliberately not alphabetical: the order the user attached them in is
      // what has to survive, not whatever the database finds convenient.
      const verse = newVerse(ownerId, [c.id, a.id, b.id]);
      await verses.create(verse);

      expect((await verses.findById(verse.id))?.tagIds).toEqual([c.id, a.id, b.id]);
    });

    it('rolls back the verse when its tag rows cannot be written', async () => {
      // One aggregate, one transaction. A verse row left behind with no tags
      // would violate the rule the schema cannot express.
      const ownerId = owner();
      const missingTag = uuidv7(NOW.getTime());
      const verse = newVerse(ownerId, [missingTag]);

      await expect(verses.create(verse)).rejects.toThrow();
      expect(await verses.findById(verse.id)).toBe(null);
    });

    it('updates only on a matching version, and rewrites the tags', async () => {
      const ownerId = owner();
      const a = newTag(ownerId, 'aaa');
      const b = newTag(ownerId, 'bbb');
      await tags.create(a);
      await tags.create(b);

      const verse = newVerse(ownerId, [a.id]);
      await verses.create(verse);

      const changed = { ...verse, xp: 'now with a note', tagIds: [b.id], version: 1 };
      expect(await verses.update(changed, 0)).toBe(true);

      const found = await verses.findById(verse.id);
      expect(found?.xp).toBe('now with a note');
      expect(found?.tagIds).toEqual([b.id]);
      expect(found?.version).toBe(1);

      // A stale writer must not win, and must not rewrite the tags either.
      expect(await verses.update({ ...verse, tagIds: [a.id] }, 0)).toBe(false);
      expect((await verses.findById(verse.id))?.tagIds).toEqual([b.id]);
    });

    it('deletes only on a matching version', async () => {
      const ownerId = owner();
      const tag = newTag(ownerId, 'movies');
      await tags.create(tag);
      const verse = newVerse(ownerId, [tag.id]);
      await verses.create(verse);

      expect(await verses.delete(verse.id, 99)).toBe(false);
      expect(await verses.delete(verse.id, 0)).toBe(true);
      expect(await verses.findById(verse.id)).toBe(null);
    });

    it('deleting a tag cascades to the join rows', async () => {
      const ownerId = owner();
      const tag = newTag(ownerId, 'movies');
      const other = newTag(ownerId, 'keep');
      await tags.create(tag);
      await tags.create(other);

      const verse = newVerse(ownerId, [tag.id, other.id]);
      await verses.create(verse);

      await tags.delete(tag.id, 0);
      expect((await verses.findById(verse.id))?.tagIds).toEqual([other.id]);
    });

    it('tagsOfMany answers for many verses in one query', async () => {
      const ownerId = owner();
      const a = newTag(ownerId, 'aaa');
      const b = newTag(ownerId, 'bbb');
      await tags.create(a);
      await tags.create(b);

      const one = newVerse(ownerId, [a.id]);
      const two = newVerse(ownerId, [a.id, b.id]);
      await verses.create(one);
      await verses.create(two);

      const map = await verses.tagsOfMany([one.id, two.id]);
      expect(map.get(one.id)?.map((t) => t.id)).toEqual([a.id]);
      expect(map.get(two.id)?.map((t) => t.id)).toEqual([a.id, b.id]);
    });

    it('tagsOfMany given nothing asks the database nothing', async () => {
      expect(await verses.tagsOfMany([])).toEqual(new Map());
    });
  });

  describe('shares', () => {
    it('finds a share reached through the verse itself', async () => {
      const ownerId = owner();
      const viewer = owner();
      const tag = newTag(ownerId, 'movies');
      await tags.create(tag);
      const verse = newVerse(ownerId, [tag.id]);
      await verses.create(verse);

      expect(await shares.viewerHasShare(verse.id, viewer)).toBe(false);

      await shares.shareVerse({
        verseId: verse.id,
        granteeId: viewer,
        permission: 'read',
        createdAt: NOW,
      });
      expect(await shares.viewerHasShare(verse.id, viewer)).toBe(true);
    });

    it('finds a share reached through one of the tags', async () => {
      // The second of the two routes. A check that only looked at verse_share
      // would answer false here and hide a share the user really granted.
      const ownerId = owner();
      const viewer = owner();
      const tag = newTag(ownerId, 'barcelona-trip');
      await tags.create(tag);
      const verse = newVerse(ownerId, [tag.id]);
      await verses.create(verse);

      await shares.shareTag({
        tagId: tag.id,
        granteeId: viewer,
        permission: 'read',
        createdAt: NOW,
      });
      expect(await shares.viewerHasShare(verse.id, viewer)).toBe(true);
    });

    it("does not leak one viewer's share to another", async () => {
      const ownerId = owner();
      const invited = owner();
      const stranger = owner();
      const tag = newTag(ownerId, 'movies');
      await tags.create(tag);
      const verse = newVerse(ownerId, [tag.id]);
      await verses.create(verse);

      await shares.shareTag({
        tagId: tag.id,
        granteeId: invited,
        permission: 'read',
        createdAt: NOW,
      });

      expect(await shares.viewerHasShare(verse.id, invited)).toBe(true);
      expect(await shares.viewerHasShare(verse.id, stranger)).toBe(false);
    });

    it('re-sharing updates the permission rather than failing', async () => {
      const ownerId = owner();
      const viewer = owner();
      const tag = newTag(ownerId, 'movies');
      await tags.create(tag);

      const share = {
        tagId: tag.id,
        granteeId: viewer,
        permission: 'read' as const,
        createdAt: NOW,
      };
      await shares.shareTag(share);
      await shares.shareTag({ ...share, permission: 'contribute' });

      const listed = await shares.listTagShares(tag.id);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.permission).toBe('contribute');
    });

    it('viewerSharesFor answers for a page of verses at once', async () => {
      const ownerId = owner();
      const viewer = owner();
      const shared = newTag(ownerId, 'shared-tag');
      const secret = newTag(ownerId, 'secret-tag');
      await tags.create(shared);
      await tags.create(secret);

      const visible = newVerse(ownerId, [shared.id]);
      const hidden = newVerse(ownerId, [secret.id]);
      await verses.create(visible);
      await verses.create(hidden);

      await shares.shareTag({
        tagId: shared.id,
        granteeId: viewer,
        permission: 'read',
        createdAt: NOW,
      });

      const reachable = await shares.viewerSharesFor([visible.id, hidden.id], viewer);
      expect(reachable).toEqual(new Set([visible.id]));
    });

    it('unsharing revokes both routes independently', async () => {
      const ownerId = owner();
      const viewer = owner();
      const tag = newTag(ownerId, 'movies');
      await tags.create(tag);
      const verse = newVerse(ownerId, [tag.id]);
      await verses.create(verse);

      await shares.shareTag({
        tagId: tag.id,
        granteeId: viewer,
        permission: 'read',
        createdAt: NOW,
      });
      await shares.shareVerse({
        verseId: verse.id,
        granteeId: viewer,
        permission: 'read',
        createdAt: NOW,
      });

      await shares.unshareTag(tag.id, viewer);
      // Still reachable: the verse-level share is a separate grant.
      expect(await shares.viewerHasShare(verse.id, viewer)).toBe(true);

      await shares.unshareVerse(verse.id, viewer);
      expect(await shares.viewerHasShare(verse.id, viewer)).toBe(false);
    });
  });
});

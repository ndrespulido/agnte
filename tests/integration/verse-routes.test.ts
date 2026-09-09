import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import {
  handleCreateTag,
  handleCreateVerse,
  handleDeleteVerse,
  handleGetVerse,
  handleUpdateVerse,
} from '@/modules/verse';
import { PrismaShareRepository } from '@/modules/verse/infrastructure/prisma-share-repository';
import { createPendingMedia, transition } from '@/modules/media/domain/media';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';

/**
 * The verse endpoints end to end. The visibility cases are the point: this is
 * where a resolver bug would actually disclose something.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const PASSWORD = 'a sufficiently long password';

let emailed: string[] = [];
let ipCounter = 0;
const freshIp = () => `192.0.2.${(ipCounter += 1) % 250}`;

const json = (
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe.skipIf(!DATABASE_URL)('verse routes', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'b'.repeat(64);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    resetConfigForTests();
    resetEmailTransportForTests();

    emailed = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      emailed.push(args.join(' '));
    });

    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM verse.verse');
    await db.$executeRawUnsafe('DELETE FROM verse.tag');
    await db.$executeRawUnsafe('DELETE FROM media.media');
    await db.$executeRawUnsafe('DELETE FROM identity.refresh_token');
    await db.$executeRawUnsafe('DELETE FROM identity.pending_registration');
    await db.$executeRawUnsafe('DELETE FROM identity."user"');
    await db.$executeRawUnsafe('DELETE FROM platform.rate_limit_window');
    await db.$executeRawUnsafe('DELETE FROM platform.idempotency_key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetEmailTransportForTests();
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  async function signUp(email: string): Promise<{ token: string; userId: string }> {
    const ip = freshIp();
    await handleRegister(
      json(
        'POST',
        'https://agnte.test/v1/auth/register',
        { email, password: PASSWORD },
        {
          'x-forwarded-for': ip,
        },
      ),
    );

    const match = (emailed.at(-1) ?? '').match(/verify-email\?token=([^\s]+)/);
    if (!match?.[1]) throw new Error('no verification link');

    const verified = await handleVerifyEmail(
      new Request(`https://agnte.test/v1/auth/verify-email?token=${match[1]}`),
    );
    const user = (await verified.json()) as { user: { id: string } };

    const logged = await handleLogin(
      json(
        'POST',
        'https://agnte.test/v1/auth/login',
        { email, password: PASSWORD },
        {
          'x-forwarded-for': ip,
        },
      ),
    );
    const tokens = (await logged.json()) as { accessToken: string };

    return { token: tokens.accessToken, userId: user.user.id };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const makeTag = async (token: string, name: string, visibility?: string) => {
    const response = await handleCreateTag(
      json(
        'POST',
        'https://agnte.test/v1/tags',
        visibility === undefined ? { name } : { name, visibility },
        bearer(token),
      ),
    );
    return (await response.json()) as { id: string };
  };

  const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    handleCreateVerse(
      json('POST', 'https://agnte.test/v1/verses', body, {
        ...bearer(token),
        ...headers,
      }),
    );

  const get = (token: string, id: string) =>
    handleGetVerse(
      new Request(`https://agnte.test/v1/verses/${id}`, { headers: bearer(token) }),
      id,
    );

  const patch = (token: string, id: string, body: unknown) =>
    handleUpdateVerse(
      json('PATCH', `https://agnte.test/v1/verses/${id}`, body, bearer(token)),
      id,
    );

  /**
   * A `ready` Media row with both variants, created directly through the
   * repository — the same shortcut tests/integration/search.test.ts takes —
   * rather than a full request-upload/confirm/thumbnail round trip these
   * tests have no other reason to exercise.
   */
  const readyMedia = async (ownerId: string): Promise<string> => {
    const media = new PrismaMediaRepository();
    const clock = fixedClock(new Date());

    const pending = createPendingMedia({
      ownerId,
      contentType: 'image/jpeg',
      declaredSizeBytes: 400_000,
      clock,
    });
    await media.create(pending);

    const processing = transition(pending, 'processing', clock);
    if (!processing.ok) throw new Error('unreachable');
    await media.update(processing.value, pending.version);

    const ready = transition(processing.value, 'ready', clock);
    if (!ready.ok) throw new Error('unreachable');
    await media.update(ready.value, processing.value.version);

    await media.createVariant({
      mediaId: pending.id,
      kind: 'thumb',
      storageKey: `media/${ownerId}/${pending.id}/thumb.jpg`,
      width: 256,
      height: 192,
      sizeBytes: 111,
      createdAt: new Date(),
    });
    await media.createVariant({
      mediaId: pending.id,
      kind: 'medium',
      storageKey: `media/${ownerId}/${pending.id}/medium.jpg`,
      width: 1024,
      height: 768,
      sizeBytes: 222,
      createdAt: new Date(),
    });

    return pending.id;
  };

  describe('creating', () => {
    it('accepts a minimal verse: one tag, nothing else', async () => {
      const { token } = await signUp('a@example.com');
      const tag = await makeTag(token, 'movies');

      const response = await post(token, { tagIds: [tag.id] });
      expect(response.status).toBe(201);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ xp: null, rating: null, location: null, version: 0 });
      expect(body.tags).toHaveLength(1);
    });

    it('stores a full verse and returns the resolved visibility', async () => {
      const { token } = await signUp('b@example.com');
      const tag = await makeTag(token, 'flights');

      const body = (await (
        await post(token, {
          tagIds: [tag.id],
          eventStart: '2026-07-01T06:00:00.000Z',
          eventEnd: '2026-07-01T09:30:00.000Z',
          location: 'Barcelona',
          rating: 7.5,
          xp: 'Delayed but fine.',
          properties: { airline: 'IB', 'Flight Number': 'IB6250' },
        })
      ).json()) as Record<string, unknown>;

      expect(body).toMatchObject({
        location: 'Barcelona',
        rating: 7.5,
        // The property key is normalised the way tag names are.
        properties: { airline: 'IB', 'flight-number': 'IB6250' },
        visibility: 'private',
        explicitVisibility: null,
      });
    });

    it('refuses a verse with no tags', async () => {
      const { token } = await signUp('c@example.com');
      const response = await post(token, { tagIds: [] });

      // 422 with a specific code, not a bare 400 — and the same answer the
      // update path gives for the same mistake.
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'verse.no_tags' } });
    });

    it("refuses another user's tag with 404, not by silently dropping it", async () => {
      const mine = await signUp('d@example.com');
      const theirs = await signUp('e@example.com');
      const theirTag = await makeTag(theirs.token, 'secret');

      const response = await post(mine.token, { tagIds: [theirTag.id] });
      expect(response.status).toBe(404);
    });

    it("refuses another user's media with 404, not by silently dropping it", async () => {
      // The gap CLAUDE.md's Visibility section warns about: mediaIds used to
      // be accepted with no ownership check at all, which meant a verse could
      // end up pointing at whatever id was sent, real or not, someone else's
      // or not.
      const mine = await signUp('aa@example.com');
      const theirs = await signUp('ab@example.com');
      const tag = await makeTag(mine.token, 'holiday');
      const theirMedia = createPendingMedia({
        ownerId: theirs.userId,
        contentType: 'image/jpeg',
        declaredSizeBytes: 400_000,
        clock: fixedClock(new Date()),
      });
      await new PrismaMediaRepository().create(theirMedia);

      const response = await post(mine.token, {
        tagIds: [tag.id],
        mediaIds: [theirMedia.id],
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: { code: 'verse.media_not_found' },
      });
    });

    it('refuses a calendar date and deep time together', async () => {
      const { token } = await signUp('f@example.com');
      const tag = await makeTag(token, 'prehistory');

      const response = await post(token, {
        tagIds: [tag.id],
        eventStart: '2026-07-01T06:00:00.000Z',
        deepTimeYears: -66_000_000,
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: 'verse.time_conflict' },
      });
    });

    it('refuses an unparseable date rather than storing no date', async () => {
      const { token } = await signUp('g@example.com');
      const tag = await makeTag(token, 'movies');

      const response = await post(token, {
        tagIds: [tag.id],
        eventStart: 'last tuesday',
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: 'verse.date_invalid' },
      });
    });

    it('accepts a deep-time verse', async () => {
      const { token } = await signUp('h@example.com');
      const tag = await makeTag(token, 'prehistory');

      const body = (await (
        await post(token, { tagIds: [tag.id], deepTimeYears: -66_000_000 })
      ).json()) as Record<string, unknown>;

      expect(body).toMatchObject({ deepTimeYears: -66_000_000, eventStart: null });
    });

    it('accepts a client-generated id', async () => {
      const { token } = await signUp('i@example.com');
      const tag = await makeTag(token, 'movies');
      const id = uuidv7();

      const body = (await (await post(token, { tagIds: [tag.id], id })).json()) as {
        id: string;
      };
      expect(body.id).toBe(id);
    });

    it('replays an idempotent retry instead of creating twice', async () => {
      const { token } = await signUp('j@example.com');
      const tag = await makeTag(token, 'movies');
      const key = { 'idempotency-key': 'verse-key-1' };

      const first = (await (await post(token, { tagIds: [tag.id] }, key)).json()) as {
        id: string;
      };
      const second = await post(token, { tagIds: [tag.id] }, key);

      expect(second.headers.get('idempotent-replay')).toBe('true');
      expect((await second.json()) as { id: string }).toMatchObject({ id: first.id });
    });
  });

  describe('visibility', () => {
    it('a stranger cannot read a private verse', async () => {
      const mine = await signUp('k@example.com');
      const stranger = await signUp('l@example.com');
      const tag = await makeTag(mine.token, 'movies');

      const created = (await (await post(mine.token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };

      expect((await get(mine.token, created.id)).status).toBe(200);
      // 404 rather than 403: a 403 would confirm the id is real.
      expect((await get(stranger.token, created.id)).status).toBe(404);
    });

    it('a public tag makes its verses readable', async () => {
      const mine = await signUp('m@example.com');
      const stranger = await signUp('n@example.com');
      const tag = await makeTag(mine.token, 'blog', 'public');

      const created = (await (await post(mine.token, { tagIds: [tag.id] })).json()) as {
        id: string;
        visibility: string;
      };

      expect(created.visibility).toBe('public');
      expect((await get(stranger.token, created.id)).status).toBe(200);
    });

    it('one private tag buries a public one', async () => {
      // The mis-tag case CLAUDE.md names, through the whole stack: a scan
      // tagged .holiday because it was taken on the trip must not become
      // public because .holiday is.
      const mine = await signUp('o@example.com');
      const stranger = await signUp('p@example.com');
      const holiday = await makeTag(mine.token, 'holiday', 'public');
      const medical = await makeTag(mine.token, 'medical', 'private');

      const created = (await (
        await post(mine.token, { tagIds: [holiday.id, medical.id] })
      ).json()) as { id: string; visibility: string };

      expect(created.visibility).toBe('private');
      expect((await get(stranger.token, created.id)).status).toBe(404);
    });

    it('an explicit private setting beats a public tag', async () => {
      const mine = await signUp('q@example.com');
      const stranger = await signUp('r@example.com');
      const tag = await makeTag(mine.token, 'blog', 'public');

      const created = (await (
        await post(mine.token, { tagIds: [tag.id], visibility: 'private' })
      ).json()) as { id: string; visibility: string };

      expect(created.visibility).toBe('private');
      expect((await get(stranger.token, created.id)).status).toBe(404);
    });

    it('a shared tag is not readable without an actual share', async () => {
      const mine = await signUp('s@example.com');
      const stranger = await signUp('t@example.com');
      const tag = await makeTag(mine.token, 'trip', 'shared');

      const created = (await (await post(mine.token, { tagIds: [tag.id] })).json()) as {
        id: string;
        visibility: string;
      };

      expect(created.visibility).toBe('shared');
      // "shared" means shared with named people, not with anyone signed in.
      expect((await get(stranger.token, created.id)).status).toBe(404);
    });

    it('a shared tag is readable by someone it was shared with', async () => {
      const mine = await signUp('u@example.com');
      const friend = await signUp('v@example.com');
      const tag = await makeTag(mine.token, 'trip', 'shared');

      const created = (await (await post(mine.token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };

      await new PrismaShareRepository().shareTag({
        tagId: tag.id,
        granteeId: friend.userId,
        permission: 'read',
        createdAt: new Date(),
      });

      expect((await get(friend.token, created.id)).status).toBe(200);
    });

    it("resolves a shared verse's media using the owner's id, not the viewer's", async () => {
      // The whole point of the design: media has no visibility of its own
      // (CLAUDE.md), so a viewer who can read this verse only through a
      // share must still see the owner's media resolve — if this code
      // mistakenly asked media using the *viewer's* id instead, `friend`
      // owns no media at all and the result would come back empty.
      const mine = await signUp('ac@example.com');
      const friend = await signUp('ad@example.com');
      const tag = await makeTag(mine.token, 'trip', 'shared');
      const mediaId = await readyMedia(mine.userId);

      const created = (await (
        await post(mine.token, { tagIds: [tag.id], mediaIds: [mediaId] })
      ).json()) as { id: string };

      await new PrismaShareRepository().shareTag({
        tagId: tag.id,
        granteeId: friend.userId,
        permission: 'read',
        createdAt: new Date(),
      });

      const response = await get(friend.token, created.id);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        media: { id: string; status: string; thumbUrl: string | null }[];
      };
      expect(body.media).toHaveLength(1);
      expect(body.media[0]).toMatchObject({ id: mediaId, status: 'ready' });
      expect(body.media[0]?.thumbUrl).toBe(
        `/dev/media/media/${mine.userId}/${mediaId}/thumb.jpg`,
      );
    });

    it('a share does not open a verse a second tag made private', async () => {
      const mine = await signUp('w@example.com');
      const friend = await signUp('x@example.com');
      const trip = await makeTag(mine.token, 'trip', 'shared');
      const medical = await makeTag(mine.token, 'medical', 'private');

      const created = (await (
        await post(mine.token, { tagIds: [trip.id, medical.id] })
      ).json()) as { id: string };

      await new PrismaShareRepository().shareTag({
        tagId: trip.id,
        granteeId: friend.userId,
        permission: 'read',
        createdAt: new Date(),
      });

      expect((await get(friend.token, created.id)).status).toBe(404);
    });

    it('making a tag private later hides verses that inherited from it', async () => {
      // Why `visibility` stays null on the row instead of being resolved at
      // write time: a resolved column would still say public here.
      const mine = await signUp('y@example.com');
      const stranger = await signUp('z@example.com');
      const tag = await makeTag(mine.token, 'blog', 'public');

      const created = (await (await post(mine.token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };
      expect((await get(stranger.token, created.id)).status).toBe(200);

      const { handleUpdateTag } = await import('@/modules/verse');
      await handleUpdateTag(
        json(
          'PATCH',
          `https://agnte.test/v1/tags/${tag.id}`,
          { visibility: 'private', expectedVersion: 0 },
          bearer(mine.token),
        ),
        tag.id,
      );

      expect((await get(stranger.token, created.id)).status).toBe(404);
    });
  });

  describe('updating', () => {
    it('updates on a matching version and bumps it', async () => {
      const { token } = await signUp('aa@example.com');
      const tag = await makeTag(token, 'movies');
      const created = (await (await post(token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };

      const response = await patch(token, created.id, { xp: 'good', expectedVersion: 0 });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ xp: 'good', version: 1 });
    });

    it('answers 409 with the server version when stale', async () => {
      const { token } = await signUp('ab@example.com');
      const tag = await makeTag(token, 'movies');
      const created = (await (await post(token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };

      await patch(token, created.id, { xp: 'first', expectedVersion: 0 });
      const stale = await patch(token, created.id, { xp: 'second', expectedVersion: 0 });

      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: { code: 'verse.version_conflict', details: { expected: 0, actual: 1 } },
      });
    });

    it('clears a field with null and leaves it alone when absent', async () => {
      const { token } = await signUp('ac@example.com');
      const tag = await makeTag(token, 'movies');
      const created = (await (
        await post(token, { tagIds: [tag.id], rating: 8, xp: 'note' })
      ).json()) as { id: string };

      const untouched = (await (
        await patch(token, created.id, { xp: 'other', expectedVersion: 0 })
      ).json()) as { rating: number | null };
      expect(untouched.rating).toBe(8);

      const cleared = (await (
        await patch(token, created.id, { rating: null, expectedVersion: 1 })
      ).json()) as { rating: number | null };
      expect(cleared.rating).toBe(null);
    });

    it('refuses to leave a verse with no tags', async () => {
      const { token } = await signUp('ad@example.com');
      const tag = await makeTag(token, 'movies');
      const created = (await (await post(token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };

      const response = await patch(token, created.id, { tagIds: [], expectedVersion: 0 });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: 'verse.no_tags' } });
    });

    it("answers 404 for another user's verse", async () => {
      const mine = await signUp('ae@example.com');
      const theirs = await signUp('af@example.com');
      const tag = await makeTag(theirs.token, 'secret');
      const created = (await (await post(theirs.token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };

      expect(
        (await patch(mine.token, created.id, { xp: 'mine now', expectedVersion: 0 }))
          .status,
      ).toBe(404);
    });
  });

  describe('deleting', () => {
    it('deletes on a matching version', async () => {
      const { token } = await signUp('ag@example.com');
      const tag = await makeTag(token, 'movies');
      const created = (await (await post(token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };

      const response = await handleDeleteVerse(
        new Request(`https://agnte.test/v1/verses/${created.id}?expectedVersion=0`, {
          method: 'DELETE',
          headers: bearer(token),
        }),
        created.id,
      );

      expect(response.status).toBe(204);
      expect((await get(token, created.id)).status).toBe(404);
    });

    it('refuses a missing expectedVersion rather than reading it as 0', async () => {
      const { token } = await signUp('ah@example.com');
      const tag = await makeTag(token, 'movies');
      const created = (await (await post(token, { tagIds: [tag.id] })).json()) as {
        id: string;
      };

      const response = await handleDeleteVerse(
        new Request(`https://agnte.test/v1/verses/${created.id}`, {
          method: 'DELETE',
          headers: bearer(token),
        }),
        created.id,
      );

      expect(response.status).toBe(400);
      expect((await get(token, created.id)).status).toBe(200);
    });
  });
});

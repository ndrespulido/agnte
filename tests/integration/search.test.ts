import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { systemClock } from '@/shared/kernel';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import { createPendingMedia } from '@/modules/media/domain/media';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';
import {
  handleCreateTag,
  handleCreateVerse,
  handleSearch,
  handleUpdateTag,
  handleUpdateVerse,
} from '@/modules/verse';

/**
 * Search: what it finds, how it ranks, how the filters compose, and — the part
 * §8.2 warns about — that it is filtered by the same visibility rule as
 * everything else rather than by a bespoke fast query.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const PASSWORD = 'a sufficiently long password';

let emailed: string[] = [];
let ipCounter = 0;
const freshIp = () => `198.51.0.${(ipCounter += 1) % 250}`;

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

describe.skipIf(!DATABASE_URL)('search', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'e'.repeat(64);
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

  async function signUp(email: string) {
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

  const makeVerse = async (token: string, body: Record<string, unknown>) => {
    const response = await handleCreateVerse(
      json('POST', 'https://agnte.test/v1/verses', body, bearer(token)),
    );
    if (response.status !== 201) {
      throw new Error(`create failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as { id: string };
  };

  const search = async (token: string, query: string) => {
    const response = await handleSearch(
      new Request(`https://agnte.test/v1/search${query}`, { headers: bearer(token) }),
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        verses: { id: string; xp: string | null; rank: number }[];
        nextCursor: string | null;
      },
    };
  };

  describe('finding', () => {
    it('finds a verse by a word in its xp', async () => {
      const { token } = await signUp('a@example.com');
      const tag = await makeTag(token, 'diary');
      await makeVerse(token, { tagIds: [tag.id], xp: 'Dinner in Barcelona was good' });
      await makeVerse(token, { tagIds: [tag.id], xp: 'Nothing to report' });

      const { body } = await search(token, '?q=barcelona');
      expect(body.verses.map((v) => v.xp)).toEqual(['Dinner in Barcelona was good']);
    });

    it('finds a verse by a property value', async () => {
      const { token } = await signUp('b@example.com');
      const tag = await makeTag(token, 'flights');
      await makeVerse(token, {
        tagIds: [tag.id],
        properties: { airline: 'Iberia', 'flight-number': 'IB6250' },
        xp: 'nothing notable',
      });

      expect((await search(token, '?q=Iberia')).body.verses).toHaveLength(1);
      expect((await search(token, '?q=IB6250')).body.verses).toHaveLength(1);
    });

    it('finds a verse by the name of a tag it carries', async () => {
      const { token } = await signUp('c@example.com');
      const tag = await makeTag(token, 'barcelona-trip');
      await makeVerse(token, { tagIds: [tag.id] });

      // Hyphens are split into words, so the tag is findable by either half
      // rather than only by its exact full name.
      expect((await search(token, '?q=barcelona')).body.verses).toHaveLength(1);
      expect((await search(token, '?q=trip')).body.verses).toHaveLength(1);
    });

    it('ranks a mention in xp above a mere tag name', async () => {
      const { token } = await signUp('d@example.com');
      const named = await makeTag(token, 'barcelona-trip');
      const plain = await makeTag(token, 'diary');

      await makeVerse(token, { tagIds: [named.id], xp: 'nothing about the city here' });
      const written = await makeVerse(token, {
        tagIds: [plain.id],
        xp: 'Barcelona was the best part',
      });

      const { body } = await search(token, '?q=barcelona');
      expect(body.verses[0]?.id).toBe(written.id);
      expect(body.verses).toHaveLength(2);
    });

    it('is case-insensitive', async () => {
      const { token } = await signUp('e@example.com');
      const tag = await makeTag(token, 'diary');
      await makeVerse(token, { tagIds: [tag.id], xp: 'BARCELONA' });

      expect((await search(token, '?q=barcelona')).body.verses).toHaveLength(1);
    });

    it('handles a quoted phrase and an exclusion', async () => {
      const { token } = await signUp('f@example.com');
      const tag = await makeTag(token, 'diary');
      await makeVerse(token, { tagIds: [tag.id], xp: 'the red bus', id: undefined });
      await makeVerse(token, { tagIds: [tag.id], xp: 'a red car' });

      expect(
        (await search(token, `?q=${encodeURIComponent('"red bus"')}`)).body.verses,
      ).toHaveLength(1);
      expect(
        (await search(token, `?q=${encodeURIComponent('red -car')}`)).body.verses,
      ).toHaveLength(1);
    });

    it('does not blow up on syntax a person might type', async () => {
      // websearch_to_tsquery never raises; to_tsquery would turn a stray
      // ampersand into a 500.
      const { token } = await signUp('g@example.com');
      for (const q of ['&', '|', '!', '(((', 'a & & b', '"unclosed']) {
        const { status } = await search(token, `?q=${encodeURIComponent(q)}`);
        expect(status).toBe(200);
      }
    });

    it('refuses an empty or missing query', async () => {
      const { token } = await signUp('h@example.com');
      expect((await search(token, '')).status).toBe(400);
      expect((await search(token, '?q=%20%20')).status).toBe(422);
    });
  });

  describe('staying in sync', () => {
    it('reflects an edited xp', async () => {
      const { token } = await signUp('i@example.com');
      const tag = await makeTag(token, 'diary');
      const verse = await makeVerse(token, { tagIds: [tag.id], xp: 'about lisbon' });

      expect((await search(token, '?q=lisbon')).body.verses).toHaveLength(1);

      await handleUpdateVerse(
        json(
          'PATCH',
          `https://agnte.test/v1/verses/${verse.id}`,
          { xp: 'about porto', expectedVersion: 0 },
          bearer(token),
        ),
        verse.id,
      );

      expect((await search(token, '?q=lisbon')).body.verses).toHaveLength(0);
      expect((await search(token, '?q=porto')).body.verses).toHaveLength(1);
    });

    it('follows a renamed tag', async () => {
      // The denormalisation the vector carries is only correct if something
      // maintains it. This is that something being tested.
      const { token } = await signUp('j@example.com');
      const tag = await makeTag(token, 'movies');
      await makeVerse(token, { tagIds: [tag.id] });

      expect((await search(token, '?q=movies')).body.verses).toHaveLength(1);

      await handleUpdateTag(
        json(
          'PATCH',
          `https://agnte.test/v1/tags/${tag.id}`,
          { name: 'films', expectedVersion: 0 },
          bearer(token),
        ),
        tag.id,
      );

      expect((await search(token, '?q=movies')).body.verses).toHaveLength(0);
      expect((await search(token, '?q=films')).body.verses).toHaveLength(1);
    });
  });

  describe('filters', () => {
    // Search's write-side validation (write-verse.ts's assertOwnedMedia) now
    // refuses a mediaId that is not a real, owned Media row, so this needs an
    // actual one rather than a made-up uuid — created directly through the
    // repository, the same way tests/integration/media-repository.test.ts
    // does, rather than a full request-upload/confirm round trip this filter
    // test has no other reason to exercise.
    const media = new PrismaMediaRepository();

    const setup = async (token: string, ownerId: string) => {
      const trip = await makeTag(token, 'trip');
      const food = await makeTag(token, 'food');

      const attached = createPendingMedia({
        ownerId,
        contentType: 'image/jpeg',
        declaredSizeBytes: 400_000,
        clock: systemClock,
      });
      await media.create(attached);

      await makeVerse(token, {
        tagIds: [trip.id],
        xp: 'paella somewhere',
        rating: 3,
        eventStart: '2024-01-01T00:00:00Z',
      });
      await makeVerse(token, {
        tagIds: [trip.id, food.id],
        xp: 'paella by the sea',
        rating: 9,
        eventStart: '2025-06-01T00:00:00Z',
        mediaIds: [attached.id],
      });

      return { trip, food };
    };

    it('filters by rating', async () => {
      const { token, userId } = await signUp('k@example.com');
      await setup(token, userId);

      expect((await search(token, '?q=paella')).body.verses).toHaveLength(2);
      expect(
        (await search(token, '?q=paella&ratingAtLeast=5')).body.verses.map((v) => v.xp),
      ).toEqual(['paella by the sea']);
    });

    it('filters by date range', async () => {
      const { token, userId } = await signUp('l@example.com');
      await setup(token, userId);

      const { body } = await search(token, '?q=paella&from=2025-01-01T00:00:00Z');
      expect(body.verses.map((v) => v.xp)).toEqual(['paella by the sea']);

      const older = await search(token, '?q=paella&to=2024-06-01T00:00:00Z');
      expect(older.body.verses.map((v) => v.xp)).toEqual(['paella somewhere']);
    });

    it('filters by has-media, both ways', async () => {
      const { token, userId } = await signUp('m@example.com');
      await setup(token, userId);

      expect(
        (await search(token, '?q=paella&hasMedia=true')).body.verses.map((v) => v.xp),
      ).toEqual(['paella by the sea']);

      // ?hasMedia=false means "only ones without", not "no filter".
      expect(
        (await search(token, '?q=paella&hasMedia=false')).body.verses.map((v) => v.xp),
      ).toEqual(['paella somewhere']);
    });

    it('filters by tag, and by all tags together', async () => {
      const { token, userId } = await signUp('n@example.com');
      const { trip, food } = await setup(token, userId);

      expect((await search(token, `?q=paella&tag=${trip.id}`)).body.verses).toHaveLength(
        2,
      );
      expect(
        (
          await search(token, `?q=paella&tag=${trip.id}&tag=${food.id}&match=all`)
        ).body.verses.map((v) => v.xp),
      ).toEqual(['paella by the sea']);
    });

    it('refuses a malformed filter rather than ignoring it', async () => {
      const { token } = await signUp('o@example.com');
      expect((await search(token, '?q=x&from=last-tuesday')).status).toBe(400);
      expect((await search(token, '?q=x&ratingAtLeast=high')).status).toBe(400);
      expect((await search(token, '?q=x&limit=0')).status).toBe(400);
    });
  });

  describe('scope and visibility', () => {
    it("never returns another user's verse", async () => {
      const mine = await signUp('p@example.com');
      const theirs = await signUp('q@example.com');

      const theirTag = await makeTag(theirs.token, 'diary');
      await makeVerse(theirs.token, {
        tagIds: [theirTag.id],
        xp: 'a secret about barcelona',
      });

      const myTag = await makeTag(mine.token, 'diary');
      await makeVerse(mine.token, { tagIds: [myTag.id], xp: 'my own barcelona note' });

      const { body } = await search(mine.token, '?q=barcelona');
      expect(body.verses.map((v) => v.xp)).toEqual(['my own barcelona note']);
    });

    it("never returns another user's PUBLIC verse either", async () => {
      // The discriminating case. A private verse is dropped by the visibility
      // resolver whether or not the query scopes by owner, so a test using one
      // proves nothing about the scoping — removing the owner filter entirely
      // left that test passing. A public verse is readable by anyone, so only
      // the owner filter keeps it out of *my* search of *my* verses.
      const mine = await signUp('p2@example.com');
      const theirs = await signUp('q2@example.com');

      const theirTag = await makeTag(theirs.token, 'blog', 'public');
      await makeVerse(theirs.token, {
        tagIds: [theirTag.id],
        xp: 'a public barcelona post',
      });

      const myTag = await makeTag(mine.token, 'diary');
      await makeVerse(mine.token, { tagIds: [myTag.id], xp: 'my own barcelona note' });

      const { body } = await search(mine.token, '?q=barcelona');
      expect(body.verses.map((v) => v.xp)).toEqual(['my own barcelona note']);
    });

    it('runs results through the same visibility resolver', async () => {
      // §8.2 calls search the most likely place for a disclosure bug. The
      // owner searching their own verses must still get them; the point is
      // that the rows go through visibleMany rather than around it.
      const { token } = await signUp('r@example.com');
      const medical = await makeTag(token, 'medical', 'private');
      await makeVerse(token, { tagIds: [medical.id], xp: 'barcelona clinic' });

      expect((await search(token, '?q=barcelona')).body.verses).toHaveLength(1);
    });
  });

  describe('paging', () => {
    it('pages by relevance without repeating a row', async () => {
      const { token } = await signUp('s@example.com');
      const tag = await makeTag(token, 'diary');

      for (let i = 0; i < 7; i += 1) {
        await makeVerse(token, { tagIds: [tag.id], xp: `barcelona note ${i}` });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const query: string =
          '?q=barcelona&limit=2' +
          (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const { body } = await search(token, query);
        seen.push(...body.verses.map((v) => v.id));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });
  });
});

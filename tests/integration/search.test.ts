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
 * Search: what it finds, in what order, how the filters compose, and — the part
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
        verses: { id: string; xp: string | null }[];
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

    /**
     * A denser match does not jump the queue, and a match on a tag name sits
     * in the same order as a match on xp.
     *
     * The dates are deliberately the wrong way round for relevance: the better
     * match is the *older* verse. There is no rank any more to be tempted by
     * it, and this pins that the ordering does not quietly grow one back.
     */
    it('orders by date, not by how well a verse matched', async () => {
      const { token } = await signUp('d@example.com');
      const named = await makeTag(token, 'barcelona-trip');
      const plain = await makeTag(token, 'diary');

      const strong = await makeVerse(token, {
        tagIds: [plain.id],
        xp: 'Barcelona, Barcelona, the best part',
        eventStart: '2024-01-01T00:00:00Z',
      });
      const recent = await makeVerse(token, {
        tagIds: [named.id],
        xp: 'nothing about the city here',
        eventStart: '2026-01-01T00:00:00Z',
      });

      const { body } = await search(token, '?q=barcelona');

      expect(body.verses).toHaveLength(2);
      // Newest first, even though the older one matches better.
      expect(body.verses.map((v) => v.id)).toEqual([recent.id, strong.id]);
    });

    /**
     * The change this ordering exists for.
     *
     * Searching your own life is not searching a corpus: someone typing
     * "barcelona" knows what they wrote and wants the most recent one. Ranked
     * order put a note from years ago above yesterday's with nothing on screen
     * to explain why.
     */
    it('answers newest first', async () => {
      const { token } = await signUp('newest@example.com');
      const tag = await makeTag(token, 'diary');

      const oldest = await makeVerse(token, {
        tagIds: [tag.id],
        xp: 'barcelona then',
        eventStart: '2020-05-05T00:00:00Z',
      });
      const newest = await makeVerse(token, {
        tagIds: [tag.id],
        xp: 'barcelona now',
        eventStart: '2026-05-05T00:00:00Z',
      });
      const middle = await makeVerse(token, {
        tagIds: [tag.id],
        xp: 'barcelona between',
        eventStart: '2023-05-05T00:00:00Z',
      });

      const { body } = await search(token, '?q=barcelona');

      expect(body.verses.map((v) => v.id)).toEqual([newest.id, middle.id, oldest.id]);
    });

    it('is case-insensitive', async () => {
      const { token } = await signUp('e@example.com');
      const tag = await makeTag(token, 'diary');
      await makeVerse(token, { tagIds: [tag.id], xp: 'BARCELONA' });

      expect((await search(token, '?q=barcelona')).body.verses).toHaveLength(1);
    });

    /**
     * This used to assert phrase search *and* exclusion, and it counted rather
     * than naming a row — so when the query moved off `websearch_to_tsquery`
     * it still passed while `red -car` returned the car. Both now name the
     * verse they expect.
     *
     * Phrase search is gone with `websearch_to_tsquery`; `"red bus"` is now
     * `red AND bus`, which finds the same row here and would also find a verse
     * saying "the bus, then the red one". The quotes are dropped rather than
     * searched for — a literal `"` would make the term match nothing at all.
     */
    it('excludes a word written with a leading dash', async () => {
      const { token } = await signUp('f@example.com');
      const tag = await makeTag(token, 'diary');
      const bus = await makeVerse(token, { tagIds: [tag.id], xp: 'the red bus' });
      await makeVerse(token, { tagIds: [tag.id], xp: 'a red car' });

      const { body } = await search(token, `?q=${encodeURIComponent('red -car')}`);

      expect(body.verses.map((v) => v.id)).toEqual([bus.id]);
    });

    it('treats a quoted phrase as its words, since phrase search is gone', async () => {
      const { token } = await signUp('phrase@example.com');
      const tag = await makeTag(token, 'diary');
      const bus = await makeVerse(token, { tagIds: [tag.id], xp: 'the red bus' });
      await makeVerse(token, { tagIds: [tag.id], xp: 'a red car' });

      const { body } = await search(token, `?q=${encodeURIComponent('"red bus"')}`);

      expect(body.verses.map((v) => v.id)).toEqual([bus.id]);
    });

    /**
     * The bug this change exists for.
     *
     * The field filters as you type, so a whole-word matcher answers "nothing"
     * to every keystroke until the last letter lands — which is exactly what
     * "I type text that is in the verse and get no results" looks like.
     */
    it('finds a word from the part of it already typed', async () => {
      const { token } = await signUp('prefix@example.com');
      const tag = await makeTag(token, 'diary');
      const verse = await makeVerse(token, {
        tagIds: [tag.id],
        xp: 'Dinner at Tickets, the olives were the best part',
      });

      for (const typed of ['o', 'ol', 'oliv', 'olive', 'olives']) {
        const { body } = await search(token, `?q=${encodeURIComponent(typed)}`);
        expect(
          body.verses.map((v) => v.id),
          `typed ${typed}`,
        ).toContain(verse.id);
      }
    });

    /**
     * Accents, folded on both sides by `unaccent` (the search_unaccent
     * migration). On a timeline written partly in Spanish, typing "manana" for
     * "mañana" is how most people type it.
     */
    it('finds accented text typed without the accents, and the reverse', async () => {
      const { token } = await signUp('accents@example.com');
      const tag = await makeTag(token, 'diary');
      const verse = await makeVerse(token, {
        tagIds: [tag.id],
        xp: 'Café con leche mañana en León',
      });

      for (const typed of ['cafe', 'café', 'manana', 'mañana', 'leon', 'León']) {
        const { body } = await search(token, `?q=${encodeURIComponent(typed)}`);
        expect(
          body.verses.map((v) => v.id),
          `typed ${typed}`,
        ).toContain(verse.id);
      }
    });

    /**
     * The reason full text was dropped (§8.2).
     *
     * Chinese is written without spaces, so Postgres tokenises
     * `我今天去了巴塞罗那吃饭` into exactly one lexeme — the whole sentence —
     * and no tsquery for 巴塞罗那 ever matches it. Verified directly against
     * this database before the change, not assumed. A substring match has no
     * such blind spot because it never tokenises anything.
     */
    it('finds a Chinese word inside a sentence written without spaces', async () => {
      const { token } = await signUp('zh@example.com');
      const tag = await makeTag(token, 'diary');
      const verse = await makeVerse(token, {
        tagIds: [tag.id],
        xp: '我今天去了巴塞罗那吃饭',
      });
      await makeVerse(token, { tagIds: [tag.id], xp: '昨天在家里' });

      for (const typed of ['巴塞罗那', '巴塞', '吃饭', '今天']) {
        const { body } = await search(token, `?q=${encodeURIComponent(typed)}`);
        expect(
          body.verses.map((v) => v.id),
          `typed ${typed}`,
        ).toEqual([verse.id]);
      }
    });

    /**
     * Mid-word, not merely a prefix. The tsquery version could do prefixes
     * (`oliv:*`) and nothing else, so someone half-remembering the middle of a
     * word — or writing in a language where the meaningful part is not at the
     * front — got nothing.
     */
    it('finds a word by a fragment from the middle of it', async () => {
      const { token } = await signUp('mid@example.com');
      const tag = await makeTag(token, 'diary');
      const verse = await makeVerse(token, { tagIds: [tag.id], xp: 'Barcelona again' });

      for (const typed of ['arcelon', 'celona', 'elon']) {
        const { body } = await search(token, `?q=${encodeURIComponent(typed)}`);
        expect(
          body.verses.map((v) => v.id),
          `typed ${typed}`,
        ).toEqual([verse.id]);
      }
    });

    /**
     * `%` and `_` are LIKE's wildcards, not the user's. Someone searching for
     * "100%" means the string; if the escaping in `likePattern` were dropped,
     * `100%` would match "100 euros" and `a_b` would match "axb", and both
     * would look like fuzziness nobody asked for.
     */
    it('treats a typed % or _ as the character, not as a wildcard', async () => {
      const { token } = await signUp('wildcard@example.com');
      const tag = await makeTag(token, 'diary');
      const literal = await makeVerse(token, {
        tagIds: [tag.id],
        xp: 'battery at 100% on arrival',
      });
      await makeVerse(token, { tagIds: [tag.id], xp: '100 euros for the taxi' });
      await makeVerse(token, { tagIds: [tag.id], xp: 'seat a4b by the window' });

      expect(
        (await search(token, `?q=${encodeURIComponent('100%')}`)).body.verses.map(
          (v) => v.id,
        ),
      ).toEqual([literal.id]);

      expect(
        (await search(token, `?q=${encodeURIComponent('a_b')}`)).body.verses,
      ).toHaveLength(0);
    });

    it('does not blow up on syntax a person might type', async () => {
      // A substring search has no syntax to get wrong, so none of these mean
      // anything special — they are searched for literally. The test stays
      // because the tsquery version turned a stray ampersand into a 500, and
      // a future query builder could do it again.
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
      // Free, now that tag names are read through a join instead of copied
      // into each verse — but the copy is exactly the kind of thing that gets
      // reintroduced for speed, so the test outlives it.
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
    it('pages newest first without repeating a row', async () => {
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

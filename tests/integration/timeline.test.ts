import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { fixedClock } from '@/shared/kernel';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import { handleCreateTag, handleCreateVerse, handleTimeline } from '@/modules/verse';
import {
  decodeCursor,
  encodeCursor,
  timelineYears,
} from '@/modules/verse/domain/timeline';
import { createPendingMedia, transition } from '@/modules/media/domain/media';
import { PrismaMediaRepository } from '@/modules/media/infrastructure/prisma-media-repository';

/**
 * The timeline: ordering across calendar and deep time, keyset paging, tag
 * filters, and the fact that a page is filtered by visibility after it is read.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const PASSWORD = 'a sufficiently long password';

let emailed: string[] = [];
let ipCounter = 0;
const freshIp = () => `198.18.0.${(ipCounter += 1) % 250}`;

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

describe.skipIf(!DATABASE_URL)('timeline', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'c'.repeat(64);
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

  const timeline = async (token: string, query = '') => {
    const response = await handleTimeline(
      new Request(`https://agnte.test/v1/timeline${query}`, { headers: bearer(token) }),
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        verses: { id: string; xp: string | null }[];
        nextCursor: string | null;
      },
    };
  };

  /** A `ready` Media row, created directly through the repository — see
   * tests/integration/verse-routes.test.ts's identical helper. */
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

    return pending.id;
  };

  describe('ordering', () => {
    it('returns the past newest first from the anchor', async () => {
      const { token } = await signUp('a@example.com');
      const tag = await makeTag(token, 'diary');

      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '2020-01-01T00:00:00Z',
        xp: 'old',
      });
      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '2024-01-01T00:00:00Z',
        xp: 'mid',
      });
      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '2025-01-01T00:00:00Z',
        xp: 'new',
      });

      const { body } = await timeline(token, '?anchor=2026-01-01T00:00:00Z');
      expect(body.verses.map((v) => v.xp)).toEqual(['new', 'mid', 'old']);
    });

    it('returns the future oldest first from the anchor', async () => {
      const { token } = await signUp('b@example.com');
      const tag = await makeTag(token, 'plans');

      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '2027-01-01T00:00:00Z',
        xp: 'soon',
      });
      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '2031-01-01T00:00:00Z',
        xp: 'later',
      });

      const { body } = await timeline(
        token,
        '?anchor=2026-01-01T00:00:00Z&direction=future',
      );
      expect(body.verses.map((v) => v.xp)).toEqual(['soon', 'later']);
    });

    it('excludes the future when scrolling into the past', async () => {
      const { token } = await signUp('c@example.com');
      const tag = await makeTag(token, 'diary');

      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '2020-01-01T00:00:00Z',
        xp: 'past',
      });
      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '2031-01-01T00:00:00Z',
        xp: 'future',
      });

      const { body } = await timeline(token, '?anchor=2026-01-01T00:00:00Z');
      expect(body.verses.map((v) => v.xp)).toEqual(['past']);
    });

    it('orders deep time and calendar dates on one scale', async () => {
      // The whole reason timeline_years exists: no timestamp column can hold
      // the impact, and no deep-time float carries a time of day.
      const { token } = await signUp('d@example.com');
      const tag = await makeTag(token, 'history');

      // Inserted in an order that is deliberately NOT chronological, so id
      // order cannot stand in for time order. Ordering by `event_start` with
      // NULLS LAST is a plausible wrong implementation — deep-time rows have no
      // event_start — and it reproduces the right answer whenever insertion
      // happens to be chronological. It does not survive this.
      await makeVerse(token, { tagIds: [tag.id], deepTimeYears: -66e6, xp: 'impact' });
      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '2024-01-01T00:00:00Z',
        xp: 'yesterday',
      });
      await makeVerse(token, {
        tagIds: [tag.id],
        deepTimeYears: -13.8e9,
        xp: 'big bang',
      });
      await makeVerse(token, {
        tagIds: [tag.id],
        eventStart: '1969-07-20T20:17:00Z',
        xp: 'moon landing',
      });

      const { body } = await timeline(token, '?anchor=2026-01-01T00:00:00Z&limit=10');
      expect(body.verses.map((v) => v.xp)).toEqual([
        'yesterday',
        'moon landing',
        'impact',
        'big bang',
      ]);
    });

    it('places a verse with no date at all by when it was written', async () => {
      const { token } = await signUp('e@example.com');
      const tag = await makeTag(token, 'diary');

      // A minimal verse: no event date, no deep time. It still has to appear.
      const created = await makeVerse(token, { tagIds: [tag.id], xp: 'undated' });

      const { body } = await timeline(token, '?anchor=2099-01-01T00:00:00Z');
      expect(body.verses.map((v) => v.id)).toContain(created.id);
    });
  });

  describe('paging', () => {
    it('walks the whole timeline without repeating or skipping a row', async () => {
      const { token } = await signUp('f@example.com');
      const tag = await makeTag(token, 'diary');

      for (let year = 2000; year < 2010; year += 1) {
        await makeVerse(token, {
          tagIds: [tag.id],
          eventStart: `${year}-06-01T00:00:00Z`,
          xp: String(year),
        });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const query: string =
          `?anchor=2026-01-01T00:00:00Z&limit=3` +
          (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const { body } = await timeline(token, query);
        seen.push(...body.verses.map((v) => v.xp ?? ''));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toEqual([
        '2009',
        '2008',
        '2007',
        '2006',
        '2005',
        '2004',
        '2003',
        '2002',
        '2001',
        '2000',
      ]);
      expect(new Set(seen).size).toBe(10);
    });

    it('keeps paging stable across two verses at the same instant', async () => {
      // The reason the cursor carries an id as well as a position: without it,
      // a page boundary landing between two identical positions repeats or
      // skips one.
      const { token } = await signUp('g@example.com');
      const tag = await makeTag(token, 'diary');

      const at = '2024-01-01T00:00:00Z';
      for (const label of ['one', 'two', 'three', 'four']) {
        await makeVerse(token, { tagIds: [tag.id], eventStart: at, xp: label });
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        const query: string =
          `?anchor=2026-01-01T00:00:00Z&limit=2` +
          (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
        const { body } = await timeline(token, query);
        seen.push(...body.verses.map((v) => v.xp ?? ''));
        cursor = body.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(4);
    });

    it('reports no cursor at the end of the list', async () => {
      const { token } = await signUp('h@example.com');
      const tag = await makeTag(token, 'diary');
      await makeVerse(token, { tagIds: [tag.id], eventStart: '2020-01-01T00:00:00Z' });

      const { body } = await timeline(token, '?anchor=2026-01-01T00:00:00Z&limit=10');
      expect(body.nextCursor).toBe(null);
    });

    it('refuses a corrupted cursor rather than silently restarting', async () => {
      const { token } = await signUp('i@example.com');
      const { status } = await timeline(token, '?cursor=not-a-real-cursor');
      expect(status).toBe(400);
    });

    it('refuses a limit outside the range', async () => {
      const { token } = await signUp('j@example.com');
      expect((await timeline(token, '?limit=0')).status).toBe(400);
      expect((await timeline(token, '?limit=1000')).status).toBe(400);
    });

    it('refuses an unparseable anchor and an unknown direction', async () => {
      const { token } = await signUp('k@example.com');
      expect((await timeline(token, '?anchor=last-tuesday')).status).toBe(400);
      expect((await timeline(token, '?direction=sideways')).status).toBe(400);
    });
  });

  describe('tag filters', () => {
    it('filters to any of the given tags', async () => {
      const { token } = await signUp('l@example.com');
      const films = await makeTag(token, 'films');
      const food = await makeTag(token, 'food');

      await makeVerse(token, {
        tagIds: [films.id],
        eventStart: '2024-01-01T00:00:00Z',
        xp: 'f',
      });
      await makeVerse(token, {
        tagIds: [food.id],
        eventStart: '2024-02-01T00:00:00Z',
        xp: 'd',
      });

      const { body } = await timeline(
        token,
        `?anchor=2026-01-01T00:00:00Z&tag=${films.id}`,
      );
      expect(body.verses.map((v) => v.xp)).toEqual(['f']);
    });

    it('with match=all requires every tag, not just one', async () => {
      const { token } = await signUp('m@example.com');
      const trip = await makeTag(token, 'trip');
      const food = await makeTag(token, 'food');

      await makeVerse(token, {
        tagIds: [trip.id],
        eventStart: '2024-01-01T00:00:00Z',
        xp: 'trip only',
      });
      await makeVerse(token, {
        tagIds: [trip.id, food.id],
        eventStart: '2024-02-01T00:00:00Z',
        xp: 'both',
      });

      const any = await timeline(
        token,
        `?anchor=2026-01-01T00:00:00Z&tag=${trip.id}&tag=${food.id}`,
      );
      expect(any.body.verses).toHaveLength(2);

      const all = await timeline(
        token,
        `?anchor=2026-01-01T00:00:00Z&tag=${trip.id}&tag=${food.id}&match=all`,
      );
      expect(all.body.verses.map((v) => v.xp)).toEqual(['both']);
    });
  });

  describe('media', () => {
    it('attaches each verse its own media, not the whole page batch to every row', async () => {
      // application/read-verse.ts's visibleMany batches the media lookup by
      // owner rather than one call per verse — this is the test that would
      // fail if that batching accidentally mixed results between rows
      // instead of mapping each back to its own verse.
      const { token, userId } = await signUp('media-owner@example.com');
      const tag = await makeTag(token, 'diary');
      const mediaId = await readyMedia(userId);

      await makeVerse(token, {
        tagIds: [tag.id],
        xp: 'with a photo',
        eventStart: '2026-01-01T00:00:00Z',
        mediaIds: [mediaId],
      });
      await makeVerse(token, {
        tagIds: [tag.id],
        xp: 'no photo',
        eventStart: '2026-01-02T00:00:00Z',
      });

      const { body } = await timeline(token, '?anchor=2026-01-03T00:00:00Z');
      const withPhoto = body.verses.find((v) => v.xp === 'with a photo') as {
        media?: { id: string }[];
      };
      const withoutPhoto = body.verses.find((v) => v.xp === 'no photo') as {
        media?: { id: string }[];
      };

      expect(withPhoto.media).toEqual([expect.objectContaining({ id: mediaId })]);
      expect(withoutPhoto.media).toEqual([]);
    });
  });

  describe('scope', () => {
    it("shows only the caller's own verses", async () => {
      const mine = await signUp('n@example.com');
      const theirs = await signUp('o@example.com');

      const myTag = await makeTag(mine.token, 'mine');
      const theirTag = await makeTag(theirs.token, 'theirs');

      await makeVerse(mine.token, {
        tagIds: [myTag.id],
        eventStart: '2024-01-01T00:00:00Z',
        xp: 'mine',
      });
      await makeVerse(theirs.token, {
        tagIds: [theirTag.id],
        eventStart: '2024-01-01T00:00:00Z',
        xp: 'theirs',
      });

      const { body } = await timeline(mine.token, '?anchor=2026-01-01T00:00:00Z');
      expect(body.verses.map((v) => v.xp)).toEqual(['mine']);
    });

    it("excludes another user's PUBLIC verse too", async () => {
      // The discriminating case, same as in search: a private verse is dropped
      // by the visibility resolver whether or not the query scopes by owner, so
      // the test above cannot tell whether the owner filter exists. A public
      // verse can only be kept out by the scoping.
      const mine = await signUp('n2@example.com');
      const theirs = await signUp('o2@example.com');

      const myTag = await makeTag(mine.token, 'mine');
      const theirTag = await makeTag(theirs.token, 'blog', 'public');

      await makeVerse(mine.token, {
        tagIds: [myTag.id],
        eventStart: '2024-01-01T00:00:00Z',
        xp: 'mine',
      });
      await makeVerse(theirs.token, {
        tagIds: [theirTag.id],
        eventStart: '2024-01-01T00:00:00Z',
        xp: 'their public post',
      });

      const { body } = await timeline(mine.token, '?anchor=2026-01-01T00:00:00Z');
      expect(body.verses.map((v) => v.xp)).toEqual(['mine']);
    });
  });
});

describe('the timeline scale', () => {
  it('puts the epoch at zero and orders the way history does', () => {
    const at = (iso: string) =>
      timelineYears({
        deepTimeYears: null,
        eventStart: new Date(iso),
        createdAt: new Date(iso),
      });

    expect(at('2000-01-01T00:00:00Z')).toBeCloseTo(0, 6);
    expect(at('2026-01-01T00:00:00Z')).toBeGreaterThan(at('1969-07-20T20:17:00Z'));
    expect(at('1969-07-20T20:17:00Z')).toBeGreaterThan(-66e6);
  });

  it('prefers deep time over an event date, since they are exclusive', () => {
    expect(
      timelineYears({
        deepTimeYears: -66e6,
        eventStart: new Date('2024-01-01T00:00:00Z'),
        createdAt: new Date('2024-01-01T00:00:00Z'),
      }),
    ).toBe(-66e6);
  });

  it('falls back to when the verse was written', () => {
    const createdAt = new Date('2024-01-01T00:00:00Z');
    expect(
      timelineYears({ deepTimeYears: null, eventStart: null, createdAt }),
    ).toBeCloseTo(24, 0);
  });
});

describe('the timeline cursor', () => {
  it('round-trips', () => {
    const cursor = { years: -66_000_000.5, id: '0195e2c0-0000-7000-8000-000000000001' };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded.ok && decoded.value).toEqual(cursor);
  });

  it('round-trips a negative position without losing the separator', () => {
    // The id is taken from the *last* separator, so a negative number's minus
    // sign and any future change to the format cannot split it wrongly.
    const cursor = { years: -13_800_000_000, id: 'a-b-c' };
    const decoded = decodeCursor(encodeCursor(cursor));
    expect(decoded.ok && decoded.value).toEqual(cursor);
  });

  it.each([
    '',
    'not-base64!!',
    Buffer.from('nopipe').toString('base64url'),
    Buffer.from('|id').toString('base64url'),
  ])('refuses %j', (raw) => {
    expect(decodeCursor(raw).ok).toBe(false);
  });
});

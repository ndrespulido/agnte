import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import {
  handleCreateTag,
  handleDeleteTag,
  handleListTags,
  handleUpdateTag,
} from '@/modules/verse';
import { PrismaTagRepository } from '@/modules/verse/infrastructure/prisma-tag-repository';
import { PrismaVerseRepository } from '@/modules/verse/infrastructure/prisma-verse-repository';
import { createVerse } from '@/modules/verse/domain/verse';
import { fixedClock, unwrap } from '@/shared/kernel';

/**
 * The tag endpoints end to end, against a real Postgres and behind a real
 * access token — validation, ownership, shortcuts, concurrency and the refusal
 * to orphan a verse.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const PASSWORD = 'a sufficiently long password';

let emailed: string[] = [];
let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

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

describe.skipIf(!DATABASE_URL)('tag routes', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'a'.repeat(64);
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

  /** A real account with a real access token, through the real endpoints. */
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

    const link = emailed.at(-1) ?? '';
    const match = link.match(/verify-email\?token=([^\s]+)/);
    if (!match?.[1]) throw new Error(`no verification link in:\n${link}`);

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

  const create = (token: string, body: unknown, headers: Record<string, string> = {}) =>
    handleCreateTag(
      json('POST', 'https://agnte.test/v1/tags', body, { ...bearer(token), ...headers }),
    );

  const list = (token: string) =>
    handleListTags(new Request('https://agnte.test/v1/tags', { headers: bearer(token) }));

  const patch = (token: string, id: string, body: unknown) =>
    handleUpdateTag(
      json('PATCH', `https://agnte.test/v1/tags/${id}`, body, bearer(token)),
      id,
    );

  const remove = (token: string, id: string, version: number) =>
    handleDeleteTag(
      new Request(`https://agnte.test/v1/tags/${id}?expectedVersion=${version}`, {
        method: 'DELETE',
        headers: bearer(token),
      }),
      id,
    );

  describe('authentication', () => {
    it('refuses every tag endpoint without a token', async () => {
      const anonymous = new Request('https://agnte.test/v1/tags');
      expect((await handleListTags(anonymous)).status).toBe(401);
      expect(
        (await handleCreateTag(json('POST', 'https://agnte.test/v1/tags', { name: 'x' })))
          .status,
      ).toBe(401);
    });
  });

  describe('creating', () => {
    it('creates a tag and gives it the default shortcut', async () => {
      const { token } = await signUp('a@example.com');

      const response = await create(token, { name: '.movies' });
      expect(response.status).toBe(201);

      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        name: 'movies',
        label: '.movies',
        visibility: 'private',
        shortcut: 'm',
        version: 0,
      });
    });

    it('defaults to private rather than anything more permissive', async () => {
      const { token } = await signUp('b@example.com');
      const body = (await (await create(token, { name: 'medical' })).json()) as {
        visibility: string;
      };
      expect(body.visibility).toBe('private');
    });

    it('leaves the second tag without a shortcut instead of inventing one', async () => {
      const { token } = await signUp('c@example.com');

      await create(token, { name: 'movies' });
      const second = (await (await create(token, { name: 'medical' })).json()) as {
        shortcut: string | null;
      };

      expect(second.shortcut).toBe(null);
    });

    it('honours an explicit null shortcut as "do not pick one"', async () => {
      const { token } = await signUp('d@example.com');
      const body = (await (
        await create(token, { name: 'movies', shortcut: null })
      ).json()) as {
        shortcut: string | null;
      };
      expect(body.shortcut).toBe(null);
    });

    it('reports an explicitly requested shortcut that is taken', async () => {
      // The difference from the defaulted case: the user asked for this one, so
      // silently dropping it would ignore an instruction.
      const { token } = await signUp('e@example.com');
      await create(token, { name: 'movies', shortcut: 'm' });

      const clash = await create(token, { name: 'medical', shortcut: 'm' });
      expect(clash.status).toBe(409);
      expect(await clash.json()).toMatchObject({
        error: { code: 'verse.tag_shortcut_taken' },
      });
    });

    it('refuses a duplicate name', async () => {
      const { token } = await signUp('f@example.com');
      await create(token, { name: 'movies' });

      const again = await create(token, { name: '.MOVIES' });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({
        error: { code: 'verse.tag_already_exists' },
      });
    });

    it('refuses a malformed name', async () => {
      const { token } = await signUp('g@example.com');
      const response = await create(token, { name: 'has spaces' });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: 'verse.tag_name_invalid' },
      });
    });

    it('refuses an unknown visibility rather than defaulting', async () => {
      const { token } = await signUp('h@example.com');
      const response = await create(token, { name: 'x', visibility: 'pubic' });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: 'verse.visibility_invalid' },
      });
    });

    it("returns a vertical's suggested properties without requiring them", async () => {
      const { token } = await signUp('i@example.com');
      const body = (await (
        await create(token, { name: 'flights', vertical: 'flight' })
      ).json()) as {
        vertical: string;
        suggestedProperties: string[];
      };

      expect(body.vertical).toBe('flight');
      expect(body.suggestedProperties).toContain('airline');
    });

    it('replays an idempotent retry instead of creating twice', async () => {
      const { token } = await signUp('j@example.com');
      const key = { 'idempotency-key': 'tag-key-1' };

      const first = await create(token, { name: 'movies' }, key);
      const second = await create(token, { name: 'movies' }, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers.get('idempotent-replay')).toBe('true');

      const listed = (await (await list(token)).json()) as { tags: unknown[] };
      expect(listed.tags).toHaveLength(1);
    });

    it('refuses the same key with a different body', async () => {
      const { token } = await signUp('k@example.com');
      const key = { 'idempotency-key': 'tag-key-2' };

      await create(token, { name: 'movies' }, key);
      const different = await create(token, { name: 'medical' }, key);

      expect(different.status).toBe(422);
    });
  });

  describe('listing', () => {
    it("shows only the caller's tags", async () => {
      const mine = await signUp('l@example.com');
      const theirs = await signUp('m@example.com');

      await create(mine.token, { name: 'mine' });
      await create(theirs.token, { name: 'theirs' });

      const body = (await (await list(mine.token)).json()) as {
        tags: { name: string }[];
      };
      expect(body.tags.map((t) => t.name)).toEqual(['mine']);
    });
  });

  describe('updating', () => {
    it('renames on a matching version and bumps it', async () => {
      const { token } = await signUp('n@example.com');
      const created = (await (await create(token, { name: 'movies' })).json()) as {
        id: string;
        version: number;
      };

      const response = await patch(token, created.id, {
        name: 'films',
        expectedVersion: created.version,
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ name: 'films', version: 1 });
    });

    it('answers 409 with the server version when the caller is stale', async () => {
      const { token } = await signUp('o@example.com');
      const created = (await (await create(token, { name: 'movies' })).json()) as {
        id: string;
      };

      await patch(token, created.id, { name: 'films', expectedVersion: 0 });
      const stale = await patch(token, created.id, {
        name: 'cinema',
        expectedVersion: 0,
      });

      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: { code: 'verse.version_conflict', details: { expected: 0, actual: 1 } },
      });
    });

    it('requires expectedVersion rather than defaulting it', async () => {
      // Optimistic concurrency you can forget to opt into is not concurrency
      // control.
      const { token } = await signUp('p@example.com');
      const created = (await (await create(token, { name: 'movies' })).json()) as {
        id: string;
      };

      const response = await patch(token, created.id, { name: 'films' });
      expect(response.status).toBe(400);
    });

    it("answers 404, not 403, for another user's tag", async () => {
      // Telling a caller that an id exists but is not theirs is an enumeration
      // leak — the same one identity avoids on sign-in.
      const mine = await signUp('q@example.com');
      const theirs = await signUp('r@example.com');

      const created = (await (await create(theirs.token, { name: 'secret' })).json()) as {
        id: string;
      };

      const response = await patch(mine.token, created.id, {
        name: 'stolen',
        expectedVersion: 0,
      });
      expect(response.status).toBe(404);
    });
  });

  describe('deleting', () => {
    it('deletes on a matching version', async () => {
      const { token } = await signUp('s@example.com');
      const created = (await (await create(token, { name: 'movies' })).json()) as {
        id: string;
      };

      expect((await remove(token, created.id, 0)).status).toBe(204);
      const listed = (await (await list(token)).json()) as { tags: unknown[] };
      expect(listed.tags).toHaveLength(0);
    });

    it('refuses to strip a verse of its last tag, and says how many', async () => {
      // The rule the schema cannot hold: ON DELETE CASCADE would happily leave
      // the verse with none.
      const { token, userId } = await signUp('t@example.com');
      const created = (await (await create(token, { name: 'movies' })).json()) as {
        id: string;
      };

      const verses = new PrismaVerseRepository();
      await verses.create(
        unwrap(
          createVerse({
            ownerId: userId,
            tagIds: [created.id],
            clock: fixedClock(new Date('2026-09-08T12:00:00.000Z')),
          }),
        ),
      );

      const response = await remove(token, created.id, 0);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: 'verse.no_tags', details: { orphaned: 1 } },
      });

      // Still there.
      expect(await new PrismaTagRepository().findById(created.id)).not.toBe(null);
    });

    it('allows the delete when every verse keeps another tag', async () => {
      const { token, userId } = await signUp('u@example.com');
      const going = (await (await create(token, { name: 'going' })).json()) as {
        id: string;
      };
      const staying = (await (await create(token, { name: 'staying' })).json()) as {
        id: string;
      };

      await new PrismaVerseRepository().create(
        unwrap(
          createVerse({
            ownerId: userId,
            tagIds: [going.id, staying.id],
            clock: fixedClock(new Date('2026-09-08T12:00:00.000Z')),
          }),
        ),
      );

      expect((await remove(token, going.id, 0)).status).toBe(204);
    });

    it('requires expectedVersion in the query string', async () => {
      const { token } = await signUp('v@example.com');
      const created = (await (await create(token, { name: 'movies' })).json()) as {
        id: string;
      };

      const response = await handleDeleteTag(
        new Request(`https://agnte.test/v1/tags/${created.id}`, {
          method: 'DELETE',
          headers: bearer(token),
        }),
        created.id,
      );
      expect(response.status).toBe(400);
    });
  });
});

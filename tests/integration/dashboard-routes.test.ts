import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import { handleCreateTag, handleCreateVerse, handleTagDashboard } from '@/modules/verse';

/**
 * The tag dashboard end to end: a real Postgres, a real access token, and the
 * real timeline query underneath.
 *
 * The case worth having an integration test for at all is the last one — a tag
 * that is not yours answers 404 rather than a summary. The arithmetic itself is
 * tested without a database in tests/unit/verse/summary.test.ts.
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

interface DashboardBody {
  tag: { id: string; label: string };
  summary: {
    verseCount: number;
    firstEvent: string | null;
    lastEvent: string | null;
    ratedCount: number;
    averageRating: number | null;
    coTags: { name: string; count: number }[];
    properties: {
      key: string;
      verseCount: number;
      numericCount: number;
      sum: number | null;
    }[];
  };
  truncated: boolean;
}

describe.skipIf(!DATABASE_URL)('tag dashboard', () => {
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

  async function signUp(email: string): Promise<string> {
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
    await handleVerifyEmail(
      new Request(`https://agnte.test/v1/auth/verify-email?token=${match[1]}`),
    );

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
    return ((await logged.json()) as { accessToken: string }).accessToken;
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function makeTag(token: string, name: string): Promise<string> {
    const response = await handleCreateTag(
      json('POST', 'https://agnte.test/v1/tags', { name }, bearer(token)),
    );
    return ((await response.json()) as { id: string }).id;
  }

  async function addVerse(token: string, body: Record<string, unknown>): Promise<void> {
    const response = await handleCreateVerse(
      json('POST', 'https://agnte.test/v1/verses', body, {
        ...bearer(token),
        'idempotency-key': crypto.randomUUID(),
      }),
    );
    if (response.status !== 201) {
      throw new Error(`create failed ${response.status}: ${await response.text()}`);
    }
  }

  const dashboard = (token: string, tagId: string) =>
    handleTagDashboard(
      new Request(`https://agnte.test/v1/tags/${tagId}/dashboard`, {
        headers: bearer(token),
      }),
      tagId,
    );

  it('refuses without a token', async () => {
    const response = await handleTagDashboard(
      new Request('https://agnte.test/v1/tags/whatever/dashboard'),
      'whatever',
    );
    expect(response.status).toBe(401);
  });

  it('summarises a tag across past and future', async () => {
    const token = await signUp('a@example.com');
    const trip = await makeTag(token, 'barcelona');
    const flight = await makeTag(token, 'flight');

    // Deliberately one on each side of today: the timeline runs both ways from
    // now, so a dashboard that walked only one direction would silently report
    // half the tag.
    await addVerse(token, {
      tagIds: [trip, flight],
      eventStart: '2020-06-01T10:00:00.000Z',
      rating: 8,
      properties: { amount: '42.50' },
    });
    await addVerse(token, {
      tagIds: [trip],
      eventStart: '2099-01-15T10:00:00.000Z',
      rating: 6,
      properties: { amount: '€100' },
    });

    const body = (await (await dashboard(token, trip)).json()) as DashboardBody;

    expect(body.summary.verseCount).toBe(2);
    expect(body.summary.firstEvent).toBe('2020-06-01T10:00:00.000Z');
    expect(body.summary.lastEvent).toBe('2099-01-15T10:00:00.000Z');
    expect(body.summary.ratedCount).toBe(2);
    expect(body.summary.averageRating).toBe(7);
    expect(body.summary.coTags).toEqual([
      expect.objectContaining({ name: 'flight', count: 1 }),
    ]);
    expect(body.summary.properties[0]).toEqual({
      key: 'amount',
      verseCount: 2,
      numericCount: 2,
      sum: 142.5,
    });
    expect(body.truncated).toBe(false);
    expect(body.tag.label).toBe('.barcelona');
  });

  it('answers an empty summary for a tag with nothing in it', async () => {
    const token = await signUp('b@example.com');
    const empty = await makeTag(token, 'unused');

    const response = await dashboard(token, empty);
    const body = (await response.json()) as DashboardBody;

    expect(response.status).toBe(200);
    expect(body.summary.verseCount).toBe(0);
    expect(body.summary.averageRating).toBeNull();
  });

  /**
   * The reason this file exists. A dashboard aggregates rows, and a count is a
   * disclosure: telling someone how many verses are in a tag they do not own
   * reveals that the tag exists and how much is in it, without showing a single
   * one of them. 404 rather than 403, so ids cannot be probed either.
   */
  it("will not summarise someone else's tag", async () => {
    const mine = await signUp('owner@example.com');
    const theirs = await signUp('other@example.com');

    const tagId = await makeTag(mine, 'private-trip');
    await addVerse(mine, { tagIds: [tagId], eventStart: '2026-01-01T00:00:00.000Z' });

    const response = await dashboard(theirs, tagId);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('verseCount');
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { resetSubscriptionsForTests } from '@/shared/events';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import { ERASURE_GRACE_MS } from '@/modules/identity';
import { handleCreateTag, handleCreateVerse } from '@/modules/verse';
import { handleCreateReminder } from '@/modules/notifications';
import { handleEraseMe, registerErasureHandlers, sweepErasures } from '@/modules/privacy';

/**
 * The right to erasure, end to end (§8.7).
 *
 * The thing worth testing here is not that a DELETE runs — it is that data in
 * *other* modules goes with it, through the event bus, without privacy knowing
 * the shape of anyone's tables. That is the payoff the module boundaries were
 * bought for, and it is only observable against a real database.
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

describe.skipIf(!DATABASE_URL)('erasure', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'a'.repeat(64);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    resetConfigForTests();
    resetEmailTransportForTests();
    resetSubscriptionsForTests();

    emailed = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      emailed.push(args.join(' '));
    });

    const db = getDatabase()!;
    for (const table of [
      'notifications.scheduled_notification',
      'notifications.notification_preference',
      'verse.verse',
      'verse.tag',
      'media.media',
      'platform.event_handled',
      'platform.event_dead_letter',
      'identity.refresh_token',
      'identity.pending_registration',
      'identity."user"',
      'platform.rate_limit_window',
      'platform.idempotency_key',
    ]) {
      await db.$executeRawUnsafe(`DELETE FROM ${table}`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSubscriptionsForTests();
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
    const { user } = (await verified.json()) as { user: { id: string } };

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
    const { accessToken } = (await logged.json()) as { accessToken: string };
    return { token: accessToken, userId: user.id };
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function populate(token: string): Promise<void> {
    const tag = await handleCreateTag(
      json('POST', 'https://agnte.test/v1/tags', { name: 'barcelona' }, bearer(token)),
    );
    const { id: tagId } = (await tag.json()) as { id: string };

    await handleCreateVerse(
      json(
        'POST',
        'https://agnte.test/v1/verses',
        { tagIds: [tagId], eventStart: '2026-01-01T00:00:00.000Z', xp: 'a private note' },
        { ...bearer(token), 'idempotency-key': crypto.randomUUID() },
      ),
    );

    // Inside MAX_LEAD_YEARS: 2099 is refused, and a silent 422 here made this
    // helper create nothing while the test still read as set up.
    const reminder = await handleCreateReminder(
      json(
        'POST',
        'https://agnte.test/v1/reminders',
        { title: 'Take the tablet', fireAt: '2027-01-01T09:00:00.000Z' },
        { ...bearer(token), 'idempotency-key': crypto.randomUUID() },
      ),
    );
    if (reminder.status !== 201) {
      throw new Error(
        `reminder setup failed ${reminder.status}: ${await reminder.text()}`,
      );
    }
  }

  const countsFor = async (userId: string) => {
    const db = getDatabase()!;
    const one = async (sql: string) =>
      Number((await db.$queryRawUnsafe<{ n: bigint }[]>(sql, userId))[0]?.n ?? 0);
    return {
      verses: await one(
        'SELECT count(*) AS n FROM verse.verse WHERE owner_id = $1::uuid',
      ),
      tags: await one('SELECT count(*) AS n FROM verse.tag WHERE owner_id = $1::uuid'),
      reminders: await one(
        'SELECT count(*) AS n FROM notifications.scheduled_notification WHERE user_id = $1::uuid',
      ),
      users: await one('SELECT count(*) AS n FROM identity."user" WHERE id = $1::uuid'),
    };
  };

  it('refuses without a token', async () => {
    const response = await handleEraseMe(
      new Request('https://agnte.test/v1/me', { method: 'DELETE' }),
    );
    expect(response.status).toBe(401);
  });

  /**
   * The payoff of the module boundaries: one event, three modules, and privacy
   * never touches a table it does not own.
   */
  it('purges every module through the event, and keeps the account marked', async () => {
    const { token, userId } = await signUp('erase@example.com');
    await populate(token);

    const before = await countsFor(userId);
    expect(before).toMatchObject({ verses: 1, tags: 1, reminders: 1, users: 1 });

    const response = await handleEraseMe(
      new Request('https://agnte.test/v1/me', {
        method: 'DELETE',
        headers: bearer(token),
      }),
    );
    const body = (await response.json()) as {
      modulesPurged: number;
      modulesFailed: number;
    };

    // 202, not 204: marked and purged, but the row survives the grace window.
    expect(response.status).toBe(202);
    expect(body.modulesFailed).toBe(0);
    expect(body.modulesPurged).toBeGreaterThanOrEqual(3);

    const after = await countsFor(userId);
    expect(after).toMatchObject({ verses: 0, tags: 0, reminders: 0 });
    // The account itself is still there — that is what the window is.
    expect(after.users).toBe(1);
  });

  /**
   * The grace window is a chance to recover an account, not a month of
   * continued use: "delete my account" that leaves a working login behind for
   * thirty days is not what anyone asking means.
   *
   * The refusal is the ordinary invalid-credentials error, because saying "this
   * account is being deleted" would confirm the address exists.
   */
  it('refuses to sign in a marked account, indistinguishably', async () => {
    const { token } = await signUp('gone@example.com');

    const before = await handleLogin(
      json(
        'POST',
        'https://agnte.test/v1/auth/login',
        { email: 'gone@example.com', password: PASSWORD },
        { 'x-forwarded-for': freshIp() },
      ),
    );
    expect(before.status).toBe(200);

    await handleEraseMe(
      new Request('https://agnte.test/v1/me', {
        method: 'DELETE',
        headers: bearer(token),
      }),
    );

    const after = await handleLogin(
      json(
        'POST',
        'https://agnte.test/v1/auth/login',
        { email: 'gone@example.com', password: PASSWORD },
        { 'x-forwarded-for': freshIp() },
      ),
    );

    expect(after.status).toBe(401);
    const body = (await after.json()) as { error: { code: string; message: string } };
    // The same code and wording a wrong password gets.
    expect(body.error.code).toBe('identity.invalid_credentials');
    expect(body.error.message).not.toMatch(/eras|delet/i);
  });

  it('leaves other people alone', async () => {
    const mine = await signUp('mine@example.com');
    const theirs = await signUp('theirs@example.com');
    await populate(mine.token);
    await populate(theirs.token);

    await handleEraseMe(
      new Request('https://agnte.test/v1/me', {
        method: 'DELETE',
        headers: bearer(mine.token),
      }),
    );

    expect(await countsFor(mine.userId)).toMatchObject({ verses: 0, tags: 0 });
    expect(await countsFor(theirs.userId)).toMatchObject({ verses: 1, tags: 1 });
  });

  it('does not restart the grace window on a second request', async () => {
    const { token, userId } = await signUp('twice@example.com');

    await handleEraseMe(
      new Request('https://agnte.test/v1/me', {
        method: 'DELETE',
        headers: bearer(token),
      }),
    );
    const first = await getDatabase()!.$queryRawUnsafe<{ erasure_requested_at: Date }[]>(
      'SELECT erasure_requested_at FROM identity."user" WHERE id = $1::uuid',
      userId,
    );

    const second = await handleEraseMe(
      new Request('https://agnte.test/v1/me', {
        method: 'DELETE',
        headers: bearer(token),
      }),
    );
    const body = (await second.json()) as { alreadyRequested: boolean };
    const again = await getDatabase()!.$queryRawUnsafe<{ erasure_requested_at: Date }[]>(
      'SELECT erasure_requested_at FROM identity."user" WHERE id = $1::uuid',
      userId,
    );

    expect(body.alreadyRequested).toBe(true);
    // Restarting it would let a repeated call keep an account alive forever
    // while the person believes it is being deleted.
    expect(again[0]?.erasure_requested_at).toEqual(first[0]?.erasure_requested_at);
  });

  describe('the sweep', () => {
    it('leaves an account inside its grace window alone', async () => {
      const { token, userId } = await signUp('waiting@example.com');
      await handleEraseMe(
        new Request('https://agnte.test/v1/me', {
          method: 'DELETE',
          headers: bearer(token),
        }),
      );

      registerErasureHandlers();
      expect(await sweepErasures(new Date())).toBe(0);
      expect((await countsFor(userId)).users).toBe(1);
    });

    it('removes an account once the window has closed', async () => {
      const { token, userId } = await signUp('expired@example.com');
      await handleEraseMe(
        new Request('https://agnte.test/v1/me', {
          method: 'DELETE',
          headers: bearer(token),
        }),
      );

      registerErasureHandlers();
      const later = new Date(Date.now() + ERASURE_GRACE_MS + 60_000);
      expect(await sweepErasures(later)).toBe(1);
      expect((await countsFor(userId)).users).toBe(0);
    });

    /**
     * A module that still cannot purge keeps the account alive for another
     * sweep. Deleting the row would strand whatever it could not remove, with
     * nothing left to identify it by.
     */
    it('will not delete an account while a module still cannot purge', async () => {
      const { token, userId } = await signUp('stuck@example.com');
      await handleEraseMe(
        new Request('https://agnte.test/v1/me', {
          method: 'DELETE',
          headers: bearer(token),
        }),
      );

      // A handler registered *after* the first purge, so the bus has no record
      // of it having run — the shape of a module added between request and
      // sweep, which is exactly when this protection matters.
      resetSubscriptionsForTests();
      const { subscribe, EVENTS } = await import('@/shared/events');
      subscribe(EVENTS.userErasureRequested, 'stubborn.purge', async () => {
        throw new Error('storage unreachable');
      });

      const later = new Date(Date.now() + ERASURE_GRACE_MS + 60_000);
      expect(await sweepErasures(later)).toBe(0);
      expect((await countsFor(userId)).users).toBe(1);
    });
  });
});

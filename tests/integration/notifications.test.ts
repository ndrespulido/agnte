import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { systemClock, uuidv7 } from '@/shared/kernel';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import { PrismaUserRepository } from '@/modules/identity/infrastructure/prisma-user-repository';
import { EmailNotificationDelivery } from '@/modules/notifications/infrastructure/email-delivery';
import { PrismaNotificationRepository } from '@/modules/notifications/infrastructure/prisma-notification-repository';
import { PrismaPreferenceRepository } from '@/modules/notifications/infrastructure/prisma-preference-repository';
import { PrismaPushSubscriptionRepository } from '@/modules/notifications/infrastructure/prisma-push-subscription-repository';
import { purgeForUser } from '@/modules/notifications';
import type { ScheduledNotification } from '@/modules/notifications/domain/ports';

/**
 * The parts that only a real Postgres can answer: the CHECK constraints, and
 * `FOR UPDATE SKIP LOCKED`.
 *
 * The dispatcher's decisions are tested against fakes in
 * tests/unit/notifications/dispatch.test.ts — what is here is everything a fake
 * would have to pretend about.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };

const at = (iso: string) => new Date(iso);

const reminder = (over: Partial<ScheduledNotification> = {}): ScheduledNotification => ({
  id: uuidv7(),
  userId: '01a0a52d-5f97-76ee-9024-bb3418e761da',
  verseId: null,
  fireAt: at('2026-09-15T09:00:00Z'),
  startAt: at('2026-09-15T09:00:00Z'),
  occurrences: 0,
  recurrence: null,
  status: 'pending',
  title: 'Take the tablet',
  body: null,
  attempts: 0,
  lastError: null,
  createdAt: at('2026-09-01T09:00:00Z'),
  updatedAt: at('2026-09-01T09:00:00Z'),
  version: 0,
  ...over,
});

describe.skipIf(!DATABASE_URL)('notifications persistence', () => {
  const repo = new PrismaNotificationRepository();
  const preferences = new PrismaPreferenceRepository();

  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    resetConfigForTests();
    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM notifications.scheduled_notification');
    await db.$executeRawUnsafe('DELETE FROM notifications.notification_preference');
    await db.$executeRawUnsafe('DELETE FROM notifications.push_subscription');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  it('round-trips a reminder', async () => {
    const one = reminder({ recurrence: 'FREQ=DAILY', body: 'with water' });
    await repo.create(one);

    const found = await repo.findById(one.id);
    expect(found).toMatchObject({
      id: one.id,
      title: 'Take the tablet',
      body: 'with water',
      recurrence: 'FREQ=DAILY',
      status: 'pending',
    });
    expect(found?.fireAt.toISOString()).toBe('2026-09-15T09:00:00.000Z');
  });

  it('claims only what is due and still pending', async () => {
    await repo.create(reminder({ fireAt: at('2026-09-15T08:00:00Z') }));
    await repo.create(reminder({ fireAt: at('2026-09-20T08:00:00Z') })); // not yet
    await repo.create(
      reminder({ fireAt: at('2026-09-14T08:00:00Z'), status: 'sent' }), // done
    );

    const due = await repo.claimDue(at('2026-09-15T09:00:00Z'), 10);

    expect(due).toHaveLength(1);
    expect(due[0]?.fireAt.toISOString()).toBe('2026-09-15T08:00:00.000Z');
  });

  /**
   * The contract §8.4 asks for by name, and the reason a second instance
   * ticking at the same moment is safe.
   *
   * Two transactions claim concurrently. Without SKIP LOCKED the second would
   * block until the first committed — which on Cloud Run risks being killed
   * mid-wait — and with a plain SELECT both would claim the same row and send
   * the reminder twice.
   */
  it('never hands the same reminder to two dispatchers at once', async () => {
    const db = getDatabase()!;
    const a = reminder({ fireAt: at('2026-09-15T08:00:00Z') });
    const b = reminder({ fireAt: at('2026-09-15T08:30:00Z') });
    await repo.create(a);
    await repo.create(b);

    const now = at('2026-09-15T09:00:00Z');
    const claimOne = (client: {
      $queryRawUnsafe: <T>(sql: string, ...args: unknown[]) => Promise<T>;
    }) =>
      client.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM notifications.scheduled_notification
          WHERE status = 'pending' AND fire_at <= $1
          ORDER BY fire_at ASC LIMIT 1
          FOR UPDATE SKIP LOCKED`,
        now,
      );

    /*
     * The two claims have to *overlap*, which a `Promise.all` of two
     * transactions does not guarantee — the first can commit before the second
     * begins, at which point the row is legitimately free again and claiming it
     * twice is correct behaviour rather than a bug. (Written that way first;
     * the test passed for the wrong reason and had to be rebuilt.)
     *
     * So the second claim runs *inside* the first transaction's lifetime, on a
     * separate pooled connection, which is exactly the shape of two Cloud Run
     * instances ticking at the same moment.
     */
    const { inner, outer } = await db.$transaction(async (tx) => {
      const held = await claimOne(tx);
      const other = await claimOne(db);
      return { inner: held, outer: other };
    });

    expect(inner).toHaveLength(1);
    expect(outer).toHaveLength(1);
    // The second dispatcher walked past the locked row and took the next one.
    expect(inner[0]?.id).toBe(a.id);
    expect(outer[0]?.id).toBe(b.id);
  });

  it('settles a claimed row', async () => {
    const one = reminder();
    await repo.create(one);

    await repo.settle({
      id: one.id,
      nextFireAt: at('2026-09-16T09:00:00Z'),
      occurrences: 1,
      status: 'pending',
      attempts: 0,
      lastError: null,
    });

    const found = await repo.findById(one.id);
    expect(found?.occurrences).toBe(1);
    expect(found?.fireAt.toISOString()).toBe('2026-09-16T09:00:00.000Z');
    expect(found?.version).toBe(1);
  });

  it('keeps the last fire time when a reminder is retired', async () => {
    const one = reminder();
    await repo.create(one);

    await repo.settle({
      id: one.id,
      nextFireAt: null,
      occurrences: 1,
      status: 'sent',
      attempts: 0,
      lastError: null,
    });

    const found = await repo.findById(one.id);
    expect(found?.status).toBe('sent');
    // Null would lose the record of when it actually went out.
    expect(found?.fireAt.toISOString()).toBe('2026-09-15T09:00:00.000Z');
  });

  describe('the database refuses what the domain refuses', () => {
    const db = () => getDatabase()!;

    it('rejects a status outside the vocabulary', async () => {
      const one = reminder();
      await repo.create(one);
      await expect(
        db().$executeRawUnsafe(
          `UPDATE notifications.scheduled_notification SET status = 'maybe' WHERE id = $1::uuid`,
          one.id,
        ),
      ).rejects.toThrow();
    });

    it('rejects a blank title', async () => {
      await expect(repo.create(reminder({ title: '   ' }))).rejects.toThrow();
    });

    it('rejects negative counters', async () => {
      await expect(repo.create(reminder({ attempts: -1 }))).rejects.toThrow();
    });

    /**
     * Half-configured quiet hours would have to be resolved against *something*
     * — UTC (wrong twice a year) or the server's zone (wrong always). The
     * constraint makes the row unrepresentable rather than leaving the
     * dispatcher to guess.
     */
    it('rejects quiet hours without a zone', async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO notifications.notification_preference
             (user_id, quiet_start_minute, quiet_end_minute, time_zone, created_at, updated_at, version)
           VALUES ($1::uuid, 1320, 420, NULL, NOW(), NOW(), 0)`,
          '01a0a52d-5f97-76ee-9024-bb3418e761da',
        ),
      ).rejects.toThrow();
    });

    it('rejects a window whose ends are equal', async () => {
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO notifications.notification_preference
             (user_id, quiet_start_minute, quiet_end_minute, time_zone, created_at, updated_at, version)
           VALUES ($1::uuid, 480, 480, 'Europe/Madrid', NOW(), NOW(), 0)`,
          '01a0a52d-5f97-76ee-9024-bb3418e761da',
        ),
      ).rejects.toThrow();
    });
  });

  it('stores and reads quiet hours', async () => {
    const userId = '01a0a52d-5f97-76ee-9024-bb3418e761da';
    await preferences.upsert({
      userId,
      quietHours: { startMinute: 1320, endMinute: 420, timeZone: 'Europe/Madrid' },
      version: 0,
    });

    expect((await preferences.find(userId))?.quietHours).toEqual({
      startMinute: 1320,
      endMinute: 420,
      timeZone: 'Europe/Madrid',
    });

    // Clearing is a legitimate choice, not an absent row.
    await preferences.upsert({ userId, quietHours: null, version: 0 });
    expect((await preferences.find(userId))?.quietHours).toBeNull();
  });

  /** §8.7: each module purges its own data rather than privacy reaching in. */
  it('purges everything it holds about one person', async () => {
    const userId = '01a0a52d-5f97-76ee-9024-bb3418e761da';
    await repo.create(reminder({ userId }));
    await repo.create(reminder({ userId }));
    await preferences.upsert({
      userId,
      quietHours: { startMinute: 1320, endMinute: 420, timeZone: 'Europe/Madrid' },
      version: 0,
    });

    // A push subscription is an address for reaching someone; erasure has to
    // take it too, or the deployment could still push to their phone.
    await new PrismaPushSubscriptionRepository().upsert({
      id: uuidv7(),
      userId,
      endpoint: 'https://push.example/purge-me',
      p256dh:
        'BL5o0KPDOlRPRwye0AxlHLSY9F3Oqq2aAmOejVmqch-8rYcxgFl8naSZrK5zq15mmpdBumde19vRrhYCSFBHoVM',
      auth: '5ixp7JUVeDLks8R17y0Qzg',
      userAgent: null,
    });

    expect(await purgeForUser(userId)).toEqual({
      reminders: 2,
      preferences: 1,
      pushSubscriptions: 1,
    });
    expect(await repo.listForUser(userId, 10)).toHaveLength(0);
    expect(await preferences.find(userId)).toBeNull();
    expect(await new PrismaPushSubscriptionRepository().listForUser(userId)).toHaveLength(
      0,
    );
  });
});

describe.skipIf(!DATABASE_URL)('push subscriptions', () => {
  const subscriptions = new PrismaPushSubscriptionRepository();

  const owner = '018f0000-0000-7000-8000-0000000000a1';
  const other = '018f0000-0000-7000-8000-0000000000a2';

  const record = (over: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    userId: owner,
    endpoint: 'https://push.example/one',
    p256dh:
      'BL5o0KPDOlRPRwye0AxlHLSY9F3Oqq2aAmOejVmqch-8rYcxgFl8naSZrK5zq15mmpdBumde19vRrhYCSFBHoVM',
    auth: '5ixp7JUVeDLks8R17y0Qzg',
    userAgent: 'a phone',
    ...over,
  });

  beforeEach(async () => {
    await getDatabase()!.$executeRawUnsafe('DELETE FROM notifications.push_subscription');
  });

  it('round-trips a subscription', async () => {
    await subscriptions.upsert(record());

    const found = await subscriptions.listForUser(owner);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      endpoint: 'https://push.example/one',
      userAgent: 'a phone',
    });
  });

  /**
   * A browser re-subscribes on its own schedule and hands back the same
   * endpoint with fresh keys. Inserting would accumulate rows that all address
   * one device, so every reminder would be pushed to it several times.
   */
  it('updates in place when the same browser re-subscribes', async () => {
    await subscriptions.upsert(record());
    await subscriptions.upsert(
      record({ auth: 'ZZZZZZZZZZZZZZZZZZZZZZ', userAgent: 'same phone' }),
    );

    const found = await subscriptions.listForUser(owner);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      auth: 'ZZZZZZZZZZZZZZZZZZZZZZ',
      userAgent: 'same phone',
    });
  });

  /**
   * The same browser signed into a different account gets the same endpoint
   * back from the push service. Leaving the old owner on it would deliver one
   * person's reminders to another's device.
   */
  it('moves a subscription to whoever last subscribed it', async () => {
    await subscriptions.upsert(record());
    await subscriptions.upsert(record({ userId: other }));

    expect(await subscriptions.listForUser(owner)).toHaveLength(0);
    expect(await subscriptions.listForUser(other)).toHaveLength(1);
  });

  it('keeps one person from unsubscribing another', async () => {
    await subscriptions.upsert(record());

    expect(await subscriptions.remove(other, 'https://push.example/one')).toBe(false);
    expect(await subscriptions.listForUser(owner)).toHaveLength(1);

    expect(await subscriptions.remove(owner, 'https://push.example/one')).toBe(true);
    expect(await subscriptions.listForUser(owner)).toHaveLength(0);
  });

  /** A 404/410 from the push service means the endpoint is gone, whoever owns it. */
  it('forgets a dead endpoint without needing to know the owner', async () => {
    await subscriptions.upsert(record());
    expect(await subscriptions.removeByEndpoint('https://push.example/one')).toBe(true);
    expect(await subscriptions.listForUser(owner)).toHaveLength(0);
  });

  /**
   * A subscription is an address for reaching someone. Erasure has to take it,
   * or the deployment could still push to their phone afterwards.
   */
  it('is purged with the account', async () => {
    await subscriptions.upsert(record());
    await subscriptions.upsert(record({ endpoint: 'https://push.example/two' }));

    expect(await subscriptions.deleteForUser(owner)).toBe(2);
    expect(await subscriptions.listForUser(owner)).toHaveLength(0);
  });

  it('refuses a row with no key material', async () => {
    await expect(subscriptions.upsert(record({ p256dh: '' }))).rejects.toThrow();
  });
});

/**
 * A reminder email, in the recipient's language.
 *
 * This is the reason the preference is a column on the user rather than
 * something the browser knows: this path runs from the scheduled tick, with no
 * request and therefore no `Accept-Language` to read. Verified end to end —
 * through the real user row, the real cross-module lookup, and the real
 * transport — because every one of those links is where it could quietly fall
 * back to English.
 */
describe.skipIf(!DATABASE_URL)('reminder emails follow the account language', () => {
  const users = new PrismaUserRepository();
  const delivery = new EmailNotificationDelivery();

  let sent: string[] = [];

  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    resetConfigForTests();
    resetEmailTransportForTests();

    sent = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      sent.push(args.join(' '));
    });

    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity."user"');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetEmailTransportForTests();
  });

  const account = async (locale: string) => {
    const user = createVerifiedUser({
      email: `reader-${locale}@example.com` as never,
      passwordHash: null,
      locale,
      clock: systemClock,
    });
    await users.create(user);
    return user;
  };

  const send = async (userId: string) => {
    await delivery.send({
      userId,
      title: 'Tomar la pastilla',
      body: null,
      verseId: null,
    });
    return sent.join('\n');
  };

  it.each([
    ['es', 'Programaste este recordatorio en Agnte.'],
    ['fr', 'Vous avez programmé ce rappel dans Agnte.'],
    ['zh', '这条提醒是你在 Agnte 中设置的。'],
    ['en', 'You set this reminder in Agnte.'],
  ])('writes the footer in %s', async (locale, expected) => {
    const user = await account(locale);

    expect(await send(user.id)).toContain(expected);
  });

  /**
   * The person's own words are not translated — only the app's sentences
   * around them. A reminder someone wrote in Spanish must not be rephrased
   * because their interface is in English.
   */
  it('leaves the title exactly as it was written', async () => {
    const user = await account('en');

    expect(await send(user.id)).toContain('Tomar la pastilla');
  });

  /**
   * A row written by a newer build offering a language this one does not have.
   * English rather than a crash: a reminder is a promise to interrupt someone,
   * and the wrong language is a far smaller failure than no email.
   */
  it('falls back to English for a language it has no strings for', async () => {
    const user = await account('ja');

    expect(await send(user.id)).toContain('You set this reminder in Agnte.');
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { handleLogin, handleRegister, handleVerifyEmail } from '@/modules/identity';
import { handleSubscribePush, handleTestPush } from '@/modules/notifications';
import { generateVapidKeys } from '@/modules/notifications/infrastructure/web-push';

/**
 * `POST /v1/push/test` — the endpoint that makes push provable.
 *
 * Why it needed building, and why it is tested at the HTTP level rather than
 * against a fake: before it existed, pressing "Turn on" produced no visible
 * result at all, and the next thing that would ever arrive was a reminder at
 * its own fire time, dispatched by a five-minute cron. The first real report
 * from a phone was "I tried push but didn't understand how it works" — which
 * is exactly what a feature with no feedback feels like.
 *
 * The four answers are the whole point, because each one needs different
 * advice, and a fake repository would not prove that a real subscription row
 * is found and a dead one is actually deleted.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };

const SUBSCRIPTION = {
  endpoint: 'https://push.example/abc',
  keys: {
    // Real key material, so the payload is genuinely encrypted on the way out
    // rather than skipped by a fake that never exercises it.
    p256dh:
      'BL5o0KPDOlRPRwye0AxlHLSY9F3Oqq2aAmOejVmqch-8rYcxgFl8naSZrK5zq15mmpdBumde19vRrhYCSFBHoVM',
    auth: '5ixp7JUVeDLks8R17y0Qzg',
  },
};

interface TestResult {
  configured: boolean;
  subscriptions: number;
  delivered: number;
  removed: number;
  failures: string[];
}

describe.skipIf(!DATABASE_URL)('the push test endpoint', () => {
  let emailed: string[] = [];
  let ipCounter = 0;
  const freshIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

  /** Every call the push service received, so a test can assert it was tried. */
  let pushed: string[] = [];

  const withVapid = () => {
    const keys = generateVapidKeys('mailto:ops@agnte.app');
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = keys.subject;
    resetConfigForTests();
  };

  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'f'.repeat(64);
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
    resetConfigForTests();
    resetEmailTransportForTests();

    emailed = [];
    pushed = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      emailed.push(args.join(' '));
    });

    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM notifications.push_subscription');
    await db.$executeRawUnsafe('DELETE FROM identity.refresh_token');
    await db.$executeRawUnsafe('DELETE FROM identity.pending_registration');
    await db.$executeRawUnsafe('DELETE FROM identity."user"');
    await db.$executeRawUnsafe('DELETE FROM platform.rate_limit_window');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetEmailTransportForTests();
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const json = (method: string, url: string, body: unknown, headers = {}) =>
    new Request(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  async function signIn(email: string): Promise<string> {
    const ip = freshIp();
    await handleRegister(
      json(
        'POST',
        'https://agnte.test/v1/auth/register',
        { email, password: 'a sufficiently long password' },
        { 'x-forwarded-for': ip },
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
        { email, password: 'a sufficiently long password' },
        { 'x-forwarded-for': ip },
      ),
    );
    return ((await logged.json()) as { accessToken: string }).accessToken;
  }

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  const subscribe = (token: string) =>
    handleSubscribePush(
      json(
        'POST',
        'https://agnte.test/v1/push/subscriptions',
        SUBSCRIPTION,
        bearer(token),
      ),
    );

  const test = async (token: string) => {
    const response = await handleTestPush(
      new Request('https://agnte.test/v1/push/test', {
        method: 'POST',
        headers: bearer(token),
      }),
    );
    return { status: response.status, body: (await response.json()) as TestResult };
  };

  const pushAnswers = (status: number) =>
    vi.stubGlobal('fetch', async (url: string) => {
      pushed.push(String(url));
      return new Response(null, { status });
    });

  /**
   * `npm run dev` runs with no VAPID keys by design (§7.1), so this is a
   * deployment fact rather than a fault. It answers 200 so the client can say
   * "push is switched off on this server" instead of rendering a failure.
   */
  it('says so when this deployment has no VAPID keys', async () => {
    const token = await signIn('nokeys@example.com');

    const { status, body } = await test(token);

    expect(status).toBe(200);
    expect(body.configured).toBe(false);
    expect(body.delivered).toBe(0);
  });

  it('says so when no browser is subscribed', async () => {
    withVapid();
    const token = await signIn('nosub@example.com');

    const { body } = await test(token);

    expect(body).toMatchObject({ configured: true, subscriptions: 0, delivered: 0 });
    expect(body.failures).toEqual([]);
  });

  it('pushes to a subscribed browser and reports it', async () => {
    withVapid();
    pushAnswers(201);
    const token = await signIn('works@example.com');
    expect((await subscribe(token)).status).toBeLessThan(300);

    const { body } = await test(token);

    expect(body).toMatchObject({
      configured: true,
      subscriptions: 1,
      delivered: 1,
      removed: 0,
    });
    expect(pushed).toEqual([SUBSCRIPTION.endpoint]);
  });

  /**
   * **Never the email fallback.** `PushWithEmailFallback` is right for a
   * reminder — a promise to interrupt someone must not be dropped because a
   * subscription went stale — and exactly wrong here: an email arriving would
   * let this answer "sent" while push itself was dead, retiring the one
   * question the button exists to settle.
   */
  it('does not quietly fall back to email when push fails', async () => {
    withVapid();
    pushAnswers(502);
    const token = await signIn('nofallback@example.com');
    await subscribe(token);
    emailed = [];

    const { body } = await test(token);

    expect(body.delivered).toBe(0);
    expect(body.failures).toEqual(['push.example answered 502']);
    expect(emailed.join('\n')).not.toContain('── email ──');
  });

  /**
   * 410 is the push service saying that browser is gone — uninstalled, or its
   * permission revoked. Counted apart from a failure because nothing is
   * broken, and the row is deleted rather than left to fail on every tick
   * forever.
   */
  it('forgets a subscription the push service says is gone', async () => {
    withVapid();
    pushAnswers(410);
    const token = await signIn('gone@example.com');
    await subscribe(token);

    const { body } = await test(token);

    expect(body).toMatchObject({ delivered: 0, removed: 1 });
    expect(body.failures).toEqual([]);

    // Actually deleted, so the next test reports "nothing subscribed" rather
    // than failing against a dead endpoint again.
    const after = await test(token);
    expect(after.body.subscriptions).toBe(0);
  });

  it('needs a token', async () => {
    const response = await handleTestPush(
      new Request('https://agnte.test/v1/push/test', { method: 'POST' }),
    );

    expect(response.status).toBe(401);
  });
});

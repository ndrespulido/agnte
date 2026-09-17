import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import { PushWithEmailFallback } from '@/modules/notifications/infrastructure/push-delivery';
import { generateVapidKeys } from '@/modules/notifications/infrastructure/web-push';
import type {
  NotificationDelivery,
  PushSubscriptionRecord,
  PushSubscriptionRepository,
} from '@/modules/notifications/domain/ports';

/**
 * Push, and what happens when it does not work.
 *
 * The encryption is checked in `web-push.test.ts`; this file is about the
 * decisions around it — when email takes over, when a dead subscription is
 * forgotten, and when a failure is allowed to reach the dispatcher instead of
 * being quietly downgraded.
 */

const ORIGINAL_ENV = { ...process.env };

const subscription = (
  over: Partial<PushSubscriptionRecord> = {},
): PushSubscriptionRecord => ({
  id: 's1',
  userId: 'u1',
  endpoint: 'https://push.example/abc',
  // Real key material, so the encryption actually runs rather than being
  // skipped by a fake that never exercises it.
  p256dh:
    'BL5o0KPDOlRPRwye0AxlHLSY9F3Oqq2aAmOejVmqch-8rYcxgFl8naSZrK5zq15mmpdBumde19vRrhYCSFBHoVM',
  auth: '5ixp7JUVeDLks8R17y0Qzg',
  userAgent: null,
  ...over,
});

function harness(options: {
  subscriptions?: PushSubscriptionRecord[];
  respond?: (url: string) => Response;
}) {
  const removed: string[] = [];
  const emailed: unknown[] = [];

  const repository: PushSubscriptionRepository = {
    listForUser: async () => options.subscriptions ?? [],
    upsert: async () => undefined,
    remove: async () => true,
    removeByEndpoint: async (endpoint) => {
      removed.push(endpoint);
      return true;
    },
    deleteForUser: async () => 0,
  };

  const email: NotificationDelivery = {
    description: 'email',
    send: async (input) => {
      emailed.push(input);
    },
  };

  const sent: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    sent.push(String(url));
    return options.respond?.(String(url)) ?? new Response(null, { status: 201 });
  });

  return {
    delivery: new PushWithEmailFallback(repository, email),
    removed,
    emailed,
    sent,
  };
}

const reminder = { userId: 'u1', title: 'Take the tablet', body: null, verseId: null };

describe('PushWithEmailFallback', () => {
  beforeEach(() => {
    const keys = generateVapidKeys('mailto:ops@agnte.app');
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'a'.repeat(64);
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = keys.subject;
    resetConfigForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
  });

  it('pushes to every browser a person has subscribed', async () => {
    const h = harness({
      subscriptions: [
        subscription({ endpoint: 'https://push.example/laptop' }),
        subscription({ endpoint: 'https://push.example/phone' }),
      ],
    });

    await h.delivery.send(reminder);

    expect(h.sent).toEqual(['https://push.example/laptop', 'https://push.example/phone']);
    expect(h.emailed).toHaveLength(0);
  });

  /** §8.4 calls email the fallback. Nobody subscribed is exactly its case. */
  it('falls back to email when no browser is subscribed', async () => {
    const h = harness({ subscriptions: [] });
    await h.delivery.send(reminder);

    expect(h.sent).toHaveLength(0);
    expect(h.emailed).toHaveLength(1);
  });

  it('falls back to email when push is not configured at all', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    resetConfigForTests();

    const h = harness({ subscriptions: [subscription()] });
    await h.delivery.send(reminder);

    expect(h.sent).toHaveLength(0);
    expect(h.emailed).toHaveLength(1);
  });

  /**
   * A 410 is the push service saying the endpoint no longer exists. Keeping it
   * means failing against it on every tick forever, and a queue with a
   * permanent failure in it is a queue nobody reads.
   */
  it.each([404, 410])(
    'forgets a subscription the service says is gone (%i)',
    async (status) => {
      const h = harness({
        subscriptions: [subscription({ endpoint: 'https://push.example/gone' })],
        respond: () => new Response(null, { status }),
      });

      await h.delivery.send(reminder);

      expect(h.removed).toEqual(['https://push.example/gone']);
      // Gone is not failed: there is no browser to reach any more, which is
      // precisely what email is for.
      expect(h.emailed).toHaveLength(1);
    },
  );

  /**
   * The distinction that keeps a broken transport visible. A push service
   * having a bad day must reach the dispatcher as a failure so it retries —
   * silently sending an email instead would hide that push stopped working.
   */
  it('throws rather than quietly emailing when a push actually fails', async () => {
    const h = harness({
      subscriptions: [subscription()],
      respond: () => new Response(null, { status: 500 }),
    });

    await expect(h.delivery.send(reminder)).rejects.toThrow(/Web Push failed/);
    expect(h.emailed).toHaveLength(0);
  });

  it('is satisfied if any one browser took it', async () => {
    const h = harness({
      subscriptions: [
        subscription({ endpoint: 'https://push.example/broken' }),
        subscription({ endpoint: 'https://push.example/works' }),
      ],
      respond: (url) =>
        new Response(null, { status: url.endsWith('broken') ? 500 : 201 }),
    });

    await h.delivery.send(reminder);
    expect(h.emailed).toHaveLength(0);
  });

  it('sends the encrypted body with the headers a push service requires', async () => {
    const h = harness({ subscriptions: [subscription()] });

    // After `harness`, which installs a stub of its own — stubbing first means
    // this one is replaced and `seen` stays undefined.
    let seen: RequestInit | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(null, { status: 201 });
    });

    await h.delivery.send({ ...reminder, body: 'the small blue one' });

    const headers = seen?.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers.authorization?.startsWith('vapid t=')).toBe(true);
    // Encrypted, not the JSON: the title must not be readable on the wire.
    const body = Buffer.from(seen?.body as Uint8Array);
    expect(body.includes(Buffer.from('Take the tablet'))).toBe(false);
    expect(body.length).toBeGreaterThan(86);
  });
});

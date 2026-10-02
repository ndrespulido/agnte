import { loadConfig } from '@/shared/infra/config';
import type {
  NotificationDelivery,
  PushSubscriptionRecord,
  PushSubscriptionRepository,
} from '../domain/ports';
import { buildPushRequest, type VapidKeys } from './web-push';

/**
 * Web Push, with email behind it (§8.4).
 *
 * §8.4 calls email the *fallback*, and this is the composition that makes that
 * true: try every browser this person has subscribed, and fall through to email
 * only when none of them took it. Both transports implement the same port, so
 * the dispatcher is unchanged and still counts attempts and decides on retries.
 *
 * Why the fallback is not optional, on iOS especially: push there requires the
 * PWA installed to the home screen *and* notification permission granted, and a
 * person who has done neither would otherwise silently receive nothing. A
 * reminder that does not arrive is the whole failure of this feature.
 */
export class PushWithEmailFallback implements NotificationDelivery {
  readonly description = 'web push, falling back to email';

  constructor(
    private readonly subscriptions: PushSubscriptionRepository,
    private readonly email: NotificationDelivery,
  ) {}

  async send(input: {
    userId: string;
    title: string;
    body: string | null;
    verseId: string | null;
  }): Promise<void> {
    const keys = vapidKeys();
    const subscriptions = keys ? await this.subscriptions.listForUser(input.userId) : [];

    if (subscriptions.length === 0) return this.email.send(input);

    /*
     * The payload the service worker reads. Deliberately small.
     *
     * Push payloads travel through a third party — FCM, Mozilla, Apple — and
     * while the body is encrypted to a key only the browser holds, the *length*
     * is not. A reminder whose title is someone's medical note is already as
     * much as this should carry; the verse id is a pointer, not content.
     */
    const payload = Buffer.from(
      JSON.stringify({
        title: input.title,
        body: input.body,
        verseId: input.verseId,
      }),
    );

    const { delivered, failures } = await pushToAll(
      subscriptions,
      payload,
      keys!,
      this.subscriptions,
    );

    if (delivered > 0) return;

    /*
     * Nothing landed. Two different situations, and they are told apart on
     * purpose: every subscription being *gone* is a person who simply has no
     * browser subscribed any more, which is exactly what email is for. A
     * subscription that *failed* is a transport problem, and throwing lets the
     * dispatcher retry it rather than quietly downgrading to email and hiding
     * that push is broken.
     */
    if (failures.length > 0) {
      throw new Error(`Web Push failed: ${failures.join('; ')}`);
    }

    return this.email.send(input);
  }
}

/**
 * What happened when a payload was pushed to every subscription a person has.
 *
 * Returned rather than swallowed because two callers want different things
 * from it. The reminder path only needs "did any of them take it", so it can
 * decide between staying quiet and falling back to email. The test endpoint
 * (§8.4) needs the detail: a person who has just pressed "Turn on" and wants
 * to know whether push actually works is owed the reason it did not, and
 * "nothing happened" is the answer that made this feature impossible to prove
 * in the first place.
 */
export interface PushOutcome {
  /** Subscriptions the push service accepted. */
  readonly delivered: number;
  /**
   * Subscriptions the push service said were gone, and which were deleted.
   *
   * Separate from a failure on purpose: an endpoint that answers 404 or 410 is
   * a browser that has been uninstalled or had its permission revoked. Nothing
   * is broken — there is simply one fewer device — and reporting it as a
   * failure would send someone looking for a fault that is not there.
   */
  readonly removed: number;
  /** One line per subscription that failed, naming the host and the status. */
  readonly failures: readonly string[];
}

/**
 * Pushes one payload to every subscription, reporting each outcome.
 *
 * Extracted from the reminder path so the test endpoint runs exactly the code
 * a real reminder runs — the encryption, the VAPID signature, the dead-endpoint
 * cleanup. A test that took a shortcut past any of those would prove the
 * shortcut works.
 */
export async function pushToAll(
  subscriptions: readonly PushSubscriptionRecord[],
  payload: Buffer,
  keys: VapidKeys,
  repository: Pick<PushSubscriptionRepository, 'removeByEndpoint'>,
): Promise<PushOutcome> {
  let delivered = 0;
  let removed = 0;
  const failures: string[] = [];

  for (const subscription of subscriptions) {
    try {
      const request = buildPushRequest(subscription, payload, keys);
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: new Uint8Array(request.body),
      });

      if (response.ok) {
        delivered += 1;
        continue;
      }

      /*
       * 404 and 410 are the push service saying this endpoint is gone: the
       * browser was uninstalled, the permission revoked, the profile wiped.
       * Deleting the row is the only correct response — keeping it means
       * failing against it on every tick forever, and a queue that always has
       * one failure in it is a queue nobody reads.
       */
      if (response.status === 404 || response.status === 410) {
        await repository.removeByEndpoint(subscription.endpoint);
        removed += 1;
        continue;
      }

      failures.push(`${new URL(subscription.endpoint).host} answered ${response.status}`);
    } catch (cause) {
      failures.push(cause instanceof Error ? cause.message : 'push failed');
    }
  }

  return { delivered, removed, failures };
}

/**
 * The VAPID keys, or null when push is not configured.
 *
 * Null is a supported state rather than a crash: `npm run dev` has to work with
 * no keys (§7.1), and a deployment without them should keep sending reminders
 * by email rather than failing every tick.
 */
export function vapidKeys(): VapidKeys | null {
  const config = loadConfig();
  const publicKey = config.VAPID_PUBLIC_KEY?.trim();
  const privateKey = config.VAPID_PRIVATE_KEY?.trim();
  const subject = config.VAPID_SUBJECT?.trim();

  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

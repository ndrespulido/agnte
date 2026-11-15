import { z } from 'zod';
import { DomainError, uuidv7 } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { PrismaPushSubscriptionRepository } from '../infrastructure/prisma-push-subscription-repository';
import { pushToAll, vapidKeys } from '../infrastructure/push-delivery';

/**
 * Subscribing a browser to Web Push (§8.4).
 *
 * Three small endpoints rather than one: the browser needs the public key
 * *before* it can subscribe, hands the subscription back once it has, and
 * throws it away when someone turns notifications off.
 */

const SubscribeBody = z.object({
  endpoint: z.url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

/**
 * `GET /v1/push/key` — the VAPID public key, or that push is switched off.
 *
 * Authenticated even though the key is public and handed to every browser
 * anyway. Not for the key's sake: an unauthenticated endpoint here would be a
 * free way to ask whether this deployment has push configured, and the app has
 * no reason to answer that to anyone who is not signed in.
 *
 * 200 with `null` rather than 404 when it is unset, for the same reason
 * `/v1/places` answers that it is not configured: "switched off here" is a
 * deployment fact the client should handle, not an error it should retry.
 */
export async function handlePushKey(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const keys = vapidKeys();

  return Response.json(
    { publicKey: keys?.publicKey ?? null },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

/** `POST /v1/push/subscriptions` — remember this browser. */
export async function handleSubscribePush(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const parsed = SubscribeBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      new DomainError('bad_request', 'That is not a push subscription.'),
      422,
      rateLimitHeaders(decision),
    );
  }

  /*
   * No idempotency key, unlike every other write here.
   *
   * The upsert is keyed on the endpoint, which makes this naturally idempotent:
   * the same browser subscribing twice updates one row either way. A key would
   * add a 24-hour window in which a browser that legitimately re-subscribed
   * with *rotated* keys would have its update replayed away — which is the one
   * outcome that actually breaks delivery.
   */
  await new PrismaPushSubscriptionRepository().upsert({
    id: uuidv7(),
    userId: auth.userId,
    endpoint: parsed.data.endpoint,
    p256dh: parsed.data.keys.p256dh,
    auth: parsed.data.keys.auth,
    userAgent: request.headers.get('user-agent'),
  });

  return Response.json(
    { subscribed: true },
    {
      status: 201,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

const UnsubscribeBody = z.object({ endpoint: z.url() });

/** `DELETE /v1/push/subscriptions` — forget it. */
export async function handleUnsubscribePush(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const parsed = UnsubscribeBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      new DomainError('bad_request', 'Send the endpoint to forget.'),
      422,
      rateLimitHeaders(decision),
    );
  }

  // Scoped to the caller: the endpoint is not a secret, so an unscoped delete
  // would let anyone holding one unsubscribe someone else's device.
  const removed = await new PrismaPushSubscriptionRepository().remove(
    auth.userId,
    parsed.data.endpoint,
  );

  return Response.json(
    { removed },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

/**
 * `POST /v1/push/test` — pushes one notification to this account, now.
 *
 * Why this exists at all. Until it did, pressing "Turn on" produced no visible
 * result whatsoever: the subscription was stored, and the next thing that would
 * ever arrive was a reminder, at its own fire time, dispatched by a five-minute
 * cron. A person could not tell a working subscription from a broken one, and
 * neither could anyone trying to prove the feature worked after a deploy. The
 * first real-world report on this feature was "I tried push but didn't
 * understand how it works" — which is what a feature with no feedback feels
 * like from the outside.
 *
 * **Push only, never the email fallback.** `PushWithEmailFallback` is right for
 * a reminder — a promise to interrupt someone must not be dropped because a
 * subscription went stale — and exactly wrong here. An email arriving would let
 * this answer "sent" while push itself was dead, which is worse than no test:
 * it would retire the one question the button exists to settle.
 *
 * It reports counts rather than 204, the same choice the tick route makes: a
 * diagnostic that answers "OK" tells you nothing about what it did.
 *
 * Not idempotent, deliberately. Re-running is the point — someone who has just
 * fixed their notification settings wants to press it again — so there is no
 * idempotency key, and the rate limit is what stops it being a way to spam a
 * device.
 */
export async function handleTestPush(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const headers = { 'cache-control': 'no-store', ...rateLimitHeaders(decision) };

  const keys = vapidKeys();
  if (!keys) {
    // A deployment fact, not a fault: `npm run dev` runs without VAPID keys by
    // design (§7.1). Reported as a successful answer so the client can say
    // "push is switched off on this server" rather than show a failure.
    return Response.json(
      { configured: false, subscriptions: 0, delivered: 0, removed: 0, failures: [] },
      { status: 200, headers },
    );
  }

  const repository = new PrismaPushSubscriptionRepository();
  const subscriptions = await repository.listForUser(auth.userId);

  if (subscriptions.length === 0) {
    return Response.json(
      { configured: true, subscriptions: 0, delivered: 0, removed: 0, failures: [] },
      { status: 200, headers },
    );
  }

  /*
   * Deliberately a payload that reads as a test on the lock screen, and that
   * carries no verse id — there is nothing to open, and `verseId` is the one
   * field in this payload that points at real content.
   */
  const payload = Buffer.from(
    JSON.stringify({
      title: 'Agnte',
      body: 'Notifications are working on this device.',
      verseId: null,
    }),
  );

  const outcome = await pushToAll(subscriptions, payload, keys, repository);

  return Response.json(
    { configured: true, subscriptions: subscriptions.length, ...outcome },
    { status: 200, headers },
  );
}

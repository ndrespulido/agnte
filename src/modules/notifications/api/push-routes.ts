import { z } from 'zod';
import { DomainError, uuidv7 } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { PrismaPushSubscriptionRepository } from '../infrastructure/prisma-push-subscription-repository';
import { vapidKeys } from '../infrastructure/push-delivery';

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

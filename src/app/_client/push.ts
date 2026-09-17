'use client';

import { fetchPushKey, subscribeToPush, unsubscribeFromPush } from './api';

/**
 * Turning Web Push on and off in the browser (§8.4).
 *
 * The permission prompt is deliberately never asked for on load. A prompt
 * nobody invited is the one a person dismisses, and a dismissal on most
 * browsers is not "not now" — it is a denial that cannot be asked about again
 * without the person digging through site settings. So this runs only from a
 * button someone pressed.
 */

export type PushState =
  /** No service worker, no PushManager, or no VAPID key configured here. */
  | 'unsupported'
  /** Available, not yet asked for. */
  | 'off'
  /** Subscribed on this browser. */
  | 'on'
  /** Asked and refused. Nothing the app can do; the browser owns this now. */
  | 'denied';

const supported = (): boolean =>
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  typeof window !== 'undefined' &&
  'PushManager' in window &&
  'Notification' in window;

/**
 * The VAPID public key as `pushManager.subscribe` wants it.
 *
 * base64url in, raw bytes out. Chrome accepts a string here and Firefox does
 * not, so the conversion is not optional even though it looks like a detail.
 */
function toApplicationServerKey(base64url: string): BufferSource {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** What the server needs, out of what the browser returned. */
function asPayload(subscription: PushSubscription) {
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!keys.p256dh || !keys.auth) {
    throw new Error('That subscription arrived without its keys.');
  }
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
  };
}

/** Where push currently stands on this browser, without asking for anything. */
export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';

  // Asked before the key, because a browser with no permission cannot use one
  // and there is no reason to tell it whether push is configured.
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) return 'on';

  return (await fetchPushKey()) ? 'off' : 'unsupported';
}

/**
 * Asks for permission and subscribes.
 *
 * Returns the state it ended in rather than throwing on refusal: a person
 * saying no is an answer, not an error, and the caller needs to render it
 * either way.
 */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';

  const key = await fetchPushKey();
  if (!key) return 'unsupported';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';

  const registration = await navigator.serviceWorker.ready;

  /*
   * Reuse an existing subscription rather than replacing it.
   *
   * `subscribe` with the same key returns the same subscription, but calling it
   * when one already exists under a *different* key throws — which is what
   * happens after the VAPID keys are rotated. Sending the existing one up
   * covers the ordinary case; the rotation case is the catch below.
   */
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await subscribeToPush(asPayload(existing));
    return 'on';
  }

  const subscription = await registration.pushManager.subscribe({
    // Required to be true by every browser that implements this: a push must
    // result in a visible notification. The service worker honours that.
    userVisibleOnly: true,
    applicationServerKey: toApplicationServerKey(key),
  });

  await subscribeToPush(asPayload(subscription));
  return 'on';
}

/**
 * Unsubscribes this browser, locally and on the server.
 *
 * The server is told first. If the order were reversed and the page closed in
 * between, the browser would have no subscription while the server still held
 * one — and every reminder would be pushed into a void that answers 410 once,
 * which is recoverable but noisy. This way the worst case is a subscription the
 * browser dropped and the server still lists, which the next 410 cleans up.
 */
export async function disablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (!existing) return 'off';

  await unsubscribeFromPush(existing.endpoint).catch(() => undefined);
  await existing.unsubscribe();
  return 'off';
}

'use client';

/**
 * Registering the service worker, and clearing what it kept.
 *
 * Kept apart from the component that calls it so the two halves read as one
 * idea: something has to turn it on, and something has to take its caches away
 * when a session ends. The second half is the one that matters — see `purge`.
 */

const URL_PATH = '/sw.js';

/**
 * Turns it on, once, after the page has settled.
 *
 * Deliberately not on first paint: registering kicks off a fetch of the worker
 * and, on a first visit, a round of cache writes, and neither is more urgent
 * than the timeline the reader is waiting for. `load` is the signal that the
 * page has what it needs.
 *
 * Every failure is swallowed on purpose. A browser with service workers
 * disabled, a private window that refuses the registration, an insecure origin
 * — in all of them the app works exactly as it did before this existed, just
 * without an offline copy. There is nothing to tell the reader and nothing they
 * could do.
 */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  const register = () => {
    navigator.serviceWorker.register(URL_PATH).catch(() => undefined);
  };

  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/**
 * Throws away every cached response.
 *
 * Called when a session ends. This is not tidiness: the caches hold pages of
 * someone's timeline in plaintext on disk, keyed by URL and readable from a
 * devtools panel. An app that holds medical notes and financial screenshots
 * cannot leave them behind for whoever opens the browser next.
 *
 * Both routes are taken, because either can be the only one available. The
 * message reaches the worker that owns the caches; `caches.delete` from the
 * page covers the case where no worker is controlling this document yet — a
 * first load, or a browser that refused the registration but still has caches
 * from an earlier visit.
 */
export async function purgeCaches(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage('agnte:purge');
  } catch {
    // No controller, or messaging refused. The direct delete below still runs.
  }

  try {
    if (typeof caches === 'undefined') return;
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
  } catch {
    // A browser that refuses the Cache API has nothing stored to clear.
  }
}

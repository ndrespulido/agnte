/**
 * The service worker (architecture.md §5, §8.1).
 *
 * It earns its place twice over: it is what makes the app open with no signal
 * at all, and it is the read cache §8.1 asks for. (The third use — the Web Push
 * transport for §8.4 — is not built here; there is no `push` handler yet.)
 *
 * ---------------------------------------------------------------------------
 * Runtime caching, not a build-time precache manifest.
 *
 * The usual PWA setup generates a list of every built asset and installs them
 * on first run. That needs a build plugin, a manifest to keep in step with
 * Turbopack's output, and it downloads the whole app before anyone has asked
 * for any of it. Instead this caches what the app actually fetched, as it
 * fetches it.
 *
 * The cost is stated rather than hidden: a browser that has never successfully
 * loaded the app online cannot open it offline. There is nothing to serve. In
 * exchange there is no build step, nothing to drift, and the cache only ever
 * holds pages someone actually opened.
 * ---------------------------------------------------------------------------
 *
 * Hand-written rather than Serwist (which the Next PWA guide suggests) for the
 * reason the kernel's uuidv7 is hand-written: the whole of it is the four
 * decisions in `strategyFor`, and those are the part worth owning, reading and
 * testing directly.
 */

/*
 * Bumping this name is how a cache is retired: `activate` deletes every cache
 * whose name is not one of these, so a change to what is stored here only needs
 * a new version, not a migration.
 */
const VERSION = 'v1';
const SHELL = `agnte-shell-${VERSION}`;
const DATA = `agnte-data-${VERSION}`;
const KEEP = [SHELL, DATA];

/**
 * How a request is served. Four rules, and the interesting one is the last.
 *
 * - `static`   Next's own output under /_next/static. Content-hashed, so a
 *              given URL never changes and cache-first is exactly right.
 * - `shell`    The document itself. Network-first: the app should update the
 *              moment it can, and fall back to the last copy when it cannot.
 * - `data`     The timeline, and only the timeline. §8.1 names it — deep time
 *              and dashboards stay online-only, and search is a question about
 *              the present that a stale answer would misrepresent.
 * - `pass`     Everything else, untouched. Writes especially: the outbox
 *              (§8.1) owns those, and a service worker replaying them too
 *              would be a second queue with its own idea of the order.
 */
function strategyFor(url, method) {
  // Writes are never cached and never intercepted. Reads are all that follow.
  if (method !== 'GET') return 'pass';

  const target = new URL(url);

  // Cross-origin: object storage, mostly. Left alone — see the note on
  // thumbnails in the architecture doc for why they are not cached yet.
  if (target.origin !== self.location.origin) return 'pass';

  if (target.pathname.startsWith('/_next/static/')) return 'static';

  if (target.pathname === '/v1/timeline') return 'data';

  // The rest of the API. Not cached: a dashboard or a search answer served from
  // yesterday is a wrong answer rather than an old one.
  if (target.pathname.startsWith('/v1/')) return 'pass';

  // The service worker must never serve itself from a cache, or a broken one
  // becomes permanent.
  if (target.pathname === '/sw.js') return 'pass';

  return 'shell';
}

self.addEventListener('install', () => {
  // Nothing to precache, so take over as soon as the browser allows rather than
  // waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !KEEP.includes(name)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/**
 * Forget everything.
 *
 * Sent by the app when a session ends. This is not housekeeping: the caches
 * hold a person's timeline — medical notes and financial screenshots, in this
 * app's own words — in plaintext on disk, keyed only by URL. Signing out has to
 * take them with it, or the next person to open this browser is one devtools
 * panel away from the last person's record.
 */
self.addEventListener('message', (event) => {
  if (event.data !== 'agnte:purge') return;
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    })(),
  );
});

/**
 * The key a response is stored under, which is not always its URL.
 *
 * The timeline is asked for relative to an anchor — "the page around this
 * instant" — and the app anchors on `new Date()` every time it opens. Keyed on
 * the URL as sent, every request would be a new key and the cache would never
 * answer anything: entries written and never read.
 *
 * So the anchor is dropped from the key and everything else kept. `direction`
 * and any `cursor` still separate the pages, and what comes back offline is the
 * last copy of *this* page of the timeline, taken at whatever instant it was
 * last fetched. A few hours of drift in a fallback view is the right trade for
 * a fallback view that exists at all.
 */
function cacheKeyFor(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/v1/timeline') return request.url;

  url.searchParams.delete('anchor');
  return url.toString();
}

self.addEventListener('fetch', (event) => {
  const strategy = strategyFor(event.request.url, event.request.method);
  if (strategy === 'pass') return;

  if (strategy === 'static') {
    event.respondWith(cacheFirst(event.request, SHELL, event.request.url));
    return;
  }

  event.respondWith(
    networkFirst(
      event.request,
      strategy === 'data' ? DATA : SHELL,
      cacheKeyFor(event.request),
    ),
  );
});

/** Content-hashed URLs only, so a hit is always correct and never stale. */
async function cacheFirst(request, cacheName, key) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(key, response.clone());
  return response;
}

/**
 * The network when it answers, the last good copy when it does not.
 *
 * Only `ok` responses are stored. Caching a 401 would be worse than not caching
 * at all: an expired token would be answered from the cache for as long as the
 * entry lived, and the app would keep signing the person out with no network
 * involved.
 */
async function networkFirst(request, cacheName, key) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch (cause) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw cause;
  }
}

/**
 * Opening straight to one verse from outside the app.
 *
 * The service worker's `notificationclick` navigates to `/?verse=<id>` when a
 * reminder is tapped (public/sw.js). Until this existed that landed on the
 * timeline and nothing else happened — the notification opened the app but not
 * the thing it was about, which is most of the point of tapping it.
 *
 * Read from `window.location` in an effect rather than through Next's
 * `useSearchParams`. That hook makes the client tree it sits in
 * client-side-rendered up to the nearest Suspense boundary, and a *static* page
 * that calls it without one fails the production build outright
 * (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md`).
 * This tree is already fully client-rendered, so the hook would buy nothing and
 * cost a build.
 */

/** UUIDv7, as the app mints them. Any version, since only the shape matters. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The verse id in a query string, if there is a credible one.
 *
 * Validated rather than passed through. `?verse=` is reachable by anyone who
 * can get a link in front of someone, and the value goes straight into a fetch
 * path — a shape check here means a crafted parameter produces nothing instead
 * of a request to somewhere else entirely.
 */
export function verseIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('verse');
  if (value === null) return null;
  return UUID.test(value) ? value.toLowerCase() : null;
}

/**
 * The same URL with `verse` taken out, for replacing history with.
 *
 * Without this, reopening the tab or pressing reload re-opens the verse
 * forever, because the parameter is still sitting in the address bar. Returns
 * a path, and keeps any other parameters, so this stays usable if a second
 * deep link is ever added.
 */
export function withoutVerse(url: string): string {
  const parsed = new URL(url, 'http://localhost');
  parsed.searchParams.delete('verse');

  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query === '' ? '' : `?${query}`}${parsed.hash}`;
}

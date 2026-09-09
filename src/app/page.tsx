import { loadConfig } from '@/shared/infra/config';
import { App } from './_client/App';

export const metadata = {
  title: 'Agnte',
};

/**
 * Dynamic because of the nonce.
 *
 * The CSP in `src/proxy.ts` mints a fresh nonce per request and Next injects it
 * during server rendering. A statically generated page is built before any
 * request exists, so it has no nonce to carry — its scripts would be blocked by
 * the very policy that is meant to protect it.
 */
export const dynamic = 'force-dynamic';

/**
 * The app.
 *
 * A thin server component around a client one: everything here needs
 * localStorage and IntersectionObserver, so there is nothing to render on the
 * server that would not immediately be replaced.
 */
export default function HomePage() {
  /**
   * Whether to offer Google at all, decided here rather than by asking the
   * API.
   *
   * This page is already server-rendered per request (see `dynamic` above), so
   * the answer costs nothing and arrives with the first byte — no round trip,
   * and no flash of a button that turns out not to work. `/v1/health` knows
   * the same thing, but it is a diagnostic endpoint that also reports the
   * database and the commit, and the sign-in page has no business asking an
   * unauthenticated caller's browser to fetch that.
   *
   * The common case for `false` is a preview environment: Google will not
   * accept a wildcard redirect URI, so a per-pull-request URL cannot be
   * registered in advance (docs/operations.md §2f).
   */
  const googleEnabled = Boolean(loadConfig().GOOGLE_CLIENT_ID);

  return <App googleEnabled={googleEnabled} />;
}

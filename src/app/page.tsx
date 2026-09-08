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
  return <App />;
}

import { App } from '../_client/App';

export const metadata = {
  title: 'Agnte',
};

/**
 * The app.
 *
 * A thin server component around a client one: everything here needs
 * localStorage and IntersectionObserver, so there is nothing to render on the
 * server that would not immediately be replaced.
 */
export default function TimelinePage() {
  return <App />;
}

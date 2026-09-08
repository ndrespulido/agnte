'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { QuickAdd } from './QuickAdd';
import { SignIn } from './SignIn';
import { Timeline } from './Timeline';
import {
  getServerSessionSnapshot,
  getSessionSnapshot,
  signOut,
  subscribeToSession,
} from './session';

/**
 * The shell: a glass date header pinned to the top, the timeline beneath it,
 * and the add button in the bottom-right corner.
 *
 * The session is read through `useSyncExternalStore` rather than an effect. The
 * effect version renders the sign-in screen for one frame before localStorage
 * is read, which a signed-in user experiences as having been logged out on
 * every open. 'unknown' during server rendering is what lets this render
 * nothing until the browser has actually answered.
 */
export function App() {
  const session = useSyncExternalStore(
    subscribeToSession,
    getSessionSnapshot,
    getServerSessionSnapshot,
  );

  const [dateLabel, setDateLabel] = useState('Today');
  /**
   * The timeline's anchor. Replacing it is how a write refetches: a new Date
   * both re-runs the query and moves the centre to now, which is where a
   * just-added verse is.
   */
  const [anchor, setAnchor] = useState(() => new Date());

  const onDateChange = useCallback((label: string) => setDateLabel(label), []);

  if (session === 'unknown') return null;
  if (session === 'signed-out') return <SignIn onSignedIn={() => undefined} />;

  return (
    <>
      <header className="date-header">
        <h1 className="date-label">{dateLabel}</h1>
        <button type="button" className="quiet sign-out" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      <main className="app-main">
        <Timeline onDateChange={onDateChange} anchor={anchor} />
      </main>

      <QuickAdd onAdded={() => setAnchor(new Date())} />
    </>
  );
}

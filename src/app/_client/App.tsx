'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { QuickAdd } from './QuickAdd';
import { SignIn } from './SignIn';
import { Timeline } from './Timeline';
import { VerseDetail } from './VerseDetail';
import {
  completeGoogleSignIn,
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
export function App({ googleEnabled }: { googleEnabled: boolean }) {
  const session = useSyncExternalStore(
    subscribeToSession,
    getSessionSnapshot,
    getServerSessionSnapshot,
  );

  const [googleError, setGoogleError] = useState<string | null>(null);

  /**
   * If this load is the redirect back from Google, finish the sign-in.
   *
   * Runs before anything else can care about the session: `completeGoogleSignIn`
   * stores the tokens, which notifies the external store above and re-renders
   * this component as signed in. A load that is not an OAuth return does
   * nothing and resolves false.
   */
  useEffect(() => {
    completeGoogleSignIn().catch((cause: unknown) => {
      setGoogleError(
        cause instanceof Error ? cause.message : 'Could not finish signing in.',
      );
    });
  }, []);

  const [dateLabel, setDateLabel] = useState('Today');
  /**
   * The timeline's anchor. Replacing it is how a write refetches: a new Date
   * both re-runs the query and moves the centre to now, which is where a
   * just-added verse is.
   */
  const [anchor, setAnchor] = useState(() => new Date());

  /**
   * The verse being looked at, over the timeline rather than instead of it.
   *
   * An overlay, not a route: the timeline behind keeps its scroll position and
   * its loaded pages, which a navigation would throw away and have to rebuild
   * a page at a time on the way back.
   */
  const [openVerseId, setOpenVerseId] = useState<string | null>(null);

  const onDateChange = useCallback((label: string) => setDateLabel(label), []);
  const onOpen = useCallback((verseId: string) => setOpenVerseId(verseId), []);

  if (session === 'unknown') return null;
  if (session === 'signed-out')
    return (
      <SignIn
        onSignedIn={() => undefined}
        googleEnabled={googleEnabled}
        notice={googleError}
      />
    );

  return (
    <>
      <header className="date-header">
        <h1 className="date-label">{dateLabel}</h1>
        <button type="button" className="quiet sign-out" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>

      <main className="app-main">
        <Timeline onDateChange={onDateChange} anchor={anchor} onOpen={onOpen} />
      </main>

      <QuickAdd onAdded={() => setAnchor(new Date())} />

      {openVerseId !== null ? (
        <VerseDetail
          verseId={openVerseId}
          onClose={() => setOpenVerseId(null)}
          onChanged={() => setAnchor(new Date())}
        />
      ) : null}
    </>
  );
}

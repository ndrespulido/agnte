'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { QuickAdd } from './QuickAdd';
import { SignIn } from './SignIn';
import { Timeline } from './Timeline';
import { VerseDetail } from './VerseDetail';
import { ChangePassword } from './ChangePassword';
import { Tags } from './Tags';
import { Dashboard } from './Dashboard';
import { Menu } from './Menu';
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
   * What the email verification link left behind.
   *
   * That link is a `/v1/...` API route, and until it learned to redirect, a
   * person clicking it landed on raw JSON. It now sends a browser back here
   * with a flag, and this is what turns the flag into a sentence.
   */
  const [verifyNotice, setVerifyNotice] = useState<{
    text: string;
    tone: 'error' | 'success';
  } | null>(null);

  /**
   * The same guard ResetPassword documents, for the same reason: this effect
   * strips the query string, so Strict Mode's second run in development would
   * read an already-cleaned URL and wipe the message it just set.
   */
  const readParams = useRef(false);

  useEffect(() => {
    if (readParams.current) return;
    readParams.current = true;

    const params = new URLSearchParams(window.location.search);
    const verified = params.get('verified');
    const failed = params.get('verifyError');
    if (!verified && !failed) return;

    // Scoped exception to react-hooks/set-state-in-effect, as in
    // ResetPassword: the dependency list is empty, so this runs once and
    // cannot cascade, and a lazy initialiser would have to touch `window`
    // during server rendering.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVerifyNotice(
      verified
        ? { text: 'Email confirmed. Sign in to start.', tone: 'success' }
        : {
            text:
              failed === 'expired'
                ? 'That confirmation link has expired. Register again to get a new one.'
                : 'That confirmation link is not valid. Check you copied the whole address.',
            tone: 'error',
          },
    );

    // Out of the address bar, so a refresh does not re-announce it.
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

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
  const [changingPassword, setChangingPassword] = useState(false);

  /**
   * The tag list, and the dashboard reached from it.
   *
   * Two pieces of state rather than one route, and stacked rather than
   * swapped: closing a dashboard returns to the list it was opened from, which
   * is what someone comparing two tags expects. Overlays for the same reason
   * VerseDetail is one — the timeline behind keeps its scroll position and its
   * loaded pages.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  const [browsingTags, setBrowsingTags] = useState(false);
  const [dashboardTagId, setDashboardTagId] = useState<string | null>(null);

  const onDateChange = useCallback((label: string) => setDateLabel(label), []);
  const onOpen = useCallback((verseId: string) => setOpenVerseId(verseId), []);

  if (session === 'unknown') return null;
  if (session === 'signed-out')
    return (
      <SignIn
        onSignedIn={() => undefined}
        googleEnabled={googleEnabled}
        notice={googleError ? { text: googleError, tone: 'error' } : verifyNotice}
      />
    );

  return (
    <>
      <header className="date-header">
        <h1 className="date-label">{dateLabel}</h1>
        <button
          type="button"
          className="quiet sign-out"
          onClick={() => setMenuOpen(true)}
          aria-label="Menu"
        >
          Menu
        </button>
      </header>

      <main className="app-main">
        <Timeline onDateChange={onDateChange} anchor={anchor} onOpen={onOpen} />
      </main>

      <QuickAdd onAdded={() => setAnchor(new Date())} />

      {menuOpen ? (
        <Menu
          onTags={() => {
            setMenuOpen(false);
            setBrowsingTags(true);
          }}
          onPassword={() => {
            setMenuOpen(false);
            setChangingPassword(true);
          }}
          onSignOut={() => void signOut()}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}

      {changingPassword ? (
        <ChangePassword onClose={() => setChangingPassword(false)} />
      ) : null}

      {browsingTags ? (
        <Tags
          onOpen={setDashboardTagId}
          onClose={() => setBrowsingTags(false)}
          covered={dashboardTagId !== null}
        />
      ) : null}

      {dashboardTagId !== null ? (
        <Dashboard tagId={dashboardTagId} onClose={() => setDashboardTagId(null)} />
      ) : null}

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

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
import { Reminders } from './Reminders';
import { YourData } from './YourData';
import {
  completeGoogleSignIn,
  getServerSessionSnapshot,
  getSessionSnapshot,
  signOut,
  subscribeToSession,
} from './session';
import { startSync } from './sync';
import { purgeCaches, registerServiceWorker } from './service-worker';
import { verseIdFromSearch, withoutVerse } from './deep-link';
import { toggleFilterTag } from './timeline-filter';
import { fetchTags, type TagView } from './api';

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

  /**
   * Start draining the outbox once there is a session to drain it with.
   *
   * Here rather than at module load because a queued write needs a token: the
   * queue survives a reload, so the first thing this does on every open is send
   * whatever the last session left behind (§8.1). `startSync` is idempotent, so
   * a re-render or a second sign-in does not start a second loop.
   */
  useEffect(() => {
    if (session === 'signed-in') startSync();
  }, [session]);

  /**
   * Turn the service worker on, once, whatever the session says.
   *
   * Outside the session check above because the shell and its assets are worth
   * caching for the sign-in screen too — and because a person who is signed out
   * on this device is exactly the person whose next load might have no signal.
   */
  useEffect(() => {
    registerServiceWorker();
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
  /**
   * `/?verse=<id>` — where a tapped reminder lands (deep-link.ts).
   *
   * Read in the initialiser rather than an effect. An effect would setState
   * synchronously on mount, which is the cascading render the lint rule is
   * there to stop, and it would also open the overlay one frame late. Safe
   * against hydration because the server renders nothing at all until the
   * session has answered (`session === 'unknown'` below), so there is no
   * server-rendered markup for this to disagree with.
   */
  const [openVerseId, setOpenVerseId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : verseIdFromSearch(window.location.search),
  );
  const [changingPassword, setChangingPassword] = useState(false);

  /**
   * Take the parameter back out of the address bar.
   *
   * This half *is* an effect's job — updating an external system to match
   * React's state — and it is why the read above is split from the clear.
   * `replaceState` rather than a navigation: the verse is an overlay, not a
   * route, so pushing history would make Back close the overlay on one press
   * and leave the page on the next, two meanings for one gesture. Clearing it
   * also stops a reload reopening the same verse indefinitely.
   */
  useEffect(() => {
    if (verseIdFromSearch(window.location.search) === null) return;
    window.history.replaceState(null, '', withoutVerse(window.location.href));
  }, []);

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

  /**
   * The tags the timeline is narrowed to. Empty is the whole timeline.
   *
   * Held here rather than in Timeline because the chips that show and clear it
   * live in the header, above the timeline — two copies of the same set in two
   * components would drift, and the one the query uses would not be the one on
   * screen.
   */
  const [filterTagIds, setFilterTagIds] = useState<readonly string[]>([]);

  /**
   * The text filter, and whether its field is on screen.
   *
   * Two pieces of state rather than one: closing the field clears the text, but
   * text with the field hidden would be a timeline silently narrowed by
   * something invisible — the worst outcome this whole bar exists to prevent.
   * So the field is shown whenever there is text, and clearing happens on the
   * way out.
   */
  const [searching, setSearching] = useState(false);
  const [filterText, setFilterText] = useState('');

  /**
   * Names for the filtered tags, for the chips and the empty state.
   *
   * Loaded once rather than derived from the rows on screen: under a filter
   * that matches nothing there are no rows to read a label from, and that is
   * exactly the case where the message has to name the tag.
   */
  const [allTags, setAllTags] = useState<TagView[]>([]);
  useEffect(() => {
    if (filterTagIds.length === 0 && !searching) return;
    let cancelled = false;
    fetchTags()
      .then((tags) => {
        if (!cancelled) setAllTags(tags);
      })
      // Silent: the bar is a convenience, and a failure to list tags must not
      // stop someone typing.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [filterTagIds.length, searching]);

  const filterLabels = filterTagIds.map(
    (id) => allTags.find((tag) => tag.id === id)?.label ?? 'that tag',
  );
  const [browsingReminders, setBrowsingReminders] = useState(false);
  const [browsingData, setBrowsingData] = useState(false);
  const [dashboardTagId, setDashboardTagId] = useState<string | null>(null);

  /**
   * Sign out, and take the offline copy with it.
   *
   * The caches hold pages of the timeline in plaintext; leaving them behind
   * would mean the next person to open this browser could read the last
   * person's record without a token. Purged before the tokens go, so the
   * request that ends the session on the server still has one to send.
   */
  const endSession = useCallback(async () => {
    await purgeCaches();
    await signOut();
  }, []);

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
        <div className="header-actions">
          {/*
            Search, permanently, beside the menu rather than inside it.

            It is the one action reached often enough to earn a place in a
            header this deliberately sparse — a menu is where things go when
            they are occasional, and looking for something is not.

            A glyph rather than the word, because the word next to "Menu"
            reads as two menus. Drawn inline: one small shape is cheaper than
            a request, and it inherits `currentColor` so it follows the theme
            without a second asset for dark mode.
          */}
          <button
            type="button"
            className="quiet header-icon"
            onClick={() =>
              setSearching((open) => {
                // Closing clears, so the timeline is never narrowed by text
                // that has nowhere on screen to be seen.
                if (open) setFilterText('');
                return !open;
              })
            }
            aria-label="Search"
            aria-expanded={searching}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <circle
                cx="8.5"
                cy="8.5"
                r="5.25"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <line
                x1="12.5"
                y1="12.5"
                x2="17"
                y2="17"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="quiet sign-out"
            onClick={() => setMenuOpen(true)}
            aria-label="Menu"
          >
            Menu
          </button>
        </div>
      </header>

      <main className="app-main">
        {/*
          The filter, where it can be seen and undone.

          Under the header rather than inside a sheet: a timeline silently
          showing a subset is the worst outcome here, so whatever narrows it —
          text or tags — has to be visible on the same screen as the rows it is
          hiding, and removable from there.
        */}
        {searching || filterTagIds.length > 0 ? (
          <div className="filter-bar">
            {searching ? (
              <input
                type="search"
                className="filter-search"
                value={filterText}
                onChange={(event) => setFilterText(event.target.value)}
                placeholder="Search the timeline"
                aria-label="Search the timeline"
                autoFocus
              />
            ) : null}

            <div className="filter-chips">
              {filterTagIds.map((id, index) => (
                <button
                  key={id}
                  type="button"
                  className="tag chosen"
                  onClick={() =>
                    setFilterTagIds((current) => toggleFilterTag(current, id))
                  }
                  aria-label={`Stop filtering by ${filterLabels[index]}`}
                >
                  {filterLabels[index]} ×
                </button>
              ))}

              {/*
                The rest of the tags, offered only while searching.

                Filtering by tapping a tag on a row only reaches tags you can
                already see — if you have never scrolled to a `.dentist` verse
                there is no way to narrow to it. This is that way. It is not on
                screen permanently because the timeline is the thing to read,
                and a wall of chips above it is not.

                All of them, uncapped: the bar is two rows that scroll sideways
                (globals.css), so a long list costs width rather than height.
              */}
              {searching
                ? allTags
                    .filter((tag) => !filterTagIds.includes(tag.id))
                    .map((tag) => (
                      <button
                        key={tag.id}
                        type="button"
                        className="tag"
                        onClick={() =>
                          setFilterTagIds((current) => toggleFilterTag(current, tag.id))
                        }
                      >
                        {tag.label}
                      </button>
                    ))
                : null}
            </div>

            {filterTagIds.length > 0 || filterText !== '' ? (
              <button
                type="button"
                className="quiet filter-clear"
                onClick={() => {
                  setFilterTagIds([]);
                  setFilterText('');
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}
        <Timeline
          onDateChange={onDateChange}
          anchor={anchor}
          onOpen={onOpen}
          tagIds={filterTagIds}
          tagLabels={filterLabels}
          text={filterText}
          onFilterTag={(tagId) =>
            setFilterTagIds((current) => toggleFilterTag(current, tagId))
          }
        />
      </main>

      <QuickAdd onAdded={() => setAnchor(new Date())} />

      {menuOpen ? (
        <Menu
          onTags={() => {
            setMenuOpen(false);
            setBrowsingTags(true);
          }}
          onReminders={() => {
            setMenuOpen(false);
            setBrowsingReminders(true);
          }}
          onYourData={() => {
            setMenuOpen(false);
            setBrowsingData(true);
          }}
          onPassword={() => {
            setMenuOpen(false);
            setChangingPassword(true);
          }}
          onSignOut={() => void endSession()}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}

      {changingPassword ? (
        <ChangePassword onClose={() => setChangingPassword(false)} />
      ) : null}

      {browsingReminders ? (
        <Reminders
          onClose={() => setBrowsingReminders(false)}
          onOpenVerse={(verseId) => {
            setBrowsingReminders(false);
            setOpenVerseId(verseId);
          }}
          onScheduled={() => setAnchor(new Date())}
        />
      ) : null}

      {browsingData ? (
        <YourData
          onClose={() => setBrowsingData(false)}
          onErased={() => {
            setBrowsingData(false);
            void endSession();
          }}
        />
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

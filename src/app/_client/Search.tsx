'use client';

import { useEffect, useRef, useState } from 'react';
import { searchVerses, type VerseView } from './api';
import { headerLabel, placementOf, timeLabel } from './format';

/**
 * Full-text search (§8.2), on its own surface.
 *
 * Deliberately not part of the timeline. The timeline is a date column you
 * scroll in two directions; these results are ordered by relevance, and a
 * ranked list dropped into a chronological scroll is neither one thing nor the
 * other — the date headers stop meaning anything and the ordering looks like a
 * bug. So: its own sheet, its own list, and a result opens the verse in the
 * same detail view everything else does.
 *
 * Text only for now. The route also takes a date range, a minimum rating,
 * has-media and tags; none of them are surfaced yet.
 */

/** How long to wait after a keystroke before asking the server. */
const DEBOUNCE_MS = 250;
const LIMIT = 20;

export function Search({
  onClose,
  onOpenVerse,
}: {
  onClose: () => void;
  onOpenVerse: (verseId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<VerseView[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which query the answer on screen belongs to.
   *
   * Without it a slow request for "bar" can land after a fast one for
   * "barcelona" and overwrite it, which shows results for something the person
   * has already finished typing past.
   */
  const latest = useRef(0);

  useEffect(() => {
    const text = query.trim();

    if (text === '') {
      // Nothing to set: `Results` renders the placeholder from the empty query
      // itself, so clearing state here would only be a synchronous setState in
      // an effect — a cascading render for something already derivable.
      // The token still moves, so a reply to the query just deleted is ignored.
      latest.current += 1;
      return;
    }

    // Debounced: a request per keystroke is rate-limited away and answers the
    // prefix rather than the word.
    const token = (latest.current += 1);

    const timer = setTimeout(() => {
      // Set here rather than in the effect body: during the debounce pause
      // nothing is in flight, so "Searching…" would be a lie for 250ms — and a
      // synchronous setState in an effect is a cascading render besides.
      setBusy(true);
      searchVerses(text, { limit: LIMIT })
        .then((page) => {
          if (token !== latest.current) return;
          setResults(page.verses);
          setMore(page.nextCursor !== null);
          setError(null);
        })
        .catch((cause: unknown) => {
          if (token !== latest.current) return;
          setError(cause instanceof Error ? cause.message : 'Could not search.');
          setResults(null);
        })
        .finally(() => {
          if (token === latest.current) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet search"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dashboard-title">Search</h2>

        <label className="field">
          What are you looking for
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="barcelona, tablet, the blue one"
            autoFocus
          />
        </label>

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <Results
          query={query.trim()}
          results={results}
          busy={busy}
          more={more}
          onOpenVerse={onOpenVerse}
        />

        <div className="sheet-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Results({
  query,
  results,
  busy,
  more,
  onOpenVerse,
}: {
  query: string;
  results: VerseView[] | null;
  busy: boolean;
  more: boolean;
  onOpenVerse: (verseId: string) => void;
}) {
  if (query === '') {
    return (
      <p className="notice">
        Searches your notes, your properties and your tag names. Ranked by how well they
        match, not by date.
      </p>
    );
  }

  // `busy` with results already on screen keeps the old ones rather than
  // blanking: a list that empties on every keystroke reads as "no matches".
  if (results === null) return busy ? <p className="notice">Searching…</p> : null;

  if (results.length === 0) {
    return <p className="notice">Nothing matches “{query}”.</p>;
  }

  // One `now` for the whole list, so two results rendered in the same pass
  // cannot disagree about where "today" is.
  const now = new Date();

  return (
    <>
      <ul className="search-results">
        {results.map((verse) => (
          <li key={verse.id}>
            <button
              type="button"
              className="search-result"
              onClick={() => onOpenVerse(verse.id)}
            >
              <span className="search-when">{whenOf(verse, now)}</span>
              <span className="search-text">{summaryOf(verse)}</span>
              <span className="verse-tags">
                {verse.tags.map((tag) => (
                  <span key={tag.id} className="tag">
                    {tag.label}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/*
        Said rather than paged. A "load more" here would be the second-best
        answer to "there are too many": the better one is a narrower search,
        and saying the list is cut off is what prompts it.
      */}
      {more ? (
        <p className="quiet-note">
          Showing the {LIMIT} best matches. Add a word to narrow it.
        </p>
      ) : null}
    </>
  );
}

/** The date, in the timeline's own words, so the two surfaces agree. */
function whenOf(verse: VerseView, now: Date): string {
  const placement = placementOf(verse);
  const day = headerLabel(placement, now);
  const time = timeLabel(placement);
  return time === null ? day : `${day}, ${time}`;
}

/**
 * What to show as the line of the result.
 *
 * `xp` when there is one. A Verse can legitimately be media and a tag and
 * nothing else (CLAUDE.md), and a blank row would be unreadable — so those
 * fall back to the location, then to saying plainly what the row is.
 */
function summaryOf(verse: VerseView): string {
  const xp = verse.xp?.trim();
  if (xp) return xp;
  if (verse.location?.trim()) return verse.location.trim();
  return verse.media.length > 0 ? `${verse.media.length} attached` : 'No note';
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchTags, searchVerses, type TagView, type VerseView } from './api';
import { headerLabel, placementOf, timeLabel } from './format';
import { toggleFilterTag } from './timeline-filter';

/**
 * Full-text search (§8.2), on its own surface.
 *
 * Its own sheet rather than a mode of the timeline, because the two answer
 * different questions: the timeline is where you scroll to remember, and this
 * is where you go when you already know what you are looking for. Both are
 * newest first, so a result and a row read the same way round.
 *
 * The shape is: a box at the top, your tags under it, results underneath, all
 * updating as you type. Nothing to submit — there is no moment where the app
 * has your query and is waiting to be told to use it.
 */

/** How long to wait after a keystroke before asking the server. */
const DEBOUNCE_MS = 250;
const LIMIT = 20;

/**
 * How many tags the bar shows before it stops.
 *
 * A tag list grows without limit and this sits above the results — past a
 * couple of rows of chips the thing someone came to read is off screen. The
 * rest stay reachable by typing, since a tag name is searchable text.
 */
const TAG_BAR_LIMIT = 12;

export function Search({
  onClose,
  onOpenVerse,
}: {
  onClose: () => void;
  onOpenVerse: (verseId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [tagIds, setTagIds] = useState<readonly string[]>([]);
  const [tags, setTags] = useState<TagView[]>([]);
  const [results, setResults] = useState<VerseView[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which request the answer on screen belongs to.
   *
   * Without it a slow request for "bar" can land after a fast one for
   * "barcelona" and overwrite it, which shows results for something the person
   * has already finished typing past. It counts every request, not every
   * keystroke, so a tag toggle is ordered against the typing too.
   */
  const latest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetchTags()
      .then((list) => {
        if (!cancelled) setTags(list);
      })
      // Silent: the bar is a convenience. A failure to list tags must not stop
      // someone searching, and there is nowhere sensible to put the complaint.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * A stable identity for the filter, so the effect below is not re-run by a
   * fresh array on every render.
   */
  const filterKey = tagIds.join(',');

  useEffect(() => {
    const text = query.trim();
    const chosen = filterKey === '' ? [] : filterKey.split(',');

    /*
     * Tags alone are a search.
     *
     * Picking `.flight` with an empty box means "everything filed under
     * .flight", newest first — which is the natural reading of tapping a tag,
     * and the thing that makes the bar worth having before anything is typed.
     * The route needs *some* query text, so a tag-only search asks for the
     * tag's own name: it is in the search vector (§8.2), so every verse
     * carrying the tag matches it.
     */
    const names = chosen
      .map((id) => tags.find((tag) => tag.id === id)?.name)
      .filter((name): name is string => name !== undefined);

    const effective = text !== '' ? text : names.join(' or ');

    if (effective === '') {
      // Nothing to ask for. `Results` renders the invitation from the empty
      // state itself, so there is nothing to clear here — and a synchronous
      // setState in an effect is a cascading render. The token still moves, so
      // a reply to a query already abandoned is ignored.
      latest.current += 1;
      return;
    }

    const token = (latest.current += 1);

    const timer = setTimeout(() => {
      // Set inside the timer: during the debounce pause nothing is in flight,
      // so "Searching…" would be a lie for 250ms.
      setBusy(true);
      searchVerses(effective, { limit: LIMIT, tagIds: chosen })
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
  }, [query, filterKey, tags]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Chosen tags first, so a filter never scrolls out of the bar it was set in.
  const ordered = [
    ...tags.filter((tag) => tagIds.includes(tag.id)),
    ...tags.filter((tag) => !tagIds.includes(tag.id)),
  ];
  const shown = ordered.slice(0, TAG_BAR_LIMIT);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet search"
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-box">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            aria-label="Search"
            autoFocus
          />
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>

        {/*
          The tags, before anything is typed.

          They are the fastest way into a life-sized timeline — most of what
          someone wants is "the restaurants" or "that trip", which is a tag and
          not a word. Putting them above the results means the filter is never
          a thing you have to go and find.
        */}
        {shown.length > 0 ? (
          <div className="search-tags">
            {shown.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={tagIds.includes(tag.id) ? 'tag chosen' : 'tag'}
                aria-pressed={tagIds.includes(tag.id)}
                onClick={() => setTagIds((current) => toggleFilterTag(current, tag.id))}
              >
                {tag.label}
              </button>
            ))}
          </div>
        ) : null}

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        <Results
          query={query.trim()}
          tagIds={tagIds}
          results={results}
          busy={busy}
          more={more}
          onOpenVerse={onOpenVerse}
        />
      </div>
    </div>
  );
}

function Results({
  query,
  tagIds,
  results,
  busy,
  more,
  onOpenVerse,
}: {
  query: string;
  tagIds: readonly string[];
  results: VerseView[] | null;
  busy: boolean;
  more: boolean;
  onOpenVerse: (verseId: string) => void;
}) {
  const asked = query !== '' || tagIds.length > 0;

  if (!asked) {
    return (
      <p className="notice">
        Pick a tag, or type. Searches your notes, your properties and your tag names —
        newest first.
      </p>
    );
  }

  // Keeping the old results while a new request is in flight, rather than
  // blanking: a list that empties on every keystroke reads as "no matches".
  if (results === null) return busy ? <p className="notice">Searching…</p> : null;

  if (results.length === 0) {
    return (
      <p className="notice">
        {query === '' ? 'Nothing filed under that.' : `Nothing matches “${query}”.`}
      </p>
    );
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
          The {LIMIT} most recent. Add a word or a tag to narrow it.
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

'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchTimeline, type VerseView } from './api';
import { clearTokens, NotSignedIn } from './session';
import { headerLabel, placementOf, sectionKey, timeLabel } from './format';

/**
 * The timeline: today in the middle, the future above it, the past below.
 *
 * Time runs downward, so the column reads farthest-future → today → deepest
 * past, and "scroll up to see what's coming" matches the way the date header
 * counts backwards as you go down.
 *
 * The future half used to be deliberately absent: the API had it, but a column
 * that grows from both ends needs a scroll anchor to stay put while rows are
 * prepended, and until dates could be *chosen* there was nothing to look
 * forward to. Both halves of that changed — the add sheet takes an
 * `eventStart` now, so a verse can be written into the future and has to be
 * readable there.
 *
 * The anchoring is the whole difficulty. Prepending above the viewport pushes
 * everything down under the reader's thumb. `overflow-anchor: auto` is the
 * browser's own fix and Chrome and Firefox implement it — Safari does not, and
 * this app is iOS-first, so it is done by hand: measure the scroll height
 * before the rows go in, restore the difference after, in a layout effect so
 * it lands before paint rather than as a visible jump.
 */

interface Section {
  key: string;
  label: string;
  verses: VerseView[];
}

/** How many rows each direction loads at a time. */
const PAGE = 10;

export function Timeline({
  onDateChange,
  anchor,
  onOpen,
}: {
  /** Reports the date of whatever is under the sticky header. */
  onDateChange: (label: string) => void;
  /** A row was tapped: the shell opens the detail view over the timeline. */
  onOpen: (verseId: string) => void;
  /**
   * The point the timeline runs back from. Owned by the shell rather than
   * computed here: a `new Date()` recomputed on render would move mid-scroll
   * and quietly change which page comes back next, and the shell needs to
   * replace it after a write anyway.
   */
  anchor: Date;
}) {
  /**
   * The two halves are held apart and joined only for rendering.
   *
   * Keeping one merged array instead would mean every future page having to
   * find where "today" is in order to insert above it, and getting that wrong
   * silently mis-orders the column. Two lists, each only ever appended to, and
   * the future one reversed at the join: the API returns future ascending
   * (nearest first) and the column runs descending, so the reversal is the one
   * place that fact lives.
   */
  const [past, setPast] = useState<VerseView[]>([]);
  const [future, setFuture] = useState<VerseView[]>([]);
  const [pastCursor, setPastCursor] = useState<string | null>(null);
  const [futureCursor, setFutureCursor] = useState<string | null>(null);
  const [pastDone, setPastDone] = useState(false);
  const [futureDone, setFutureDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * The first page of each direction, together.
   *
   * The fetch is started in the effect but every state update happens in the
   * callback, not synchronously in the effect body — a synchronous setState
   * there cascades an extra render before the browser has painted anything.
   * `loading` already starts true, so there is nothing to set on the way in.
   *
   * `cancelled` guards the late arrival: adding two verses quickly starts two
   * first-page fetches, and the slower one must not overwrite the newer answer.
   */
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchTimeline({ anchor, direction: 'past', cursor: null, limit: PAGE }),
      fetchTimeline({ anchor, direction: 'future', cursor: null, limit: PAGE }),
    ])
      .then(([back, forward]) => {
        if (cancelled) return;
        setPast(back.verses);
        setPastCursor(back.nextCursor);
        setPastDone(back.nextCursor === null);
        setFuture(forward.verses);
        setFutureCursor(forward.nextCursor);
        setFutureDone(forward.nextCursor === null);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof NotSignedIn) {
          clearTokens();
          return;
        }
        setError(cause instanceof Error ? cause.message : 'Could not load the timeline.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [anchor]);

  /**
   * How much scroll height the next render has to make up for.
   *
   * Set immediately before a future page is added and consumed by the layout
   * effect below. A ref rather than state on purpose: it must be readable in
   * the same commit that renders the new rows, and a state update would
   * schedule another render after the jump had already been painted.
   */
  const anchorHeight = useRef<number | null>(null);

  /**
   * Put the scroll position back where it was before rows appeared above it.
   *
   * `useLayoutEffect`, not `useEffect`: this has to run after the DOM has the
   * new rows but before the browser paints, which is exactly the gap a layout
   * effect fills. In a plain effect the reader sees the content jump and then
   * jump back.
   */
  useLayoutEffect(() => {
    const before = anchorHeight.current;
    if (before === null) return;

    anchorHeight.current = null;
    window.scrollBy(0, document.documentElement.scrollHeight - before);
  });

  const loadPast = useCallback(async () => {
    if (pastCursor === null) return;

    setLoading(true);
    try {
      const page = await fetchTimeline({
        anchor,
        direction: 'past',
        cursor: pastCursor,
        limit: PAGE,
      });
      // Appended below the fold — nothing moves, so no anchoring needed.
      setPast((current) => [...current, ...page.verses]);
      setPastCursor(page.nextCursor);
      setPastDone(page.nextCursor === null);
    } catch (cause) {
      if (cause instanceof NotSignedIn) clearTokens();
      else setError(cause instanceof Error ? cause.message : 'Could not load more.');
    } finally {
      setLoading(false);
    }
  }, [anchor, pastCursor]);

  const loadFuture = useCallback(async () => {
    if (futureCursor === null) return;

    setLoading(true);
    try {
      const page = await fetchTimeline({
        anchor,
        direction: 'future',
        cursor: futureCursor,
        limit: PAGE,
      });

      // Measured here rather than in the layout effect: by the time that runs
      // the rows are already in the document and the old height is gone.
      if (page.verses.length > 0) {
        anchorHeight.current = document.documentElement.scrollHeight;
      }

      setFuture((current) => [...current, ...page.verses]);
      setFutureCursor(page.nextCursor);
      setFutureDone(page.nextCursor === null);
    } catch (cause) {
      if (cause instanceof NotSignedIn) clearTokens();
      else setError(cause instanceof Error ? cause.message : 'Could not load more.');
    } finally {
      setLoading(false);
    }
  }, [anchor, futureCursor]);

  /**
   * The column, top to bottom: farthest future first, then today, then back
   * into the past.
   */
  const verses = useMemo(() => [...future].reverse().concat(past), [future, past]);

  const sections = useMemo(() => groupIntoSections(verses, anchor), [verses, anchor]);

  /**
   * Where the future stops and the past begins, as a section index.
   *
   * Found by membership rather than by comparing dates: a section can hold
   * both halves at once — anything written for later today is "future" and
   * anything from this morning is "past", and they group under the same
   * heading. Marking the first section that contains *any* past verse puts
   * the centre above that shared heading, which is where a reader opening the
   * app expects today to start.
   */
  const boundary = useMemo(() => {
    const pastIds = new Set(past.map((verse) => verse.id));
    return sections.findIndex((section) =>
      section.verses.some((verse) => pastIds.has(verse.id)),
    );
  }, [sections, past]);

  // Report the section currently under the header.
  const headingsRef = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const visible = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = entry.target.getAttribute('data-section');
          if (!key) continue;
          if (entry.isIntersecting) visible.add(key);
          else visible.delete(key);
        }

        // The topmost section still in the band under the header wins. Taking
        // the first *entry* instead would depend on callback order, which is
        // not the document order and drifts as you scroll fast.
        const ordered = sections.map((s) => s.key).filter((key) => visible.has(key));
        const current = ordered[0];
        if (current) {
          const section = sections.find((s) => s.key === current);
          if (section) onDateChange(section.label);
        }
      },
      {
        // A band just under the sticky header: a section counts as "current"
        // from the moment it reaches the header until it leaves the top of the
        // viewport. Without the negative bottom margin every section on screen
        // is intersecting at once and the header shows the last one.
        rootMargin: '-72px 0px -85% 0px',
        threshold: 0,
      },
    );

    for (const element of headingsRef.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [sections, onDateChange]);

  /**
   * One sentinel at each end, watched by the same effect.
   *
   * `loading` gates both because the two share it: firing the future loader
   * while a past page is in flight would interleave two writes to the scroll
   * position, and the anchor measurement of the second would include the rows
   * the first had already added.
   */
  const pastSentinel = useRef<HTMLDivElement | null>(null);
  const futureSentinel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (loading) return;

    const watch = (element: HTMLElement | null, load: () => void) => {
      if (!element) return undefined;

      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) load();
        },
        // Start fetching before the sentinel is visible, so the next page is
        // usually there by the time the reader arrives.
        { rootMargin: '400px' },
      );
      observer.observe(element);
      return observer;
    };

    const observers = [
      pastDone ? undefined : watch(pastSentinel.current, () => void loadPast()),
      futureDone ? undefined : watch(futureSentinel.current, () => void loadFuture()),
    ];

    return () => {
      for (const observer of observers) observer?.disconnect();
    };
  }, [pastCursor, futureCursor, pastDone, futureDone, loading, loadPast, loadFuture]);

  /**
   * Open on today, not on the far edge of the future.
   *
   * With rows above it, the natural scroll position (the top of the document)
   * is the furthest-away thing the reader has — the opposite of a timeline
   * "centred on today". This scrolls to the boundary between the two halves
   * once, on the first render that has content.
   *
   * Keyed on `anchor` so replacing it after a write re-centres, and guarded by
   * a ref so an incoming future page does not yank the reader back to today
   * while they are reading forward.
   */
  const todayRef = useRef<HTMLDivElement | null>(null);
  const centred = useRef<Date | null>(null);
  useLayoutEffect(() => {
    if (loading || centred.current === anchor) return;
    const today = todayRef.current;
    if (!today) return;

    centred.current = anchor;

    /*
     * Offset by the sticky header, rather than `scrollIntoView({block:
     * 'start'})`.
     *
     * That aligns to the top of the *viewport*, which the fixed date header
     * covers — the first section's heading lands underneath the glass and
     * reads as half a word. The header is measured rather than assumed: its
     * height comes from tokens and a hardcoded 72 here would drift the moment
     * one of them changed.
     *
     * `auto`, never `smooth`: this is where the page should already have
     * been, not a movement the reader should watch happen.
     */
    const header = document.querySelector('.date-header');
    const clearance = header ? header.getBoundingClientRect().height : 0;

    window.scrollTo({
      top: today.getBoundingClientRect().top + window.scrollY - clearance,
      behavior: 'auto',
    });
  }, [loading, anchor]);

  if (error) {
    return (
      <p className="notice" role="alert">
        {error}
      </p>
    );
  }

  if (!loading && verses.length === 0) {
    return (
      <p className="notice">
        Nothing on the timeline yet. Add the first verse with the button below.
      </p>
    );
  }

  return (
    <div className="timeline">
      {futureDone && future.length > 0 ? (
        <p className="notice end">That is as far ahead as you have written.</p>
      ) : null}

      <div ref={futureSentinel} aria-hidden="true" />

      {sections.map((section, index) => (
        <Fragment key={section.key}>
          {/*
            The centre mark, between the last future section and the first
            past one. It is what the opening scroll lands on, and the only
            reason it is an element at all — there is nothing to show, because
            "today" is already the label of the section right below it.
          */}
          {index === boundary ? <div ref={todayRef} aria-hidden="true" /> : null}

          <section aria-labelledby={`h-${section.key}`}>
            <h2
              id={`h-${section.key}`}
              className="section-date"
              data-section={section.key}
              ref={(element) => {
                if (element) headingsRef.current.set(section.key, element);
                else headingsRef.current.delete(section.key);
              }}
            >
              {section.label}
            </h2>

            <ul className="verses">
              {section.verses.map((verse) => (
                <VerseRow key={verse.id} verse={verse} onOpen={onOpen} />
              ))}
            </ul>
          </section>
        </Fragment>
      ))}

      {/* No past at all: the mark still has to exist, or the opening scroll
          has nothing to find and the reader starts at the far future. */}
      {boundary === -1 ? <div ref={todayRef} aria-hidden="true" /> : null}

      <div ref={pastSentinel} aria-hidden="true" />

      {loading ? <p className="notice">Loading…</p> : null}
      {pastDone && past.length > 0 ? (
        <p className="notice end">That is the beginning.</p>
      ) : null}
    </div>
  );
}

function VerseRow({
  verse,
  onOpen,
}: {
  verse: VerseView;
  onOpen: (verseId: string) => void;
}) {
  const placement = placementOf(verse);
  const time = timeLabel(placement);

  return (
    <li className="verse">
      {time ? <span className="verse-time">{time}</span> : null}

      {/*
        An empty button stretched over the whole row, rather than wrapping the
        row's content in one.

        A <button> may only contain phrasing content, and this row holds <p>,
        <dl> and <ul> — wrapping them would be invalid HTML and lands
        assistive tech in a control whose accessible name is the entire row
        read as one string. Stretched over the top, the row keeps its
        structure and the button carries a name that says what it does.
      */}
      <button
        type="button"
        className="verse-open"
        onClick={() => onOpen(verse.id)}
        aria-label={`Open ${verse.xp ? verse.xp.slice(0, 60) : 'this verse'}`}
      />

      <div className="verse-body">
        <VerseMedia verse={verse} />

        {verse.xp ? <p className="verse-xp">{verse.xp}</p> : null}

        {verse.location ? <p className="verse-meta">{verse.location}</p> : null}

        {Object.keys(verse.properties).length > 0 ? (
          <dl className="verse-properties">
            {Object.entries(verse.properties).map(([key, value]) => (
              <div key={key}>
                <dt>{key.replace(/-/g, ' ')}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <p className="verse-tags">
          {verse.tags.map((tag) => (
            <span key={tag.id} className="tag">
              {tag.label}
            </span>
          ))}
          {verse.rating !== null ? (
            <span className="rating">{verse.rating}/10</span>
          ) : null}
          {/* Only when it is not the default: a private badge on every row is
              noise, and noise is what stops a badge being read. */}
          {verse.visibility !== 'private' ? (
            <span className="visibility">{verse.visibility}</span>
          ) : null}
        </p>
      </div>
    </li>
  );
}

/**
 * A verse's photos.
 *
 * Shows the `thumb` variant (256px), which is what the timeline needs — the
 * `medium` and the original exist for a detail view that does not exist yet,
 * and fetching either here would download several times the bytes for the
 * same row.
 *
 * A media item still `processing` has no variant yet: it gets a placeholder
 * rather than being hidden, because the alternative is a row that silently
 * gains a photo a few seconds after it was written. `failed` items are left
 * out entirely — there is nothing to show and nothing the reader can do.
 */
function VerseMedia({ verse }: { verse: VerseView }) {
  const shown = verse.media.filter((media) => media.status !== 'failed');
  if (shown.length === 0) return null;

  return (
    <ul className="verse-media">
      {shown.map((media) =>
        media.thumbUrl ? (
          <li key={media.id}>
            {/* eslint-disable-next-line @next/next/no-img-element --
                next/image would route a short-lived signed URL through the
                optimiser, which caches it past the point it stays valid. */}
            <img src={media.thumbUrl} alt="" loading="lazy" />
          </li>
        ) : (
          <li key={media.id} className="pending" aria-label="Photo still processing" />
        ),
      )}
    </ul>
  );
}

function groupIntoSections(verses: readonly VerseView[], now: Date): Section[] {
  const sections: Section[] = [];

  for (const verse of verses) {
    const placement = placementOf(verse);
    const key = sectionKey(placement);
    const last = sections.at(-1);

    // The API already returns them in order, so a run of the same key is one
    // section. Grouping into a map instead would lose that order.
    if (last?.key === key) last.verses.push(verse);
    else sections.push({ key, label: headerLabel(placement, now), verses: [verse] });
  }

  return sections;
}

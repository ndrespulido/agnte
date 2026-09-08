'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTimeline, type VerseView } from './api';
import { clearTokens, NotSignedIn } from './session';
import { headerLabel, placementOf, sectionKey, timeLabel } from './format';

/**
 * The timeline: today at the top, scrolling into the past.
 *
 * The future half exists in the API and is deliberately not shown yet — a
 * single column that runs both ways from a centre needs a scroll anchor to stay
 * put while rows are prepended, and getting that wrong makes the page jump
 * under a thumb. Past-only is the honest half of the feature; the other half
 * lands with the quick-add, when there is a reason to look forward.
 */

interface Section {
  key: string;
  label: string;
  verses: VerseView[];
}

export function Timeline({
  onDateChange,
  anchor,
}: {
  /** Reports the date of whatever is under the sticky header. */
  onDateChange: (label: string) => void;
  /**
   * The point the timeline runs back from. Owned by the shell rather than
   * computed here: a `new Date()` recomputed on render would move mid-scroll
   * and quietly change which page comes back next, and the shell needs to
   * replace it after a write anyway.
   */
  anchor: Date;
}) {
  const [verses, setVerses] = useState<VerseView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The first page.
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

    fetchTimeline({ anchor, direction: 'past', cursor: null })
      .then((page) => {
        if (cancelled) return;
        setVerses(page.verses);
        setCursor(page.nextCursor);
        setExhausted(page.nextCursor === null);
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
   * The next page. Called from the sentinel's observer rather than from an
   * effect body, so it may set state as it goes.
   */
  const loadMore = useCallback(async () => {
    if (cursor === null) return;

    setLoading(true);
    try {
      const page = await fetchTimeline({ anchor, direction: 'past', cursor });
      setVerses((current) => [...current, ...page.verses]);
      setCursor(page.nextCursor);
      setExhausted(page.nextCursor === null);
    } catch (cause) {
      if (cause instanceof NotSignedIn) clearTokens();
      else setError(cause instanceof Error ? cause.message : 'Could not load more.');
    } finally {
      setLoading(false);
    }
  }, [anchor, cursor]);

  const sections = useMemo(() => groupIntoSections(verses, anchor), [verses, anchor]);

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

  // Load the next page when the sentinel approaches.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || exhausted || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      // Start fetching before the sentinel is visible, so the next page is
      // usually there by the time the reader arrives.
      { rootMargin: '400px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [cursor, exhausted, loading, loadMore]);

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
      {sections.map((section) => (
        <section key={section.key} aria-labelledby={`h-${section.key}`}>
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
              <VerseRow key={verse.id} verse={verse} />
            ))}
          </ul>
        </section>
      ))}

      <div ref={sentinelRef} aria-hidden="true" />

      {loading ? <p className="notice">Loading…</p> : null}
      {exhausted && verses.length > 0 ? (
        <p className="notice end">That is the beginning.</p>
      ) : null}
    </div>
  );
}

function VerseRow({ verse }: { verse: VerseView }) {
  const placement = placementOf(verse);
  const time = timeLabel(placement);

  return (
    <li className="verse">
      {time ? <span className="verse-time">{time}</span> : null}

      <div className="verse-body">
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

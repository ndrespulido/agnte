'use client';

import { useEffect, useState } from 'react';
import { fetchTags, type TagView } from './api';

/**
 * Every tag, as a way in to its dashboard.
 *
 * Until now tags existed only inside the verse sheet — something you typed to
 * file a verse under, never something you could look at. That made a tag feel
 * like a label, when the domain treats it as "tables this row is stored in"
 * (CLAUDE.md). This is the list that makes them addressable.
 *
 * Sorted by name rather than by use. Ranking by verse count would need a count
 * per tag, which is a dashboard each — and a list that reorders itself as you
 * add verses is a list you cannot build muscle memory for.
 */
export function Tags({
  onOpen,
  onClose,
  covered,
}: {
  onOpen: (tagId: string) => void;
  onClose: () => void;
  /**
   * True while a dashboard is stacked on top of this list.
   *
   * Without it both overlays listen for Escape and both answer, so one press
   * dismissed the list *underneath* and left the dashboard sitting on nothing —
   * the exact failure VerseDetail's `!editing` guard already documents. Escape
   * belongs to whatever is on top.
   */
  covered: boolean;
}) {
  const [tags, setTags] = useState<TagView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchTags()
      .then((fetched) => {
        if (!cancelled) {
          setTags([...fetched].sort((a, b) => a.name.localeCompare(b.name)));
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not load tags.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (covered) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, covered]);

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet tag-list"
        role="dialog"
        aria-modal="true"
        aria-label="Tags"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="dashboard-title">Tags</h2>

        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        {tags === null ? (
          error ? null : (
            <p className="notice">Loading…</p>
          )
        ) : tags.length === 0 ? (
          <p className="notice">
            No tags yet. Every verse needs at least one, so the first one you add will
            show up here.
          </p>
        ) : (
          <ul className="tag-rows">
            {tags.map((tag) => (
              <li key={tag.id}>
                <button type="button" className="tag-row" onClick={() => onOpen(tag.id)}>
                  <span className="tag">{tag.label}</span>
                  {tag.shortcut ? (
                    <span className="quiet-note">{tag.shortcut}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="sheet-actions">
          <button type="button" className="quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

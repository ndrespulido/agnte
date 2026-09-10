'use client';

import { useCallback, useEffect, useState } from 'react';
import { deleteVerse, fetchVerse, VersionConflict, type VerseView } from './api';
import { VerseSheet } from './VerseSheet';
import { deepTimeLabel, headerLabel, placementOf, timeLabel } from './format';

/**
 * One verse, in full.
 *
 * This is the screen the media pipeline was already built for: it shows the
 * `medium` variant (1024px), which until now nothing rendered — the timeline
 * deliberately shows only `thumb`, and the original exists to re-derive from.
 *
 * It re-fetches on open rather than taking the row the timeline already has.
 * The timeline's copy can be minutes old, its signed media URLs expire, and
 * editing needs a `version` that is actually current — opening an editor on a
 * stale version means a 409 on the first save every time.
 */
export function VerseDetail({
  verseId,
  onClose,
  onChanged,
}: {
  verseId: string;
  onClose: () => void;
  /** A write happened: the timeline behind this needs to refetch. */
  onChanged: () => void;
}) {
  const [verse, setVerse] = useState<VerseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const load = useCallback(() => {
    let cancelled = false;

    fetchVerse(verseId)
      .then((fetched) => {
        if (!cancelled) setVerse(fetched);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Could not open that verse.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [verseId]);

  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Only when the sheet is not up — otherwise one Escape closes both, and
      // an accidental key press throws away an edit in progress.
      if (event.key === 'Escape' && !editing) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  async function remove() {
    if (!verse) return;

    try {
      await deleteVerse(verse.id, verse.version);
      onChanged();
      onClose();
    } catch (cause) {
      setConfirmingDelete(false);
      setError(
        cause instanceof VersionConflict || cause instanceof Error
          ? cause.message
          : 'Could not delete it.',
      );
    }
  }

  if (editing && verse) {
    return (
      <VerseSheet
        initial={verse}
        onClose={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          // Re-read rather than trusting the sheet's own result: the resolved
          // visibility and the media URLs are both server-computed, and the
          // version has moved on.
          load();
          onChanged();
        }}
      />
    );
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet verse-detail"
        role="dialog"
        aria-modal="true"
        aria-label="Verse"
        onClick={(event) => event.stopPropagation()}
      >
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}

        {verse === null ? (
          error ? null : (
            <p className="notice">Loading…</p>
          )
        ) : (
          <>
            <p className="detail-date">{whenOf(verse)}</p>

            {verse.media.length > 0 ? (
              <ul className="detail-media">
                {verse.media.map((media) =>
                  media.mediumUrl ? (
                    <li key={media.id}>
                      {/* eslint-disable-next-line @next/next/no-img-element --
                          a short-lived signed URL; next/image would cache it
                          through the optimiser past the point it stays valid. */}
                      <img src={media.mediumUrl} alt="" />
                    </li>
                  ) : (
                    <li key={media.id} className="pending">
                      {media.status === 'failed'
                        ? 'This photo could not be processed.'
                        : 'Still processing…'}
                    </li>
                  ),
                )}
              </ul>
            ) : null}

            {verse.xp ? <p className="detail-xp">{verse.xp}</p> : null}

            <dl className="detail-facts">
              {verse.location ? (
                <div>
                  <dt>Where</dt>
                  <dd>{verse.location}</dd>
                </div>
              ) : null}
              {verse.rating !== null ? (
                <div>
                  <dt>Rating</dt>
                  <dd>{verse.rating}/10</dd>
                </div>
              ) : null}
              <div>
                <dt>Visibility</dt>
                <dd>
                  {verse.visibility}
                  {/* Worth saying which of the two identical-looking cases
                      this is — an inherited value moves when a tag changes. */}
                  {verse.explicitVisibility === null ? ' (from its tags)' : ''}
                </dd>
              </div>
              {Object.entries(verse.properties).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replace(/-/g, ' ')}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>

            <p className="verse-tags">
              {verse.tags.map((tag) => (
                <span key={tag.id} className="tag">
                  {tag.label}
                </span>
              ))}
            </p>

            <div className="sheet-actions">
              <button type="button" className="quiet" onClick={onClose}>
                Close
              </button>
              {confirmingDelete ? (
                <>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Keep
                  </button>
                  <button type="button" className="danger" onClick={() => void remove()}>
                    Delete for good
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The one line at the top: when this happened.
 *
 * `headerLabel` needs a "now" to say "Today" against, and this is a detail
 * view opened at a moment rather than a list rendered against one anchor, so
 * the clock is read here — the one place in this file that does.
 */
function whenOf(verse: VerseView): string {
  const placement = placementOf(verse);
  if (placement.kind === 'deep-time') return deepTimeLabel(placement.years);
  if (placement.kind === 'undated') return 'No date';

  const day = headerLabel(placement, new Date());
  const time = timeLabel(placement);
  return time ? `${day}, ${time}` : day;
}

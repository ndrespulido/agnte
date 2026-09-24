'use client';

import { useCallback, useEffect, useState } from 'react';
import { deleteVerse, fetchVerse, type VerseView } from './api';
import { VerseSheet } from './VerseSheet';
import { deepTimeLabel, headerLabel, placementOf, timeLabel } from './format';
import { failureMessage, useStrings } from './locale';
import type { Strings } from '@/shared/i18n';

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
  const s = useStrings();
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
          setError(cause instanceof Error ? cause.message : '');
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
      setError(cause instanceof Error ? cause.message : '');
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
        aria-label={s.verse.label}
        onClick={(event) => event.stopPropagation()}
      >
        {error !== null ? (
          <p className="notice error" role="alert">
            {failureMessage(error, s.verse.couldNotOpen)}
          </p>
        ) : null}

        {verse === null ? (
          error ? null : (
            <p className="notice">{s.common.loading}</p>
          )
        ) : (
          <>
            <p className="detail-date">{whenOf(verse, s)}</p>

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
                        ? s.verse.photoUnprocessable
                        : s.verse.stillProcessing}
                    </li>
                  ),
                )}
              </ul>
            ) : null}

            {verse.xp ? <p className="detail-xp">{verse.xp}</p> : null}

            <dl className="detail-facts">
              {verse.location ? (
                <div>
                  <dt>{s.verse.where}</dt>
                  <dd>{verse.location}</dd>
                </div>
              ) : null}
              {verse.rating !== null ? (
                <div>
                  <dt>{s.verse.rating}</dt>
                  <dd>{verse.rating}/10</dd>
                </div>
              ) : null}
              <div>
                <dt>{s.verse.visibility}</dt>
                <dd>
                  {visibilityLabel(verse.visibility, s)}
                  {/* Worth saying which of the two identical-looking cases
                      this is — an inherited value moves when a tag changes. */}
                  {verse.explicitVisibility === null ? s.verse.fromItsTags : ''}
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
                {s.common.close}
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
                    {s.verse.deleteForGood}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => setConfirmingDelete(true)}
                  >
                    {s.common.delete}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => setEditing(true)}
                  >
                    {s.verse.edit}
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
function whenOf(verse: VerseView, s: Strings): string {
  const placement = placementOf(verse);
  if (placement.kind === 'deep-time') return deepTimeLabel(placement.years, s);
  if (placement.kind === 'undated') return s.common.noDate;

  const day = headerLabel(placement, new Date(), s);
  const time = timeLabel(placement);
  return time ? `${day}, ${time}` : day;
}

/**
 * The resolved visibility, in words.
 *
 * A lookup rather than the raw value, which is an API token (`private`) that
 * happened to read as English. It stops reading as anything at all in a
 * Chinese interface, and a value the server chose is not a value to print.
 */
function visibilityLabel(visibility: string, s: Strings): string {
  if (visibility === 'shared') return s.verse.visibilityShared;
  if (visibility === 'public') return s.verse.visibilityPublic;
  return s.verse.visibilityPrivate;
}

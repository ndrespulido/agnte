'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useStrings } from './locale';

/**
 * A photo, full screen, with the others a swipe away.
 *
 * The carousel is the browser's own: a horizontal scroller with scroll-snap,
 * one photo per screen. Swiping, momentum and rubber-banding are then the
 * platform's, which is the only version of them that feels right on a phone,
 * and there is no gesture code here to get subtly wrong. The arrows and the
 * keys just scroll that same strip.
 */
export function Lightbox({
  photos,
  startAt,
  onClose,
}: {
  photos: readonly string[];
  startAt: number;
  onClose: () => void;
}) {
  const s = useStrings();
  const strip = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(startAt);

  const go = (to: number, behavior: ScrollBehavior = 'smooth') => {
    const element = strip.current;
    if (!element) return;
    const clamped = Math.max(0, Math.min(photos.length - 1, to));
    element.scrollTo({ left: clamped * element.clientWidth, behavior });
  };

  // Open on the photo that was tapped, without a visible slide to it.
  useEffect(() => {
    go(startAt, 'instant');
    // Only on mount: `go` is recreated every render and `startAt` is where
    // the viewer opened, not something to follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // This viewer sits over a sheet that also closes on Escape; one key
        // press should close one thing.
        event.stopImmediatePropagation();
        onClose();
      }
      if (event.key === 'ArrowLeft') go(index - 1);
      if (event.key === 'ArrowRight') go(index + 1);
    };
    // Capture, so it runs before the listeners of whatever is underneath.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={s.verse.photos}>
      <div
        className="lightbox-strip"
        ref={strip}
        onScroll={(event) => {
          const element = event.currentTarget;
          setIndex(Math.round(element.scrollLeft / Math.max(1, element.clientWidth)));
        }}
      >
        {photos.map((url, position) => (
          // A tap on the dark around a photo closes; a tap on the photo does
          // not, so a slow swipe never dismisses by accident.
          <div className="lightbox-slide" key={url} onClick={onClose}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a
                short-lived signed URL; next/image would cache it through the
                optimiser past the point it stays valid. */}
            <img
              src={url}
              alt=""
              // Only the photo on screen and its neighbours are fetched.
              loading={Math.abs(position - startAt) <= 1 ? 'eager' : 'lazy'}
              onClick={(event) => event.stopPropagation()}
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        className="lightbox-close"
        aria-label={s.photos.close}
        onClick={onClose}
      >
        <Icon name="close" />
      </button>

      {photos.length > 1 ? (
        <>
          <p className="lightbox-count" aria-live="polite">
            {s.photos.position(index + 1, photos.length)}
          </p>
          <button
            type="button"
            className="lightbox-arrow previous"
            aria-label={s.photos.previous}
            disabled={index === 0}
            onClick={() => go(index - 1)}
          >
            <Icon name="chevronLeft" />
          </button>
          <button
            type="button"
            className="lightbox-arrow next"
            aria-label={s.photos.next}
            disabled={index === photos.length - 1}
            onClick={() => go(index + 1)}
          >
            <Icon name="chevronRight" />
          </button>
        </>
      ) : null}
    </div>
  );
}

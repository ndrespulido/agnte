'use client';

import type { VerseView } from './api';
import { useStrings } from './locale';

type Media = VerseView['media'][number];

/** A response cached before media had kinds has none; those were all images. */
export const isImage = (media: Media): boolean =>
  media.kind === undefined || media.kind === 'image';

/**
 * A verse's attachments that are not pictures: voice notes, videos, files.
 *
 * Drawn with the browser's own players and a plain link. Nothing is fetched
 * until it is played (`preload="none"` / `"metadata"`): the URLs are signed
 * and short-lived, and a timeline of voice notes must not start downloading
 * all of them on scroll.
 */
export function OtherMedia({ media }: { media: readonly Media[] }) {
  const s = useStrings();
  const shown = media.filter(
    (item) => !isImage(item) && item.status !== 'failed' && item.originalUrl !== null,
  );
  if (shown.length === 0) return null;

  return (
    <ul className="verse-attachments">
      {shown.map((item) => {
        const url = item.originalUrl as string;
        if (item.kind === 'audio') {
          return (
            <li key={item.id}>
              <audio
                controls
                preload="none"
                src={url}
                aria-label={s.composerBar.voiceNote}
              />
            </li>
          );
        }
        if (item.kind === 'video') {
          return (
            <li key={item.id}>
              <video controls preload="metadata" playsInline src={url} />
            </li>
          );
        }
        return (
          <li key={item.id}>
            {/* `noopener`: the link leaves for object storage, which has no
                business holding a handle on this window. */}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="attachment-file"
            >
              {item.fileName ?? s.composerBar.file}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

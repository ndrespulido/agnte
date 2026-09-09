import type { VisibleVerse } from '../domain/ports';
import { format } from '../domain/tag';

/**
 * The response shape.
 *
 * `visibility` is the *resolved* answer, not the stored column: a client
 * showing a badge needs to know what the verse actually is, and the stored null
 * meaning "inherit" would show as nothing. `explicitVisibility` carries the
 * stored value separately, so an editor can tell "inherited private" from
 * "deliberately private" — they look identical otherwise and mean different
 * things when a tag changes.
 */
export const verseBody = (v: VisibleVerse) => ({
  id: v.verse.id,
  eventStart: v.verse.eventStart?.toISOString() ?? null,
  eventEnd: v.verse.eventEnd?.toISOString() ?? null,
  deepTimeYears: v.verse.deepTimeYears,
  location: v.verse.location,
  rating: v.verse.rating,
  xp: v.verse.xp,
  properties: v.verse.properties,
  visibility: v.effectiveVisibility,
  explicitVisibility: v.verse.visibility,
  tags: v.tags.map((t) => ({ id: t.id, name: t.name, label: format(t) })),
  // `mediaIds` is kept alongside the resolved `media` below rather than
  // replaced by it: a client editing a verse needs the raw ids (to send back
  // on update) independently of whatever signed URLs happened to resolve on
  // this particular read.
  mediaIds: v.verse.mediaIds,
  media: v.media.map((m) => ({
    id: m.id,
    status: m.status,
    originalUrl: m.originalUrl,
    thumbUrl: m.thumbUrl,
    mediumUrl: m.mediumUrl,
  })),
  createdAt: v.verse.createdAt.toISOString(),
  updatedAt: v.verse.updatedAt.toISOString(),
  version: v.verse.version,
});

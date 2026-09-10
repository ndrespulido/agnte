/**
 * The media module's public surface.
 *
 * No read route: a Media item is read through verse, not directly. Verse
 * resolves visibility (media has no visibility concept of its own — see
 * CLAUDE.md's Visibility section) and, once a Verse is confirmed readable,
 * calls `resolveMediaForVerse` using the *verse owner's* id, not the
 * viewer's — media trusts that decision rather than repeating it.
 * `ownedMediaIds` is the write-time half of the same integration: verse
 * calls it before accepting a mediaId onto a Verse at all. See `application/
 * delete-media.ts`'s doc comment for the same boundary from the other
 * direction: media cannot see which Verses reference an id it deletes.
 */

export { handleDevMediaDownload, handleDevMediaUpload } from './api/dev-storage-routes';
export { handleThumbnailJob } from './api/internal-routes';
export {
  handleConfirmUpload,
  handleDeleteMedia,
  handleRequestUpload,
} from './api/media-routes';
export { ownedMediaIds, resolveMediaForVerse } from './application/verse-integration';
export { prunePendingMedia } from './application/prune-media';
export { requeueStalledThumbnails } from './application/requeue-stalled-thumbnails';
export type { MediaSummaryForVerse } from './application/verse-integration';

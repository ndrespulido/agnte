/**
 * The media module's public surface.
 *
 * No read route: a Media item is read through verse, not directly. Verse
 * resolves visibility (media has no visibility concept of its own — see
 * CLAUDE.md's Visibility section) and, once a Verse is confirmed readable,
 * asks media for signed URLs using the *verse owner's* id, not the viewer's —
 * media trusts that decision rather than repeating it. That integration is
 * still open work, tracked as a known gap rather than built here (see
 * `application/delete-media.ts`'s doc comment for the same boundary from the
 * other direction: media cannot see which Verses reference an id it deletes).
 */

export { handleDevMediaDownload, handleDevMediaUpload } from './api/dev-storage-routes';
export { handleThumbnailJob } from './api/internal-routes';
export {
  handleConfirmUpload,
  handleDeleteMedia,
  handleRequestUpload,
} from './api/media-routes';

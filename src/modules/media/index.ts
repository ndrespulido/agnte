/**
 * The media module's public surface.
 *
 * Phase 4.3: only the dev-storage-route handlers exist to export — the
 * `/v1/media` API and its application layer land in 4.5/4.6. Everything else
 * in this module (the domain, the repository, the blob store adapters) stays
 * unexported so the app layer and other modules can only reach media through
 * whatever is listed here, per architecture.md §1.1.
 */

export { handleDevMediaDownload, handleDevMediaUpload } from './api/dev-storage-routes';

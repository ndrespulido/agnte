import type { Media } from '../domain/media';

/**
 * The response shape for `/v1/media`.
 *
 * No `storageKey` — domain/media.ts is explicit that it is never returned in
 * an API response, since a client has no business seeing an internal bucket
 * path. No signed download URL either: at request-upload and confirm time
 * the client already holds the bytes it just sent, and resolving a readable
 * URL for a Verse's attached media — where visibility has to be decided
 * first — is verse's side of an integration this module does not build yet.
 */
export const mediaBody = (media: Media) => ({
  id: media.id,
  status: media.status,
  contentType: media.contentType,
  declaredSizeBytes: media.declaredSizeBytes,
  createdAt: media.createdAt.toISOString(),
  updatedAt: media.updatedAt.toISOString(),
  version: media.version,
});

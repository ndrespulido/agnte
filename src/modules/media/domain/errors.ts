import { DomainError } from '@/shared/kernel';

/**
 * Media's error codes.
 *
 * Namespaced `media.*` for the same reason identity's and verse's are: a
 * client switching on `code` can tell which module refused. Codes are the
 * contract; the prose is free to change (architecture.md §6).
 */
export const MediaErrorCode = {
  ContentTypeNotAllowed: 'media.content_type_not_allowed',
  TooLarge: 'media.too_large',
  NotFound: 'media.not_found',
  NotPending: 'media.not_pending',
  NotReady: 'media.not_ready',
  UploadMismatch: 'media.upload_mismatch',
  StorageUnavailable: 'media.storage_unavailable',
  VersionConflict: 'media.version_conflict',
} as const;

export type MediaErrorCode = (typeof MediaErrorCode)[keyof typeof MediaErrorCode];

export const contentTypeNotAllowed = (
  contentType: string,
  allowed: readonly string[],
): DomainError =>
  new DomainError(
    MediaErrorCode.ContentTypeNotAllowed,
    `${contentType} is not an accepted image type. Send one of: ${allowed.join(', ')}.`,
    { details: { contentType, allowed } },
  );

export const tooLarge = (maxBytes: number): DomainError =>
  new DomainError(
    MediaErrorCode.TooLarge,
    `That file is larger than the ${Math.round(maxBytes / 1_000_000)}MB limit. ` +
      'Downscale it in the browser before uploading (this should already ' +
      'happen automatically — seeing this means it did not).',
    { details: { maxBytes } },
  );

/**
 * Deliberately worded as "does not exist" — the same enumeration-avoidance
 * rule verse and identity already follow. Whether it is missing, belongs to
 * someone else, or was deleted, the caller learns nothing that distinguishes
 * those cases.
 */
export const notFound = (): DomainError =>
  new DomainError(MediaErrorCode.NotFound, 'That media item does not exist.');

export const notPending = (): DomainError =>
  new DomainError(
    MediaErrorCode.NotPending,
    'This upload was already confirmed or has expired. Request a new upload URL.',
  );

export const notReady = (): DomainError =>
  new DomainError(
    MediaErrorCode.NotReady,
    'This media item has not finished processing yet.',
  );

/**
 * The confirm step found a different file at the key than what was declared —
 * wrong size, wrong content type, or nothing there at all. Named separately
 * from `tooLarge` because the declared size passed validation; what actually
 * landed in R2 did not match it.
 */
export const uploadMismatch = (reason: string): DomainError =>
  new DomainError(
    MediaErrorCode.UploadMismatch,
    `The uploaded file does not match what was declared: ${reason}.`,
    { details: { reason } },
  );

export const storageUnavailable = (): DomainError =>
  new DomainError(
    MediaErrorCode.StorageUnavailable,
    'Media storage is temporarily unavailable.',
  );

export const versionConflict = (expected: number, actual: number): DomainError =>
  new DomainError(
    MediaErrorCode.VersionConflict,
    'This media item changed since you loaded it.',
    { details: { expected, actual } },
  );

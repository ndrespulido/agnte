import { describe, expect, it } from 'vitest';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { createPendingMedia } from '@/modules/media/domain/media';
import { MediaErrorCode } from '@/modules/media/domain/errors';
import { checkUpload } from '@/modules/media/application/confirm-upload';

/**
 * `checkUpload` in isolation, with a `StoredObjectInfo` built by hand rather
 * than a real `head()` call — the exact numbers matter here (the boundary at
 * `MAX_DECLARED_BYTES`), and asserting them against a real multi-megabyte
 * upload over HTTP would be slow for no extra confidence. The end-to-end
 * version of this check, against a real object landing at a real key, lives
 * in `tests/integration/confirm-upload.test.ts`.
 */
const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

const media = () =>
  createPendingMedia({
    ownerId: uuidv7(),
    contentType: 'image/jpeg',
    declaredSizeBytes: 400_000,
    clock,
  });

describe('checkUpload', () => {
  it('accepts an object matching the declared content type and a sane size', () => {
    expect(checkUpload(media(), { sizeBytes: 100_000, contentType: 'image/jpeg' })).toBe(
      null,
    );
  });

  it('refuses when nothing is at the key', () => {
    expect(checkUpload(media(), null)?.code).toBe(MediaErrorCode.UploadMismatch);
  });

  it('refuses a zero-byte object', () => {
    expect(checkUpload(media(), { sizeBytes: 0, contentType: 'image/jpeg' })?.code).toBe(
      MediaErrorCode.UploadMismatch,
    );
  });

  it('accepts exactly at the size cap', () => {
    expect(
      checkUpload(media(), { sizeBytes: 15_000_000, contentType: 'image/jpeg' }),
    ).toBe(null);
  });

  it('refuses one byte over the size cap', () => {
    expect(
      checkUpload(media(), { sizeBytes: 15_000_001, contentType: 'image/jpeg' })?.code,
    ).toBe(MediaErrorCode.UploadMismatch);
  });

  it('refuses a content type that does not match what was declared', () => {
    expect(
      checkUpload(media(), { sizeBytes: 100_000, contentType: 'image/png' })?.code,
    ).toBe(MediaErrorCode.UploadMismatch);
  });

  it('refuses an object storage could not identify a content type for', () => {
    expect(checkUpload(media(), { sizeBytes: 100_000, contentType: null })?.code).toBe(
      MediaErrorCode.UploadMismatch,
    );
  });
});

'use client';

/**
 * Browser-side downscaling, before a byte leaves the device (architecture.md
 * §8.3: "a 4MB phone photo becomes ~400KB").
 *
 * This is where the media pipeline's whole cost model comes from. Uploading
 * originals would mean paying for the bytes twice — once into R2 and once out
 * of it on every read — and would make the server's thumbnail job decode a
 * 12-megapixel image instead of a small one. Downscaling here is also what
 * makes `MAX_DECLARED_BYTES` a backstop rather than the actual limit.
 *
 * Re-encoding through a canvas has a second effect worth stating out loud: it
 * strips EXIF, GPS included, because a canvas only ever holds pixels. The
 * server strips metadata from its variants too (`SharpThumbnailGenerator`),
 * but by then the original has already been stored — this is the point at
 * which a photo's location stops travelling with it at all.
 */

/**
 * The long edge a stored original is capped at.
 *
 * Larger than the `medium` variant (1024) on purpose: the original is what a
 * future feature re-derives from — a bigger variant, a crop — so it keeps some
 * headroom over what is displayed today. Small enough that a phone photo lands
 * well inside the size cap.
 */
export const MAX_EDGE = 1600;

/**
 * JPEG, always, whatever came in.
 *
 * `canvas.toBlob` can only produce jpeg, png or webp, and the media module
 * accepts exactly those three (`ALLOWED_CONTENT_TYPES`). Choosing one of them
 * here rather than preserving the source's type is what makes a phone's HEIC
 * a non-issue: it is decoded by the browser that can already read it, and what
 * crosses the network is a format everything downstream understands.
 */
export const OUTPUT_TYPE = 'image/jpeg';

/** Visually indistinguishable from 0.9 at this size, meaningfully smaller. */
export const QUALITY = 0.82;

export interface DownscaledImage {
  readonly blob: Blob;
  readonly contentType: typeof OUTPUT_TYPE;
  readonly width: number;
  readonly height: number;
}

/**
 * The target size for a source, preserving aspect ratio and never enlarging.
 *
 * Pure, and separated from the drawing so it can be tested without a canvas —
 * the rounding is the part that can be wrong. `Math.max(1, ...)` matters for a
 * very long, thin source: a 4000×1 image scaled to fit 1600 would otherwise
 * round its height to 0, and a zero-height canvas throws rather than producing
 * a small image.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decodes, orients, resizes and re-encodes one image file.
 *
 * `imageOrientation: 'from-image'` is passed explicitly rather than relied on
 * as the default: it *is* the spec's default now, but implementations shipped
 * with `'none'` first, and a photo taken sideways coming out sideways is the
 * kind of bug that only shows up on someone else's phone. The server's
 * thumbnail job rotates too (`sharp().rotate()`), so a variant would be right
 * even if this were wrong — but the *original* would be stored rotated, and
 * nothing later can tell that from a photo that was genuinely taken that way.
 */
export async function downscaleImage(
  file: Blob,
  maxEdge: number = MAX_EDGE,
): Promise<DownscaledImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

  try {
    const size = fitWithin(bitmap.width, bitmap.height, maxEdge);

    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not open a 2D canvas.');

    // Bilinear-ish smoothing on the way down. Without it a large photo scaled
    // in one step aliases badly on fine detail — text in a screenshot of a
    // ticket, which is a thing this app is specifically for.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, OUTPUT_TYPE, QUALITY);
    });
    if (!blob) throw new Error('This browser could not encode the image.');

    return { blob, contentType: OUTPUT_TYPE, width: size.width, height: size.height };
  } finally {
    // Frees the decoded pixels now rather than at the next GC. A few phone
    // photos at full resolution is tens of megabytes held for no reason.
    bitmap.close();
  }
}

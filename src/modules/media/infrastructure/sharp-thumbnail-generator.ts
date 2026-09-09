import sharp from 'sharp';
import { VARIANT_KINDS, VARIANT_SPECS } from '../domain/variant';
import type { GeneratedVariant, ThumbnailGenerator } from '../domain/ports';

/**
 * The one real implementation of `ThumbnailGenerator` (architecture.md §8.3):
 * both variants, resized to fit within their long edge and re-encoded as
 * JPEG.
 *
 * `.rotate()` first, with no argument: sharp reads the original's EXIF
 * orientation tag and physically rotates the pixels to match before anything
 * else touches them, so a phone photo taken sideways comes out right-side up
 * in the variant. It has to happen before `.resize()`, which otherwise sees
 * the un-rotated pixel grid.
 *
 * No `.withMetadata()` call anywhere in this pipeline — sharp strips a
 * source's EXIF (GPS included) from its output unless that method is called
 * to keep it. That is the mechanism behind CLAUDE.md's "no application-level
 * media encryption" trade-off actually holding for variants: the sensitive
 * part of a photo's metadata is gone before the bytes are ever written to
 * storage, not merely encrypted alongside it.
 */
export class SharpThumbnailGenerator implements ThumbnailGenerator {
  async generate(original: Buffer): Promise<GeneratedVariant[]> {
    const source = sharp(original).rotate();

    return Promise.all(
      VARIANT_KINDS.map(async (kind): Promise<GeneratedVariant> => {
        const spec = VARIANT_SPECS[kind];
        const { data, info } = await source
          .clone()
          .resize({
            width: spec.maxEdge,
            height: spec.maxEdge,
            fit: 'inside',
            // A source already smaller than the target is left alone rather
            // than blown up — the point of a variant is to be lighter than
            // the original, never to invent detail that was not there.
            withoutEnlargement: true,
          })
          .jpeg({ quality: spec.quality })
          .toBuffer({ resolveWithObject: true });

        return { kind, buffer: data, width: info.width, height: info.height };
      }),
    );
  }
}

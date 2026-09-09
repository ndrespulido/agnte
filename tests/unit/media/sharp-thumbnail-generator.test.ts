import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SharpThumbnailGenerator } from '@/modules/media/infrastructure/sharp-thumbnail-generator';
import { VARIANT_SPECS } from '@/modules/media/domain/variant';

/**
 * Exercises the real sharp/libvips pipeline rather than mocking it — the
 * whole point of this class is what actually comes out of that library, which
 * a mock cannot tell us. Sources are generated in-memory with sharp's own
 * `create` input rather than committed fixture files.
 */
const solidJpeg = (width: number, height: number, background = 'red'): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background } })
    .jpeg()
    .toBuffer();

describe('SharpThumbnailGenerator', () => {
  it('produces a thumb and a medium variant, both real JPEGs within their max edge', async () => {
    const original = await solidJpeg(2000, 1000);
    const variants = await new SharpThumbnailGenerator().generate(original);

    expect(variants.map((v) => v.kind)).toEqual(['thumb', 'medium']);

    for (const variant of variants) {
      const meta = await sharp(variant.buffer).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(variant.width);
      expect(meta.height).toBe(variant.height);
      expect(Math.max(variant.width, variant.height)).toBeLessThanOrEqual(
        VARIANT_SPECS[variant.kind].maxEdge,
      );
    }
  });

  it('downscales preserving aspect ratio, capping the long edge at maxEdge', async () => {
    // 4:1 landscape. thumb's 256 box scales by min(256/400, 256/100) = 0.64,
    // giving exact integers rather than something rounding could blur.
    const original = await solidJpeg(400, 100);
    const [thumb] = await new SharpThumbnailGenerator().generate(original);

    expect(thumb).toMatchObject({ width: 256, height: 64 });
  });

  it('does not enlarge a source already smaller than the target', async () => {
    const original = await solidJpeg(50, 50);
    const [thumb] = await new SharpThumbnailGenerator().generate(original);

    expect(thumb).toMatchObject({ width: 50, height: 50 });
  });

  it('auto-orients from EXIF and then strips it, rather than leaving the variant sideways', async () => {
    // Orientation 6 ("rotate 90 CW to display correctly") on a 100x50 raster
    // means the correctly-oriented image is 50x100. A pipeline that resized
    // without rotating first would hand back landscape dimensions; one that
    // rotated but kept metadata would still carry orientation:6 on top of
    // already-rotated pixels, doubling the rotation for the next reader.
    const original = await sharp({
      create: { width: 100, height: 50, channels: 3, background: 'blue' },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const [thumb] = await new SharpThumbnailGenerator().generate(original);
    if (!thumb) throw new Error('unreachable');

    expect(thumb).toMatchObject({ width: 50, height: 100 });
    const meta = await sharp(thumb.buffer).metadata();
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });
});

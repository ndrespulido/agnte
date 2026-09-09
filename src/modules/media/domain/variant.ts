/**
 * A derived size of a Media original (architecture.md §8.3).
 *
 * Exactly two kinds, both named there: `thumb` (256px) for the timeline row,
 * `medium` (1024px) for anything closer to full-screen. Generated once, by the
 * thumbnail worker, never regenerated in place — a variant that needed
 * changing would get a new Media row, not a rewritten one, so that a signed
 * URL handed to a client is never quietly pointing at different bytes.
 */
export interface MediaVariant {
  readonly mediaId: string;
  readonly kind: VariantKind;
  readonly storageKey: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly createdAt: Date;
}

export type VariantKind = 'thumb' | 'medium';

export const VARIANT_KINDS: readonly VariantKind[] = ['thumb', 'medium'];

/**
 * The long edge each variant is capped to, and the JPEG quality it is
 * re-encoded at. Both are re-derivable at any time by regenerating from the
 * original, which is the escape hatch if either number ever needs to change —
 * nothing downstream stores them, only the resulting pixels.
 */
export const VARIANT_SPECS: Record<VariantKind, { maxEdge: number; quality: number }> = {
  thumb: { maxEdge: 256, quality: 78 },
  medium: { maxEdge: 1024, quality: 82 },
};

/**
 * Variants are always JPEG, regardless of the original's format.
 *
 * A PNG original might be a screenshot with text — the exact case where JPEG's
 * blocky compression looks worst — but §8.3 does not distinguish, and carrying
 * one output format is what keeps a variant's content type predictable without
 * a lookup. Revisit if screenshots become common enough to notice.
 */
export const VARIANT_CONTENT_TYPE = 'image/jpeg';

export const variantKeyFor = (
  ownerId: string,
  mediaId: string,
  kind: VariantKind,
): string => `media/${ownerId}/${mediaId}/${kind}.jpg`;

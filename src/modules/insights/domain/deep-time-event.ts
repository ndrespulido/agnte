/**
 * A single entry in the shared deep-time catalogue.
 *
 * The one thing in this system that belongs to nobody. Every other row has an
 * `ownerId` and a visibility to resolve; this has neither, which is why the
 * read path below has no viewer and no share lookup — there is nothing to
 * decide. That is a property worth stating rather than leaving to be inferred
 * from an absent column, because "no visibility check" is otherwise exactly
 * the shape of a bug.
 */
export interface DeepTimeEvent {
  readonly id: string;
  readonly slug: string;
  /**
   * Years from 2000-01-01, negative into the past — the same axis
   * `verse.timeline_years` uses, so an entry and a Verse can be ordered
   * against each other without either module reading the other's table.
   */
  readonly timelineYears: number;
  readonly title: string;
  readonly detail: string | null;
  readonly category: DeepTimeCategory;
}

/**
 * Four buckets, matched by a CHECK in the migration.
 *
 * Coarse on purpose: the catalogue spans thirteen orders of magnitude, and a
 * finer taxonomy would be mostly empty at both ends.
 */
export type DeepTimeCategory = 'cosmic' | 'geological' | 'life' | 'human';

export const DEEP_TIME_CATEGORIES: readonly DeepTimeCategory[] = [
  'cosmic',
  'geological',
  'life',
  'human',
];

/** The largest page the catalogue will return at once. */
export const MAX_CATALOGUE_LIMIT = 50;

export const DEFAULT_CATALOGUE_LIMIT = 10;

import type { DeepTimeEvent } from './deep-time-event';

/**
 * A page of the catalogue, walked backwards from a point on the timeline.
 *
 * Only backwards: the catalogue is entirely in the past, and the one place it
 * is read from is the end of a past scroll. A `direction` parameter here would
 * be a shape kept alive for a caller that cannot exist.
 */
export interface CataloguePage {
  readonly events: readonly DeepTimeEvent[];
  /**
   * Where to continue from, or null at the Big Bang — which is the one
   * genuinely final page in this application.
   */
  readonly nextCursor: string | null;
}

export interface DeepTimeRepository {
  /**
   * Events strictly older than `before`, nearest first.
   *
   * `before` is a position on the shared axis rather than a row id, so the
   * caller can hand over the oldest Verse it holds without the catalogue
   * needing to know that verses exist.
   */
  before(before: number, limit: number, cursor: string | null): Promise<CataloguePage>;
}

import type { CataloguePage, DeepTimeRepository } from '../domain/ports';

export interface BrowseDeepTimeInput {
  /** Position on the shared axis to walk back from. */
  before: number;
  limit: number;
  cursor: string | null;
}

/**
 * A page of the catalogue.
 *
 * Thin to the point of looking unnecessary, and kept anyway: this is the seam
 * where the module's one read path is named, and where a viewer would be
 * checked if the catalogue ever gained anything that was not public. Today it
 * checks nothing because there is nothing to check — every user sees the same
 * catalogue — and that absence is exactly the thing worth having a named place
 * for rather than leaving implicit in a route handler.
 */
export const browseDeepTime = (
  input: BrowseDeepTimeInput,
  deps: { events: DeepTimeRepository },
): Promise<CataloguePage> => deps.events.before(input.before, input.limit, input.cursor);

/**
 * The insights module's public surface (architecture.md §1.1) — the only file
 * other modules and the app router may import from.
 *
 * Phase 6 opens this module with the deep-time catalogue. Dashboards, the
 * other half of §9's "insights", are not here yet.
 */
export { handleDeepTime } from './api/deep-time-routes';
export { browseDeepTime } from './application/browse-deep-time';
export {
  DEEP_TIME_CATEGORIES,
  DEFAULT_CATALOGUE_LIMIT,
  MAX_CATALOGUE_LIMIT,
} from './domain/deep-time-event';
export type { DeepTimeCategory, DeepTimeEvent } from './domain/deep-time-event';
export type { CataloguePage } from './domain/ports';

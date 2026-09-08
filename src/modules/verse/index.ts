/**
 * The verse module's public surface.
 *
 * Everything another module or the app layer may use, and nothing else. The
 * ESLint boundary rules fail the build on any import reaching past this file
 * (architecture.md §1.1).
 *
 * Note what is exported from the domain: the visibility vocabulary and the
 * resolver, but no repository and no query type. A caller outside this module
 * that could reach a repository could read rows without resolving visibility,
 * which is the single failure this module exists to prevent.
 */

export {
  handleListTagShares,
  handleRevokeTagShare,
  handleRevokeVerseShare,
  handleShareTag,
  handleShareVerse,
} from './api/share-routes';

export {
  handleTimeline,
  handleCreateVerse,
  handleDeleteVerse,
  handleGetVerse,
  handleUpdateVerse,
} from './api/verse-routes';

export {
  handleCreateTag,
  handleDeleteTag,
  handleListTags,
  handleUpdateTag,
} from './api/tag-routes';

export {
  DEFAULT_VISIBILITY,
  VISIBILITY_ORDER,
  atLeast,
  canRead,
  isVisibility,
  moreRestrictive,
  resolveVisibility,
} from './domain/visibility';
export type { Visibility } from './domain/visibility';

export { VerseErrorCode } from './domain/errors';

export {
  MAX_SHORTCUT_LENGTH,
  MAX_TAG_NAME_LENGTH,
  VERTICALS,
  VERTICAL_NAMES,
  defaultShortcut,
  format,
  isVertical,
  parseShortcut,
  parseTagName,
  suggestedProperties,
} from './domain/tag';
export type { Tag, Vertical } from './domain/tag';

export {
  MAX_LOCATION_LENGTH,
  MAX_PROPERTIES,
  MAX_PROPERTY_KEY_LENGTH,
  MAX_PROPERTY_VALUE_LENGTH,
  MAX_RATING,
  MAX_XP_LENGTH,
  MIN_RATING,
  parseLocation,
  parsePlacement,
  parseProperties,
  parseRating,
  placementOf,
} from './domain/verse';
export type { Placement, Verse } from './domain/verse';

export {
  CALENDAR_LIMIT_YEARS,
  MAX_DEEP_TIME_YEARS,
  MIN_DEEP_TIME_YEARS,
  toDeepTimeYears,
} from './domain/deep-time';

export type { SharePermission } from './domain/ports';

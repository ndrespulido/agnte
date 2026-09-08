import { DomainError } from '@/shared/kernel';

/**
 * Verse's error codes.
 *
 * Namespaced `verse.*` so a client switching on codes can tell which module
 * refused, and so two modules can both have an "invalid" without colliding.
 * Codes are the contract; the prose is free to change (architecture.md §6).
 */
export const VerseErrorCode = {
  TagNameInvalid: 'verse.tag_name_invalid',
  TagShortcutInvalid: 'verse.tag_shortcut_invalid',
  TagShortcutTaken: 'verse.tag_shortcut_taken',
  TagNotFound: 'verse.tag_not_found',
  TagAlreadyExists: 'verse.tag_already_exists',
  VerseNotFound: 'verse.not_found',
  VisibilityInvalid: 'verse.visibility_invalid',
  RatingOutOfRange: 'verse.rating_out_of_range',
  TimeConflict: 'verse.time_conflict',
  EventRangeInverted: 'verse.event_range_inverted',
  DeepTimeOutOfRange: 'verse.deep_time_out_of_range',
  PropertyKeyInvalid: 'verse.property_key_invalid',
  PropertyValueTooLong: 'verse.property_value_too_long',
  TooManyProperties: 'verse.too_many_properties',
  XpTooLong: 'verse.xp_too_long',
  LocationInvalid: 'verse.location_invalid',
  NoTags: 'verse.no_tags',
  VersionConflict: 'verse.version_conflict',
  Forbidden: 'verse.forbidden',
  CursorInvalid: 'verse.cursor_invalid',
  ShareInvalid: 'verse.share_invalid',
  ShareNotPermitted: 'verse.share_not_permitted',
  SearchQueryInvalid: 'verse.search_query_invalid',
} as const;

export type VerseErrorCode = (typeof VerseErrorCode)[keyof typeof VerseErrorCode];

export const tagNameInvalid = (reason: string): DomainError =>
  new DomainError(VerseErrorCode.TagNameInvalid, `Tag name is not valid: ${reason}.`);

export const tagShortcutInvalid = (reason: string): DomainError =>
  new DomainError(VerseErrorCode.TagShortcutInvalid, `Shortcut is not valid: ${reason}.`);

export const tagShortcutTaken = (shortcut: string): DomainError =>
  new DomainError(
    VerseErrorCode.TagShortcutTaken,
    `The shortcut .${shortcut} already belongs to another tag.`,
    { details: { shortcut } },
  );

export const tagNotFound = (): DomainError =>
  new DomainError(VerseErrorCode.TagNotFound, 'That tag does not exist.');

export const tagAlreadyExists = (name: string): DomainError =>
  new DomainError(VerseErrorCode.TagAlreadyExists, `You already have a tag .${name}.`, {
    details: { name },
  });

export const visibilityInvalid = (): DomainError =>
  new DomainError(
    VerseErrorCode.VisibilityInvalid,
    "Visibility must be 'private', 'shared' or 'public'.",
  );

export const verseNotFound = (): DomainError =>
  new DomainError(VerseErrorCode.VerseNotFound, 'That verse does not exist.');

export const ratingOutOfRange = (min: number, max: number): DomainError =>
  new DomainError(
    VerseErrorCode.RatingOutOfRange,
    `Rating must be between ${min} and ${max}.`,
    { details: { min, max } },
  );

export const timeConflict = (): DomainError =>
  new DomainError(
    VerseErrorCode.TimeConflict,
    'A verse is placed either on the calendar or in deep time, not both.',
  );

export const eventRangeInverted = (): DomainError =>
  new DomainError(
    VerseErrorCode.EventRangeInverted,
    'The end of an event cannot come before its start.',
  );

export const deepTimeOutOfRange = (min: number, max: number): DomainError =>
  new DomainError(
    VerseErrorCode.DeepTimeOutOfRange,
    `Deep time must be between ${min} and ${max} years from now.`,
    { details: { min, max } },
  );

export const propertyKeyInvalid = (key: string, reason: string): DomainError =>
  new DomainError(
    VerseErrorCode.PropertyKeyInvalid,
    `Property key is not valid: ${reason}.`,
    { details: { key } },
  );

export const propertyValueTooLong = (key: string, maximum: number): DomainError =>
  new DomainError(
    VerseErrorCode.PropertyValueTooLong,
    `Property values must be at most ${maximum} characters.`,
    { details: { key, maximum } },
  );

export const tooManyProperties = (maximum: number): DomainError =>
  new DomainError(
    VerseErrorCode.TooManyProperties,
    `A verse may carry at most ${maximum} properties.`,
    { details: { maximum } },
  );

export const xpTooLong = (maximum: number): DomainError =>
  new DomainError(VerseErrorCode.XpTooLong, `xp must be at most ${maximum} characters.`, {
    details: { maximum },
  });

export const locationInvalid = (reason: string): DomainError =>
  new DomainError(VerseErrorCode.LocationInvalid, `Location is not valid: ${reason}.`);

export const noTags = (): DomainError =>
  new DomainError(VerseErrorCode.NoTags, 'A verse needs at least one tag.');

/**
 * Carries the current server state, because the client's next move is to merge
 * (architecture.md §2) and a bare "conflict" would force a second round trip to
 * find out against what.
 */
export const versionConflict = (expected: number, actual: number): DomainError =>
  new DomainError(
    VerseErrorCode.VersionConflict,
    'This verse changed since you loaded it.',
    { details: { expected, actual } },
  );

/**
 * Deliberately worded as "does not exist".
 *
 * Distinguishing "not yours" from "not there" tells an unauthenticated caller
 * which ids are real, which is the enumeration leak identity already avoids on
 * sign-in. The status code differs (404, not 403) for the same reason.
 */
export const forbidden = (): DomainError =>
  new DomainError(VerseErrorCode.Forbidden, 'That verse does not exist.');

export const cursorInvalid = (): DomainError =>
  new DomainError(VerseErrorCode.CursorInvalid, 'That page cursor is not valid.');

export const shareInvalid = (reason: string): DomainError =>
  new DomainError(VerseErrorCode.ShareInvalid, `Share is not valid: ${reason}.`);

export const shareNotPermitted = (): DomainError =>
  new DomainError(
    VerseErrorCode.ShareNotPermitted,
    'Collaborators cannot add to a shared tag yet.',
  );

export const searchQueryInvalid = (reason: string): DomainError =>
  new DomainError(
    VerseErrorCode.SearchQueryInvalid,
    `Search query is not valid: ${reason}.`,
  );

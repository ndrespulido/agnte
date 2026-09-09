/**
 * The media domain's surface, re-exported from one file for the same reason
 * identity's and verse's are: `application/` and the tests import from
 * `./domain` rather than reaching for individual files.
 */
export * from './errors';
export * from './media';
export * from './ports';
export * from './variant';

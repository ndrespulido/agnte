/**
 * The verse domain's surface.
 *
 * Re-exported from one file so `application/` and the tests import from
 * `./domain` rather than reaching for individual files — the same convention
 * identity follows, and what keeps a later reshuffle of this directory from
 * touching every caller.
 */
export * from './deep-time';
export * from './errors';
export * from './ports';
export * from './tag';
export * from './verse';
export * from './visibility';

/**
 * `@agnte/core` — what every client of the API shares.
 *
 * Pure TypeScript: no React, no Next, no Node built-ins, no database. That is
 * the whole contract, and ESLint holds it, because this package is what a
 * React Native build imports and anything else would not run there.
 *
 * It is not a domain-model library (§1.1 still forbids one between modules).
 * Nothing here knows what a Verse is on the server; it holds the things a
 * client needs to *draw and write* one — design tokens, string tables, how a
 * date is read, where a verse sits on the timeline.
 */
export * from './tokens';
export * from './i18n';
export * from './dates';
export * from './timeline';
export * from './composer';

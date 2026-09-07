/**
 * Identity's domain layer. Framework-free and ORM-free by construction — the
 * ESLint boundary rules in eslint.config.mjs fail the build if that changes.
 */
export * from './email';
export * from './errors';
export * from './password';
export * from './ports';
export * from './user';
export * from './verification';

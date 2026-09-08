/**
 * Reading a Postgres constraint failure back out of a Prisma error.
 *
 * The shape is not obvious and was read off real failures rather than guessed.
 * A raw query through a Prisma 7 driver adapter does not surface P2002 with a
 * flat `meta.constraint`; it reports P2010 ("raw query failed") and nests the
 * driver's own report:
 *
 *   { code: 'P2010', meta: { driverAdapterError: { cause: {
 *       originalCode: '23505', kind: 'UniqueConstraintViolation',
 *       constraint: { index: 'tag_owner_id_name_key' } } } } }
 *
 * Both forms are handled: the nested one for the raw path the repositories use,
 * and the flat P2002 for a caller that ever moves to the typed client.
 *
 * This lives in shared/infra rather than in a module because it describes the
 * database driver, not a domain. Sharing *infrastructure* between modules is
 * fine; sharing domain types is what re-couples them (CLAUDE.md).
 *
 * Note: identity has its own older, email-specific copy of this logic in
 * `prisma-user-repository.ts`. Left alone deliberately — folding working auth
 * code into a new helper buys nothing and risks something.
 */

/** Postgres SQLSTATE for a unique violation. */
export const UNIQUE_VIOLATION = '23505';

/** Postgres SQLSTATE for a check-constraint violation. */
export const CHECK_VIOLATION = '23514';

interface DriverCause {
  originalCode?: unknown;
  kind?: unknown;
  constraint?: unknown;
}

const driverCause = (error: unknown): DriverCause | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: unknown } } }).meta;
  return meta?.driverAdapterError?.cause as DriverCause | undefined;
};

/**
 * The name of the constraint a failure names, or null when the error is not a
 * constraint violation at all.
 *
 * Returning the *name* rather than a boolean is what lets a caller tell one
 * conflict from another — a tag creation can fail on the name index or the
 * shortcut index, and answering "already exists" for the wrong one would point
 * the user at the wrong field.
 */
export function constraintName(error: unknown): string | null {
  const cause = driverCause(error);
  const constraint =
    cause?.constraint ??
    (typeof error === 'object' && error !== null
      ? (error as { meta?: { constraint?: unknown } }).meta?.constraint
      : undefined);

  if (typeof constraint === 'string') return constraint;
  if (typeof constraint === 'object' && constraint !== null) {
    const index = (constraint as { index?: unknown }).index;
    if (typeof index === 'string') return index;

    const fields = (constraint as { fields?: unknown }).fields;
    if (Array.isArray(fields)) return fields.map(String).join(',');
  }

  return null;
}

export function isUniqueViolation(error: unknown): boolean {
  const cause = driverCause(error);
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;

  return (
    cause?.kind === 'UniqueConstraintViolation' ||
    cause?.originalCode === UNIQUE_VIOLATION ||
    code === UNIQUE_VIOLATION ||
    code === 'P2002'
  );
}

export function isCheckViolation(error: unknown): boolean {
  const cause = driverCause(error);
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;

  return cause?.originalCode === CHECK_VIOLATION || code === CHECK_VIOLATION;
}

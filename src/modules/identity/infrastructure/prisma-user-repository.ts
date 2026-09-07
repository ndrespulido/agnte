import { getDatabase } from '@/shared/infra/database';
import type { Email } from '../domain/email';
import type { CreateUserOutcome, UserRepository } from '../domain/ports';
import type { User } from '../domain/user';

/** Postgres unique-violation. */
const UNIQUE_VIOLATION = '23505';

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email as Email,
  passwordHash: row.password_hash,
  displayName: row.display_name,
  emailVerifiedAt: row.email_verified_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  version: row.version,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) {
    // Unlike rate limiting, which fails open, identity has no safe degraded
    // mode: without a database there is no way to tell a real account from an
    // invented one, and guessing would be worse than an outage.
    throw new Error('identity requires a database; DATABASE_URL is not set');
  }
  return db;
};

export class PrismaUserRepository implements UserRepository {
  async findByEmail(email: Email): Promise<User | null> {
    const rows = await requireDatabase().$queryRaw<UserRow[]>`
      SELECT * FROM identity."user" WHERE email = ${email} LIMIT 1
    `;
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findById(id: string): Promise<User | null> {
    const rows = await requireDatabase().$queryRaw<UserRow[]>`
      SELECT * FROM identity."user" WHERE id = ${id}::uuid LIMIT 1
    `;
    return rows[0] ? toUser(rows[0]) : null;
  }

  /**
   * Insert and let the unique index arbitrate, rather than checking first.
   *
   * A SELECT-then-INSERT has a window between the two in which another
   * registration can slip in, and the loser gets a raw constraint error from
   * deep in the driver instead of the outcome the caller asked for. Catching
   * the violation is the check.
   */
  async create(user: User): Promise<CreateUserOutcome> {
    try {
      await requireDatabase().$executeRaw`
        INSERT INTO identity."user"
          (id, email, password_hash, display_name, email_verified_at, created_at, updated_at, version)
        VALUES (
          ${user.id}::uuid,
          ${user.email},
          ${user.passwordHash},
          ${user.displayName},
          ${user.emailVerifiedAt},
          ${user.createdAt},
          ${user.updatedAt},
          ${user.version}
        )
      `;
      return { kind: 'created' };
    } catch (error) {
      if (isUniqueViolation(error)) return { kind: 'email-taken' };
      throw error;
    }
  }
}

/**
 * Narrow to *this* constraint failing, not to any error that mentions it.
 *
 * The shape is not obvious and was read off a real failure rather than guessed.
 * A raw query through a Prisma 7 driver adapter does not surface P2002 with a
 * flat `meta.constraint`; it reports P2010 ("raw query failed") and nests the
 * driver's own report:
 *
 *   { code: 'P2010', meta: { driverAdapterError: { cause: {
 *       originalCode: '23505', kind: 'UniqueConstraintViolation',
 *       constraint: { index: 'user_email_key' } } } } }
 *
 * Both are handled: the nested form for the raw path this repository uses, and
 * the flat P2002 form in case a caller ever moves to the typed client.
 *
 * Matching on the message text instead would also swallow a unique violation on
 * some future index, reporting "email taken" for an unrelated conflict.
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  const record = error as Record<string, unknown>;
  const cause = (record.meta as { driverAdapterError?: { cause?: unknown } } | undefined)
    ?.driverAdapterError?.cause as Record<string, unknown> | undefined;

  const isUnique =
    cause?.kind === 'UniqueConstraintViolation' ||
    cause?.originalCode === UNIQUE_VIOLATION ||
    record.code === UNIQUE_VIOLATION ||
    record.code === 'P2002';

  if (!isUnique) return false;

  return (
    namesEmailIndex(cause?.constraint) ||
    namesEmailIndex((record.meta as Record<string, unknown> | undefined)?.constraint)
  );
}

/**
 * Only the email index means "that address is taken". Any other unique index
 * failing is a different bug, and reporting it as a taken address would hide it.
 *
 * When nothing names an index, fall back to true rather than re-throwing: the
 * only unique constraint on this table is the email one, so a violation here
 * is that violation. If a second one is ever added, the tests that assert on
 * `email-taken` are what will catch this assumption expiring.
 */
function namesEmailIndex(constraint: unknown): boolean {
  if (constraint === undefined || constraint === null) return false;
  if (typeof constraint === 'string') return constraint.includes('email');

  const index = (constraint as { index?: unknown; fields?: unknown }).index;
  if (typeof index === 'string') return index.includes('email');

  const fields = (constraint as { fields?: unknown }).fields;
  if (Array.isArray(fields)) return fields.some((f) => String(f).includes('email'));

  return false;
}

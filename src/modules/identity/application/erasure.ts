import { getDatabase } from '@/shared/infra/database';

/**
 * The identity half of erasure (architecture.md §8.7).
 *
 * Marking and hard-deleting live here rather than in `privacy` for the same
 * reason every other module purges its own rows: privacy coordinates, it does
 * not reach into six schemas. What it owns is the *decision*; what each module
 * owns is its own data.
 */

/**
 * How long a marked account survives before the sweep removes it.
 *
 * §8.7 asks for thirty days, and the reason is not caution about the code.
 * Erasure is irreversible and occasionally regretted; an account recovered on
 * day three is a person helped rather than a support request that cannot be
 * answered. The grace window is also the one thing standing between a stolen
 * session and permanent destruction of someone's timeline.
 */
export const ERASURE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('identity requires a database; DATABASE_URL is not set');
  return db;
};

/**
 * Marks an account for erasure, idempotently.
 *
 * The timestamp is only set if it is not already set, so a second request does
 * not silently restart the grace window — which would let a repeated call keep
 * an account alive indefinitely while the person believes it is being deleted.
 */
export async function markForErasure(userId: string, now: Date): Promise<boolean> {
  const updated = await requireDatabase().$executeRaw`
    UPDATE identity."user"
       SET erasure_requested_at = ${now}, updated_at = NOW(), version = version + 1
     WHERE id = ${userId}::uuid AND erasure_requested_at IS NULL
  `;
  return updated > 0;
}

/** Accounts whose grace window has closed. */
export async function erasableUsers(now: Date, limit = 50): Promise<string[]> {
  const cutoff = new Date(now.getTime() - ERASURE_GRACE_MS);
  const rows = await requireDatabase().$queryRaw<{ id: string }[]>`
    SELECT id FROM identity."user"
     WHERE erasure_requested_at IS NOT NULL AND erasure_requested_at <= ${cutoff}
     ORDER BY erasure_requested_at ASC
     LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

/**
 * Removes the account itself.
 *
 * Runs last, after every module has purged its own data: while the row exists
 * the erasure can be retried and audited, and a failure part-way through leaves
 * an account that is still marked rather than orphaned rows with no owner to
 * trace them back to.
 */
export async function hardDeleteUser(userId: string): Promise<void> {
  const db = requireDatabase();
  // Sessions and pending state first — a refresh token outliving its user
  // would be a credential with nothing to revoke it.
  await db.$executeRaw`DELETE FROM identity.refresh_token WHERE user_id = ${userId}::uuid`;
  await db.$executeRaw`DELETE FROM identity.password_reset_token WHERE user_id = ${userId}::uuid`;
  await db.$executeRaw`DELETE FROM identity."user" WHERE id = ${userId}::uuid`;
}

/** Whether this account has been marked — the credential path refuses if so. */
export async function isMarkedForErasure(userId: string): Promise<boolean> {
  const rows = await requireDatabase().$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM identity."user"
     WHERE id = ${userId}::uuid AND erasure_requested_at IS NOT NULL
  `;
  return rows.length > 0;
}

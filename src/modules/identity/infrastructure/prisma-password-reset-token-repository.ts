import { getDatabase } from '@/shared/infra/database';
import type { PasswordResetTokenRepository, RedeemResetOutcome } from '../domain/ports';
import type { PasswordResetToken } from '../domain/password-reset';

interface ResetRow {
  token_hash: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
}

const toToken = (row: ResetRow): PasswordResetToken => ({
  tokenHash: row.token_hash,
  userId: row.user_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
  invalidatedAt: row.invalidated_at,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('identity requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaPasswordResetTokenRepository implements PasswordResetTokenRepository {
  async issue(token: PasswordResetToken): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO identity.password_reset_token
        (token_hash, user_id, created_at, expires_at)
      VALUES (
        ${token.tokenHash},
        ${token.userId}::uuid,
        ${token.createdAt},
        ${token.expiresAt}
      )
    `;
  }

  /**
   * One statement claims the token; a second reads back what it was.
   *
   * The conditional UPDATE is what makes this single-use under concurrency:
   * two clicks on the same link both reach it, but only one updates a row.
   * The loser then reads the row to find out *why* it lost — spent, expired or
   * never there — which is information the person clicking can act on, and
   * which a bare "no rows updated" cannot distinguish.
   *
   * Expiry is checked after claiming rather than in the WHERE clause, for the
   * same reason as pending registrations: filtering it out would leave an
   * expired row indistinguishable from a token that never existed.
   */
  async redeem(tokenHash: string, now: Date): Promise<RedeemResetOutcome> {
    const claimed = await requireDatabase().$queryRaw<ResetRow[]>`
      UPDATE identity.password_reset_token
      SET consumed_at = ${now}
      WHERE token_hash = ${tokenHash}
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
      RETURNING *
    `;

    const row = claimed[0];
    if (row) {
      const token = toToken(row);
      // Claimed, then found to be stale. Consuming it anyway is right: it can
      // never be used now, and leaving it live would let it be retried until it
      // was noticed.
      if (token.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
      return { kind: 'redeemed', token };
    }

    const existing = await requireDatabase().$queryRaw<ResetRow[]>`
      SELECT * FROM identity.password_reset_token WHERE token_hash = ${tokenHash} LIMIT 1
    `;

    return existing[0] ? { kind: 'spent' } : { kind: 'not-found' };
  }

  async invalidateAllForUser(userId: string, now: Date): Promise<number> {
    return requireDatabase().$executeRaw`
      UPDATE identity.password_reset_token
      SET invalidated_at = ${now}
      WHERE user_id = ${userId}::uuid
        AND consumed_at IS NULL
        AND invalidated_at IS NULL
    `;
  }
}

/**
 * Drops reset tokens past their expiry.
 *
 * Same gap as the other three pruners: tested, no scheduled caller yet.
 */
export async function prunePasswordResetTokens(now: Date): Promise<number> {
  const db = getDatabase();
  if (!db) return 0;

  return db.$executeRaw`
    DELETE FROM identity.password_reset_token WHERE expires_at < ${now}
  `;
}

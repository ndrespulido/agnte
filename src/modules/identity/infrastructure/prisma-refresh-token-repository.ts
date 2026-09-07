import { getDatabase } from '@/shared/infra/database';
import type { PresentTokenOutcome, RefreshTokenRepository } from '../domain/ports';
import type { RefreshToken } from '../domain/session';

interface TokenRow {
  token_hash: string;
  user_id: string;
  family_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
}

const toToken = (row: TokenRow): RefreshToken => ({
  tokenHash: row.token_hash,
  userId: row.user_id,
  familyId: row.family_id,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at,
  revokedAt: row.revoked_at,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('identity requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  async start(token: RefreshToken): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO identity.refresh_token
        (token_hash, user_id, family_id, created_at, expires_at, consumed_at, revoked_at)
      VALUES (
        ${token.tokenHash},
        ${token.userId}::uuid,
        ${token.familyId}::uuid,
        ${token.createdAt},
        ${token.expiresAt},
        ${token.consumedAt},
        ${token.revokedAt}
      )
    `;
  }

  async present(tokenHash: string, now: Date): Promise<PresentTokenOutcome> {
    const rows = await requireDatabase().$queryRaw<TokenRow[]>`
      SELECT * FROM identity.refresh_token WHERE token_hash = ${tokenHash} LIMIT 1
    `;

    const row = rows[0];
    if (!row) return { kind: 'unknown' };

    const token = toToken(row);

    // Same order as refreshTokenState, and for the same reason: `consumed` must
    // not be lost behind an expiry that has since caught up with it, because
    // consumed-and-presented-again is the theft signal.
    if (token.revokedAt !== null) return { kind: 'revoked' };
    if (token.consumedAt !== null) return { kind: 'reused', token };
    if (token.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };

    return { kind: 'valid', token };
  }

  /**
   * Consume and replace in one transaction.
   *
   * The consume is conditional — `WHERE consumed_at IS NULL AND revoked_at IS
   * NULL` — so two concurrent refreshes with the same token cannot both
   * succeed; the loser updates zero rows and is told to retry. Wrapping both
   * statements together is what stops a half-done rotation: a consume without
   * its replacement signs the client out mid-refresh, and a replacement without
   * the consume leaves two live tokens in one family, so the next honest
   * refresh looks like reuse and kills the session.
   */
  async rotate(
    previousHash: string,
    replacement: RefreshToken,
    now: Date,
  ): Promise<boolean> {
    const db = requireDatabase();

    return db.$transaction(async (tx) => {
      const consumed = await tx.$executeRaw`
        UPDATE identity.refresh_token
        SET consumed_at = ${now}
        WHERE token_hash = ${previousHash}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
      `;

      if (consumed === 0) return false;

      await tx.$executeRaw`
        INSERT INTO identity.refresh_token
          (token_hash, user_id, family_id, created_at, expires_at)
        VALUES (
          ${replacement.tokenHash},
          ${replacement.userId}::uuid,
          ${replacement.familyId}::uuid,
          ${replacement.createdAt},
          ${replacement.expiresAt}
        )
      `;

      return true;
    });
  }

  /**
   * Revokes the live tokens in a family, leaving the spent ones alone.
   *
   * Consumed rows are deliberately not touched: they are the record that makes
   * reuse detectable, and marking them revoked would lose the distinction
   * between "this token was spent normally" and "this session was killed".
   */
  async revokeFamily(familyId: string, now: Date): Promise<number> {
    return requireDatabase().$executeRaw`
      UPDATE identity.refresh_token
      SET revoked_at = ${now}
      WHERE family_id = ${familyId}::uuid
        AND consumed_at IS NULL
        AND revoked_at IS NULL
    `;
  }

  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    return requireDatabase().$executeRaw`
      UPDATE identity.refresh_token
      SET revoked_at = ${now}
      WHERE user_id = ${userId}::uuid
        AND consumed_at IS NULL
        AND revoked_at IS NULL
    `;
  }
}

/**
 * Drops refresh tokens past their expiry.
 *
 * Later than the other pruners' 24h: a consumed row has to outlive the token it
 * replaced for reuse detection to see a replay, and the whole point is catching
 * a thief who surfaces long after the theft. Expiry is the right boundary —
 * past it the token could not be exchanged anyway.
 *
 * Same gap as the others: tested, but nothing calls it until Cloud Scheduler
 * and an /internal/prune route land.
 */
export async function pruneRefreshTokens(now: Date): Promise<number> {
  const db = getDatabase();
  if (!db) return 0;

  return db.$executeRaw`
    DELETE FROM identity.refresh_token WHERE expires_at < ${now}
  `;
}

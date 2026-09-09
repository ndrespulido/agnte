import { getDatabase } from '@/shared/infra/database';
import type { OAuthHandoff } from '../domain/oauth-handoff';
import type { OAuthHandoffRepository } from '../domain/ports';

interface HandoffRow {
  code_hash: string;
  user_id: string;
  created: boolean;
  created_at: Date;
  expires_at: Date;
}

const toHandoff = (row: HandoffRow): OAuthHandoff => ({
  codeHash: row.code_hash,
  userId: row.user_id,
  created: row.created,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('identity requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaOAuthHandoffRepository implements OAuthHandoffRepository {
  async issue(handoff: OAuthHandoff): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO identity.oauth_handoff
        (code_hash, user_id, created, created_at, expires_at)
      VALUES (
        ${handoff.codeHash},
        ${handoff.userId}::uuid,
        ${handoff.created},
        ${handoff.createdAt},
        ${handoff.expiresAt}
      )
    `;
  }

  /**
   * One statement deletes and returns, which is what makes a code single-use
   * even under a race.
   *
   * The reset token's repository needs two statements because it marks a row
   * spent and then reads it back to say *why* a second click failed. Here
   * there is no such answer to give, so the delete can carry the read: two
   * simultaneous exchanges of the same code both run this, exactly one
   * matches a row, and the loser gets null with no window in between.
   *
   * Expiry is in the same predicate rather than checked afterwards. A row past
   * its two minutes is treated as absent and left for `prune`.
   */
  async consume(codeHash: string, now: Date): Promise<OAuthHandoff | null> {
    const rows = await requireDatabase().$queryRaw<HandoffRow[]>`
      DELETE FROM identity.oauth_handoff
      WHERE code_hash = ${codeHash}
        AND expires_at > ${now}
      RETURNING code_hash, user_id, created, created_at, expires_at
    `;
    return rows[0] ? toHandoff(rows[0]) : null;
  }

  async prune(now: Date): Promise<number> {
    return requireDatabase().$executeRaw`
      DELETE FROM identity.oauth_handoff WHERE expires_at <= ${now}
    `;
  }
}

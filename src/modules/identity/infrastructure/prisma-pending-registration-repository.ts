import { getDatabase } from '@/shared/infra/database';
import type { Email } from '../domain/email';
import type { PendingRegistrationRepository, RedeemOutcome } from '../domain/ports';
import type { PendingRegistration } from '../domain/verification';

interface PendingRow {
  token_hash: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: Date;
  expires_at: Date;
}

const toRegistration = (row: PendingRow): PendingRegistration => ({
  tokenHash: row.token_hash,
  email: row.email as Email,
  passwordHash: row.password_hash,
  displayName: row.display_name,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('identity requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaPendingRegistrationRepository implements PendingRegistrationRepository {
  async start(registration: PendingRegistration): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO identity.pending_registration
        (token_hash, email, password_hash, display_name, created_at, expires_at)
      VALUES (
        ${registration.tokenHash},
        ${registration.email},
        ${registration.passwordHash},
        ${registration.displayName},
        ${registration.createdAt},
        ${registration.expiresAt}
      )
    `;
  }

  /**
   * One statement: delete the row and return what it held.
   *
   * `DELETE ... RETURNING` is what makes this single-use under concurrency.
   * Two requests carrying the same link both reach the delete, but only one
   * removes a row and gets it back; the other returns empty and is told the
   * link is spent. A SELECT followed by a DELETE would let both read the row
   * and both go on to create an account, and only one of those inserts can win
   * the unique index — so a perfectly valid link would produce an error.
   *
   * Expiry is checked *after* claiming rather than in the WHERE clause,
   * deliberately: filtering on `expires_at > now` would leave an expired row in
   * place and make it indistinguishable from a token that never existed. Taking
   * it first lets the caller say "expired, request another" instead of the much
   * less useful "invalid".
   */
  async redeem(tokenHash: string, now: Date): Promise<RedeemOutcome> {
    const rows = await requireDatabase().$queryRaw<PendingRow[]>`
      DELETE FROM identity.pending_registration
      WHERE token_hash = ${tokenHash}
      RETURNING *
    `;

    const row = rows[0];
    if (!row) return { kind: 'not-found' };

    const registration = toRegistration(row);
    if (registration.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };

    return { kind: 'redeemed', registration };
  }

  async discardOthersFor(email: Email): Promise<number> {
    return requireDatabase().$executeRaw`
      DELETE FROM identity.pending_registration WHERE email = ${email}
    `;
  }
}

/**
 * Drops registrations whose 24h has run out (§8.7 retention).
 *
 * Same gap as the platform-schema pruners: this exists and is tested, but
 * nothing calls it until Cloud Scheduler and an /internal/prune route land.
 * It matters slightly more here than there, because each abandoned row holds a
 * password hash.
 */
export async function prunePendingRegistrations(now: Date): Promise<number> {
  const db = getDatabase();
  if (!db) return 0;

  return db.$executeRaw`
    DELETE FROM identity.pending_registration WHERE expires_at < ${now}
  `;
}

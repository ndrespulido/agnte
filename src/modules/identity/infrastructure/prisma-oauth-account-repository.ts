import { getDatabase } from '@/shared/infra/database';
import type { OAuthAccountLink, OAuthAccountRepository } from '../domain/ports';

interface AccountRow {
  provider: string;
  provider_account_id: string;
  user_id: string;
  email: string | null;
}

const requireDatabase = () => {
  const db = getDatabase();
  if (!db) throw new Error('identity requires a database; DATABASE_URL is not set');
  return db;
};

export class PrismaOAuthAccountRepository implements OAuthAccountRepository {
  async findByProviderAccount(
    provider: string,
    subject: string,
  ): Promise<OAuthAccountLink | null> {
    const rows = await requireDatabase().$queryRaw<AccountRow[]>`
      SELECT * FROM identity.oauth_account
      WHERE provider = ${provider} AND provider_account_id = ${subject}
      LIMIT 1
    `;

    const row = rows[0];
    if (!row) return null;

    return {
      provider: row.provider,
      providerAccountId: row.provider_account_id,
      userId: row.user_id,
      email: row.email,
    };
  }

  async link(input: OAuthAccountLink): Promise<void> {
    await requireDatabase().$executeRaw`
      INSERT INTO identity.oauth_account (provider, provider_account_id, user_id, email)
      VALUES (${input.provider}, ${input.providerAccountId}, ${input.userId}::uuid, ${input.email})
    `;
  }
}

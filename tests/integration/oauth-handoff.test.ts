import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { handleGoogleExchange } from '@/modules/identity';
import { issueOAuthHandoff } from '@/modules/identity/domain/oauth-handoff';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import type { Email } from '@/modules/identity/domain/email';
import { CryptoTokenGenerator } from '@/modules/identity/infrastructure/crypto-token-generator';
import { PrismaOAuthHandoffRepository } from '@/modules/identity/infrastructure/prisma-oauth-handoff-repository';
import { PrismaUserRepository } from '@/modules/identity/infrastructure/prisma-user-repository';

/**
 * The handoff code is what stands between a completed Google sign-in and a
 * session, so the properties that matter are the ones a replay would exploit:
 * it works once, it works briefly, and what is stored is not what is
 * presented.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const handoffs = new PrismaOAuthHandoffRepository();
const users = new PrismaUserRepository();
const tokens = new CryptoTokenGenerator();

describe.skipIf(!DATABASE_URL)('the Google handoff code', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    process.env.JWT_SECRET = 'e'.repeat(64);
    resetConfigForTests();

    const db = getDatabase()!;
    await db.$executeRawUnsafe('DELETE FROM identity.oauth_handoff');
    await db.$executeRawUnsafe('DELETE FROM identity.refresh_token');
    await db.$executeRawUnsafe('DELETE FROM identity."user"');
    await db.$executeRawUnsafe('DELETE FROM platform.rate_limit_window');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  /** A real user row, since the handoff carries a foreign key to one. */
  const someone = async (): Promise<string> => {
    const user = createVerifiedUser({
      email: `handoff-${uuidv7()}@example.com` as Email,
      passwordHash: null,
      displayName: null,
      clock,
    });
    await users.create(user);
    return user.id;
  };

  const mint = async (userId: string, created = false): Promise<string> => {
    const issued = tokens.issue();
    await handoffs.issue(
      issueOAuthHandoff({ codeHash: issued.tokenHash, userId, created, clock }),
    );
    return issued.token;
  };

  const exchange = (code: unknown) =>
    handleGoogleExchange(
      new Request('https://agnte.test/v1/auth/google/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
        body: JSON.stringify({ code }),
      }),
    );

  describe('the repository', () => {
    it('stores the hash, never the code itself', async () => {
      const userId = await someone();
      const code = await mint(userId);

      const rows = await getDatabase()!.$queryRawUnsafe<{ code_hash: string }[]>(
        'SELECT code_hash FROM identity.oauth_handoff',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.code_hash).not.toBe(code);
      expect(rows[0]?.code_hash).toBe(tokens.hashOf(code));
    });

    it('consumes a code exactly once', async () => {
      const userId = await someone();
      const code = await mint(userId);

      const first = await handoffs.consume(tokens.hashOf(code), NOW);
      expect(first?.userId).toBe(userId);

      // The row is gone, not marked spent — a replay finds nothing.
      expect(await handoffs.consume(tokens.hashOf(code), NOW)).toBe(null);
    });

    it('refuses a code past its expiry, and prune clears it', async () => {
      const userId = await someone();
      const code = await mint(userId);
      const later = new Date(NOW.getTime() + 3 * 60 * 1000);

      expect(await handoffs.consume(tokens.hashOf(code), later)).toBe(null);
      // Still there, because consume left it rather than deleting it.
      expect(await handoffs.prune(later)).toBe(1);
      expect(await handoffs.prune(later)).toBe(0);
    });

    it('carries whether the sign-in created the account', async () => {
      const userId = await someone();
      const code = await mint(userId, true);
      expect((await handoffs.consume(tokens.hashOf(code), NOW))?.created).toBe(true);
    });
  });

  describe('the exchange endpoint', () => {
    it('trades a code for a session, and starts a revocable one', async () => {
      const userId = await someone();
      const code = await mint(userId, true);

      const response = await exchange(code);
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
        tokenType: string;
        created: boolean;
      };
      expect(body.tokenType).toBe('Bearer');
      expect(body.created).toBe(true);
      expect(body.accessToken.length).toBeGreaterThan(0);

      // The guarantee that used to live in the unit test for signInWithGoogle:
      // a Google sign-in ends in a session that can actually be revoked.
      const sessions = await getDatabase()!.$queryRawUnsafe<{ user_id: string }[]>(
        'SELECT user_id FROM identity.refresh_token',
      );
      expect(sessions.map((s) => s.user_id)).toEqual([userId]);
    });

    it('refuses a replay of a code that already produced a session', async () => {
      const userId = await someone();
      const code = await mint(userId);

      expect((await exchange(code)).status).toBe(200);
      expect((await exchange(code)).status).toBe(400);

      // And the replay did not mint a second session.
      const sessions = await getDatabase()!.$queryRawUnsafe<unknown[]>(
        'SELECT user_id FROM identity.refresh_token',
      );
      expect(sessions).toHaveLength(1);
    });

    it('refuses a code nobody issued', async () => {
      expect((await exchange(tokens.issue().token)).status).toBe(400);
    });

    it('refuses a missing or malformed code with 400, not a crash', async () => {
      expect((await exchange(undefined)).status).toBe(400);
      expect((await exchange(42)).status).toBe(400);
      expect((await exchange('')).status).toBe(400);
    });
  });
});

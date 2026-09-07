import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { fixedClock } from '@/shared/kernel';
import { CryptoTokenGenerator } from '@/modules/identity/infrastructure/crypto-token-generator';
import {
  PrismaPasswordResetTokenRepository,
  prunePasswordResetTokens,
} from '@/modules/identity/infrastructure/prisma-password-reset-token-repository';
import { PrismaUserRepository } from '@/modules/identity/infrastructure/prisma-user-repository';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import { issuePasswordReset } from '@/modules/identity/domain/password-reset';
import type { Email } from '@/modules/identity/domain/email';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-07T12:00:00.000Z');
const clock = fixedClock(NOW);
const ARGON2ID_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';

const resets = new PrismaPasswordResetTokenRepository();
const users = new PrismaUserRepository();
const tokens = new CryptoTokenGenerator();

describe.skipIf(!DATABASE_URL)('password reset against real Postgres', () => {
  let userId: string;

  beforeEach(async () => {
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity.password_reset_token');
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity."user"');

    const user = createVerifiedUser({
      email: 'a@example.com' as Email,
      passwordHash: ARGON2ID_HASH,
      clock,
    });
    await users.create(user);
    userId = user.id;
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const issue = async () => {
    const token = tokens.issue();
    await resets.issue(issuePasswordReset({ tokenHash: token.tokenHash, userId, clock }));
    return token;
  };

  it('redeems a token once', async () => {
    const token = await issue();

    expect((await resets.redeem(token.tokenHash, NOW)).kind).toBe('redeemed');
    expect((await resets.redeem(token.tokenHash, NOW)).kind).toBe('spent');
  });

  it('distinguishes a token that never existed from one that is spent', async () => {
    // Both are refusals, but the person holding a spent link needs to request a
    // new one, and the person with a mistyped URL needs to re-copy it.
    expect((await resets.redeem('0'.repeat(64), NOW)).kind).toBe('not-found');
  });

  it('lets exactly one of many concurrent redemptions win', async () => {
    const token = await issue();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => resets.redeem(token.tokenHash, NOW)),
    );

    expect(outcomes.filter((o) => o.kind === 'redeemed')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'spent')).toHaveLength(4);
  });

  it('consumes an expired token rather than leaving it live', async () => {
    const token = await issue();
    const past = new Date(NOW.getTime() + PLUS_TWO_HOURS);

    expect((await resets.redeem(token.tokenHash, past)).kind).toBe('expired');
    // Already consumed by that attempt: it could never be used anyway, and
    // leaving it live would let it be retried until someone noticed.
    expect((await resets.redeem(token.tokenHash, NOW)).kind).toBe('spent');
  });

  it('invalidates every live token for a user', async () => {
    const a = await issue();
    const b = await issue();
    await resets.redeem(a.tokenHash, NOW);

    // Only the live one; the spent one is already accounted for.
    expect(await resets.invalidateAllForUser(userId, NOW)).toBe(1);
    expect((await resets.redeem(b.tokenHash, NOW)).kind).toBe('spent');
  });

  it('updates a password only when the version matches', async () => {
    const user = (await users.findById(userId))!;

    expect(
      await users.updatePassword({
        userId,
        passwordHash: ARGON2ID_HASH,
        expectedVersion: user.version,
        now: NOW,
      }),
    ).toBe(true);

    // The same call again carries a version that is now stale.
    expect(
      await users.updatePassword({
        userId,
        passwordHash: ARGON2ID_HASH,
        expectedVersion: user.version,
        now: NOW,
      }),
    ).toBe(false);

    expect((await users.findById(userId))?.version).toBe(user.version + 1);
  });

  it('prunes only tokens past their expiry', async () => {
    await issue();

    expect(await prunePasswordResetTokens(NOW)).toBe(0);
    expect(await prunePasswordResetTokens(new Date(NOW.getTime() + PLUS_TWO_HOURS))).toBe(
      1,
    );
  });

  it('stores the hash, never the token', async () => {
    const token = await issue();

    const rows = await getDatabase()!.$queryRawUnsafe<Record<string, unknown>[]>(
      'SELECT * FROM identity.password_reset_token',
    );
    expect(JSON.stringify(rows)).not.toContain(token.token);
  });

  it('deletes a user’s reset tokens with the user (GDPR erasure, §8.7)', async () => {
    await issue();
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity."user"');

    const rows = await getDatabase()!.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM identity.password_reset_token',
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('refuses a raw token where a sha256 hash belongs', async () => {
    await expect(
      getDatabase()!.$executeRawUnsafe(
        `INSERT INTO identity.password_reset_token (token_hash, user_id, expires_at)
         VALUES ('not-a-sha256', '${userId}', now() + interval '1 hour')`,
      ),
    ).rejects.toThrow(/password_reset_token_hash_shape_check/);
  });
});

const PLUS_TWO_HOURS = 2 * 60 * 60 * 1000;

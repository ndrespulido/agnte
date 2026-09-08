import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { getDatabase } from '@/shared/infra/database';
import { fixedClock, uuidv7 } from '@/shared/kernel';
import { CryptoTokenGenerator } from '@/modules/identity/infrastructure/crypto-token-generator';
import {
  audienceFor,
  JwtAccessTokenIssuer,
  accessTokenSecret,
  resetDevelopmentSecretForTests,
} from '@/modules/identity/infrastructure/jwt-access-token-issuer';
import {
  PrismaRefreshTokenRepository,
  pruneRefreshTokens,
} from '@/modules/identity/infrastructure/prisma-refresh-token-repository';
import { PrismaUserRepository } from '@/modules/identity/infrastructure/prisma-user-repository';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import { rotateSession, startSession } from '@/modules/identity/domain/session';
import type { Email } from '@/modules/identity/domain/email';

const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-07T12:00:00.000Z');
const clock = fixedClock(NOW);
const ARGON2ID_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';

const sessions = new PrismaRefreshTokenRepository();
const users = new PrismaUserRepository();
const tokens = new CryptoTokenGenerator();

const SECRET = 'a'.repeat(32);

describe('JwtAccessTokenIssuer', () => {
  const issuer = new JwtAccessTokenIssuer(SECRET, 'local');

  it('round-trips the subject', async () => {
    const userId = uuidv7();
    expect(await issuer.verify(await issuer.issue(userId))).toBe(userId);
  });

  it('rejects a token signed with a different key', async () => {
    const other = new JwtAccessTokenIssuer('b'.repeat(32), 'local');
    expect(await issuer.verify(await other.issue(uuidv7()))).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await issuer.issue(uuidv7());
    const [header, , signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else' })).toString(
      'base64url',
    );

    expect(await issuer.verify(`${header}.${forged}.${signature}`)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await new SignJWT({ typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(uuidv7())
      .setIssuer('agnte')
      .setAudience('agnte-api')
      .setIssuedAt(past - 60)
      .setExpirationTime(past)
      .sign(new TextEncoder().encode(SECRET));

    expect(await issuer.verify(expired)).toBeNull();
  });

  it('rejects a correctly signed token of the wrong type', async () => {
    // The `typ` guard. Without it a token minted for some other purpose — a
    // password reset in 1.5, say — would be accepted as an access token.
    const wrongType = await new SignJWT({ typ: 'password-reset' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(uuidv7())
      .setIssuer('agnte')
      .setAudience('agnte-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));

    expect(await issuer.verify(wrongType)).toBeNull();
  });

  it('rejects a token for a different audience', async () => {
    const wrongAudience = await new SignJWT({ typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(uuidv7())
      .setIssuer('agnte')
      .setAudience('somewhere-else')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));

    expect(await issuer.verify(wrongAudience)).toBeNull();
  });

  it('rejects an unsigned token claiming alg none', async () => {
    // The classic JWT bug. Note this one passes with or without our
    // `algorithms` pin — jose refuses "none" on its own — so it documents that
    // guarantee rather than proving anything about our configuration. The test
    // below is the one that exercises the pin.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({ sub: 'attacker', typ: 'access', iss: 'agnte', aud: 'agnte-api' }),
    ).toString('base64url');

    expect(await issuer.verify(`${header}.${payload}.`)).toBeNull();
  });

  it('rejects a token signed with a different algorithm, even with the right key', async () => {
    // This is what pinning `algorithms: ['HS256']` buys. Left unpinned, jose
    // honours whatever the token's own header asks for, and a verifier that
    // accepts more than one algorithm is the shape every JWT
    // algorithm-confusion attack is built on.
    const hs512 = await new SignJWT({ typ: 'access' })
      .setProtectedHeader({ alg: 'HS512' })
      .setSubject(uuidv7())
      .setIssuer('agnte')
      .setAudience('agnte-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));

    expect(await issuer.verify(hs512)).toBeNull();
  });

  it('rejects rubbish rather than throwing', async () => {
    for (const bad of ['', 'not.a.jwt', 'a.b.c.d', '...']) {
      expect(await issuer.verify(bad)).toBeNull();
    }
  });
});

describe('accessTokenSecret', () => {
  beforeEach(() => resetDevelopmentSecretForTests());

  it('uses the configured secret when there is one', () => {
    expect(accessTokenSecret(SECRET, true)).toBe(SECRET);
    expect(accessTokenSecret(SECRET, false)).toBe(SECRET);
  });

  it('generates a stable throwaway secret locally', () => {
    const first = accessTokenSecret(undefined, true);
    expect(first).toHaveLength(64);
    // Stable within a process, or every request would invalidate the last one's
    // tokens and local development would be unusable.
    expect(accessTokenSecret(undefined, true)).toBe(first);
  });

  it('refuses to invent one in a deployed environment', () => {
    // A per-process secret in production logs everyone out on every cold start,
    // which on a scale-to-zero platform is constantly.
    expect(accessTokenSecret(undefined, false)).toBeUndefined();
  });
});

describe.skipIf(!DATABASE_URL)('refresh tokens against real Postgres', () => {
  let userId: string;

  beforeEach(async () => {
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity.refresh_token');
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

  const start = async () => {
    const issued = tokens.issue();
    const token = startSession({ tokenHash: issued.tokenHash, userId, clock });
    await sessions.start(token);
    return { issued, token };
  };

  it('classifies a live token as valid', async () => {
    const { issued } = await start();
    expect((await sessions.present(issued.tokenHash, NOW)).kind).toBe('valid');
  });

  it('classifies an unknown token', async () => {
    expect((await sessions.present('0'.repeat(64), NOW)).kind).toBe('unknown');
  });

  it('rotates atomically: the old is spent and the new is live', async () => {
    const { issued, token } = await start();
    const next = tokens.issue();

    const rotated = await sessions.rotate(
      issued.tokenHash,
      rotateSession(token, next.tokenHash, clock),
      NOW,
    );

    expect(rotated).toBe(true);
    expect((await sessions.present(issued.tokenHash, NOW)).kind).toBe('reused');
    expect((await sessions.present(next.tokenHash, NOW)).kind).toBe('valid');
  });

  it('lets exactly one of many concurrent rotations win', async () => {
    // Two tabs refreshing at once must not both get a new token: that would
    // leave two live tokens in one family, and the next honest refresh would
    // look like reuse and kill the session.
    const { issued, token } = await start();

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        sessions.rotate(
          issued.tokenHash,
          rotateSession(token, tokens.issue().tokenHash, clock),
          NOW,
        ),
      ),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const live = await getDatabase()!.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM identity.refresh_token WHERE consumed_at IS NULL AND revoked_at IS NULL',
    );
    expect(Number(live[0]!.n)).toBe(1);
  });

  it('rolls the whole rotation back if the replacement cannot be written', async () => {
    // The transaction is what makes "consume and replace" all-or-nothing. A
    // consume that stuck without its replacement would sign the client out
    // mid-refresh, with no token left to retry with.
    const { issued, token } = await start();

    const badReplacement = { ...rotateSession(token, 'not-a-sha256-hash', clock) };
    await expect(
      sessions.rotate(issued.tokenHash, badReplacement, NOW),
    ).rejects.toThrow();

    expect((await sessions.present(issued.tokenHash, NOW)).kind).toBe('valid');
  });

  it('revokes a family without touching its spent tokens', async () => {
    const { issued, token } = await start();
    const next = tokens.issue();
    await sessions.rotate(
      issued.tokenHash,
      rotateSession(token, next.tokenHash, clock),
      NOW,
    );

    expect(await sessions.revokeFamily(token.familyId, NOW)).toBe(1);

    // The spent one stays 'reused', not 'revoked' — that distinction is what
    // reuse detection reads.
    expect((await sessions.present(issued.tokenHash, NOW)).kind).toBe('reused');
    expect((await sessions.present(next.tokenHash, NOW)).kind).toBe('revoked');
  });

  it('revokes every session for a user', async () => {
    await start();
    await start();

    expect(await sessions.revokeAllForUser(userId, NOW)).toBe(2);
  });

  it('prunes only tokens past their expiry', async () => {
    const { issued } = await start();

    expect(await pruneRefreshTokens(NOW)).toBe(0);
    const wellPast = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await pruneRefreshTokens(wellPast)).toBe(1);
    expect((await sessions.present(issued.tokenHash, NOW)).kind).toBe('unknown');
  });

  it('stores the hash, never the token', async () => {
    const { issued } = await start();

    const rows = await getDatabase()!.$queryRawUnsafe<Record<string, unknown>[]>(
      'SELECT * FROM identity.refresh_token',
    );
    expect(JSON.stringify(rows)).not.toContain(issued.token);
  });

  it('deletes a user’s tokens with the user (GDPR erasure, §8.7)', async () => {
    await start();

    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity."user"');

    const rows = await getDatabase()!.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT count(*) AS n FROM identity.refresh_token',
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

/**
 * Tokens must not be portable between environments.
 *
 * Preview and production were mounting the same signing secret, and preview
 * databases are branched from production — so signing in on a publicly
 * reachable preview URL yielded a token that production would accept. The
 * secrets are separated now; this is the part of the fix that holds even if
 * they are ever shared again by accident.
 */
describe('the access token audience', () => {
  it('is the bare production audience only in production', () => {
    expect(audienceFor('production')).toBe('agnte-api');
    expect(audienceFor('preview')).toBe('agnte-api-preview');
    expect(audienceFor('local')).toBe('agnte-api-local');
  });

  it('refuses a preview token in production, even with the same key', () => {
    const secret = 'x'.repeat(48);
    const preview = new JwtAccessTokenIssuer(secret, 'preview');
    const production = new JwtAccessTokenIssuer(secret, 'production');

    return preview.issue('01a081a7-bf4f-72e8-b77c-d8821d48f573').then(async (token) => {
      // The same key verifies the signature; the audience is what refuses it.
      expect(await preview.verify(token)).not.toBe(null);
      expect(await production.verify(token)).toBe(null);
    });
  });

  it('refuses a production token in preview', async () => {
    const secret = 'x'.repeat(48);
    const preview = new JwtAccessTokenIssuer(secret, 'preview');
    const production = new JwtAccessTokenIssuer(secret, 'production');

    const token = await production.issue('01a081a7-bf4f-72e8-b77c-d8821d48f573');
    expect(await preview.verify(token)).toBe(null);
  });
});

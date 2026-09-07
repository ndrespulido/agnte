import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { fixedClock } from '@/shared/kernel';
import { Argon2PasswordHasher } from '@/modules/identity/infrastructure/argon2-password-hasher';
import {
  CryptoTokenGenerator,
  sha256Hex,
} from '@/modules/identity/infrastructure/crypto-token-generator';
import {
  PrismaPendingRegistrationRepository,
  prunePendingRegistrations,
} from '@/modules/identity/infrastructure/prisma-pending-registration-repository';
import { PrismaUserRepository } from '@/modules/identity/infrastructure/prisma-user-repository';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import { startRegistration } from '@/modules/identity/domain/verification';
import type { Email } from '@/modules/identity/domain/email';
import type { RawPassword } from '@/modules/identity/domain/password';

/**
 * Runs against a real Postgres, and skips without one — the same rule as the
 * other integration suites (architecture.md §7.1). The adapters are exactly the
 * part unit tests with fakes cannot vouch for: SQL, constraints and races.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const NOW = new Date('2026-09-07T12:00:00.000Z');
const clock = fixedClock(NOW);

const users = new PrismaUserRepository();
const pending = new PrismaPendingRegistrationRepository();
const tokens = new CryptoTokenGenerator();

const ARGON2ID_HASH = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA';

describe.skipIf(!DATABASE_URL)('identity repositories against real Postgres', () => {
  beforeEach(async () => {
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity.pending_registration');
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity."user"');
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  const registration = (email: string, tokenHash: string, passwordHash = ARGON2ID_HASH) =>
    startRegistration({
      tokenHash,
      email: email as Email,
      passwordHash,
      displayName: null,
      clock,
    });

  describe('users', () => {
    it('round-trips a user', async () => {
      const user = createVerifiedUser({
        email: 'a@example.com' as Email,
        passwordHash: ARGON2ID_HASH,
        displayName: 'Andrés',
        clock,
      });

      expect(await users.create(user)).toEqual({ kind: 'created' });

      const found = await users.findByEmail('a@example.com' as Email);
      expect(found?.id).toBe(user.id);
      expect(found?.displayName).toBe('Andrés');
      expect(found?.emailVerifiedAt?.toISOString()).toBe(NOW.toISOString());
      expect(await users.findById(user.id)).toEqual(found);
    });

    it('reports email-taken rather than throwing', async () => {
      const first = createVerifiedUser({
        email: 'dup@example.com' as Email,
        passwordHash: ARGON2ID_HASH,
        clock,
      });
      const second = createVerifiedUser({
        email: 'dup@example.com' as Email,
        passwordHash: ARGON2ID_HASH,
        clock,
      });

      await users.create(first);
      expect(await users.create(second)).toEqual({ kind: 'email-taken' });
    });

    it('lets exactly one of many concurrent creates win', async () => {
      const attempts = Array.from({ length: 5 }, () =>
        createVerifiedUser({
          email: 'race@example.com' as Email,
          passwordHash: ARGON2ID_HASH,
          clock,
        }),
      );

      const outcomes = await Promise.all(attempts.map((user) => users.create(user)));

      expect(outcomes.filter((o) => o.kind === 'created')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'email-taken')).toHaveLength(4);
    });

    it('returns null for an address with no account', async () => {
      expect(await users.findByEmail('nobody@example.com' as Email)).toBeNull();
    });

    it('does not mistake an unrelated constraint failure for a taken address', async () => {
      // The unique-violation check has to be narrow. If it reported every
      // database error as 'email-taken', a genuine bug would be swallowed and
      // the caller would cheerfully tell the user their address was in use.
      const broken = {
        ...createVerifiedUser({
          email: 'check@example.com' as Email,
          passwordHash: ARGON2ID_HASH,
          clock,
        }),
        passwordHash: '$2b$12$this-is-bcrypt-not-argon2id',
      };

      await expect(users.create(broken)).rejects.toThrow(
        /user_password_hash_argon2id_check/,
      );
    });
  });

  describe('pending registrations', () => {
    it('redeems a token once and reports it gone afterwards', async () => {
      const issued = tokens.issue();
      await pending.start(registration('a@example.com', issued.tokenHash));

      const first = await pending.redeem(issued.tokenHash, NOW);
      expect(first.kind).toBe('redeemed');

      const second = await pending.redeem(issued.tokenHash, NOW);
      expect(second.kind).toBe('not-found');
    });

    it('lets exactly one of many concurrent redemptions win', async () => {
      // The property that DELETE ... RETURNING buys over SELECT-then-DELETE.
      const issued = tokens.issue();
      await pending.start(registration('a@example.com', issued.tokenHash));

      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => pending.redeem(issued.tokenHash, NOW)),
      );

      expect(outcomes.filter((o) => o.kind === 'redeemed')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'not-found')).toHaveLength(4);
    });

    it('reports an expired token as expired, not as missing', async () => {
      const issued = tokens.issue();
      await pending.start(registration('a@example.com', issued.tokenHash));

      const past = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
      expect((await pending.redeem(issued.tokenHash, past)).kind).toBe('expired');
    });

    it('discards siblings for an address', async () => {
      const a = tokens.issue();
      const b = tokens.issue();
      await pending.start(registration('same@example.com', a.tokenHash));
      await pending.start(registration('same@example.com', b.tokenHash));
      const other = tokens.issue();
      await pending.start(registration('other@example.com', other.tokenHash));

      expect(await pending.discardOthersFor('same@example.com' as Email)).toBe(2);
      expect((await pending.redeem(other.tokenHash, NOW)).kind).toBe('redeemed');
    });

    it('prunes only rows past their expiry', async () => {
      const stale = tokens.issue();
      const fresh = tokens.issue();
      await pending.start(registration('stale@example.com', stale.tokenHash));
      await pending.start(registration('fresh@example.com', fresh.tokenHash));

      const wellPast = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
      expect(await prunePendingRegistrations(wellPast)).toBe(2);
      expect((await pending.redeem(fresh.tokenHash, NOW)).kind).toBe('not-found');
    });

    it('stores the hash of the token, never the token itself', async () => {
      const issued = tokens.issue();
      await pending.start(registration('a@example.com', issued.tokenHash));

      const rows = await getDatabase()!.$queryRawUnsafe<Record<string, unknown>[]>(
        'SELECT * FROM identity.pending_registration',
      );

      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(issued.token);
      expect(serialised).toContain(sha256Hex(issued.token));
    });
  });

  describe('database constraints back the domain rules up', () => {
    it('refuses an email the domain would have normalised', async () => {
      await expect(
        getDatabase()!.$executeRawUnsafe(
          `INSERT INTO identity."user" (id, email, password_hash, updated_at)
           VALUES (gen_random_uuid(), 'Mixed@Case.com', '${ARGON2ID_HASH}', now())`,
        ),
      ).rejects.toThrow(/user_email_normalised_check/);
    });

    it('refuses a password hash that is not argon2id', async () => {
      await expect(
        getDatabase()!.$executeRawUnsafe(
          `INSERT INTO identity."user" (id, email, password_hash, updated_at)
           VALUES (gen_random_uuid(), 'bcrypt@example.com', '$2b$12$notargon', now())`,
        ),
      ).rejects.toThrow(/user_password_hash_argon2id_check/);
    });

    it('refuses a raw token where a sha256 hash belongs', async () => {
      await expect(
        getDatabase()!.$executeRawUnsafe(
          `INSERT INTO identity.pending_registration (token_hash, email, password_hash, expires_at)
           VALUES ('not-a-sha256', 'a@example.com', '${ARGON2ID_HASH}', now() + interval '1 day')`,
        ),
      ).rejects.toThrow(/pending_registration_token_hash_shape_check/);
    });
  });
});

describe('Argon2id hasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('produces an argon2id PHC string the database will accept', async () => {
    const hash = await hasher.hash('a sufficiently long password' as RawPassword);
    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hasher.hash('a sufficiently long password' as RawPassword);
    expect(await hasher.verify(hash, 'a sufficiently long password')).toBe(true);
    expect(await hasher.verify(hash, 'a sufficiently long passworD')).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hasher.hash('the same password twice' as RawPassword);
    const b = await hasher.hash('the same password twice' as RawPassword);
    expect(a).not.toBe(b);
    expect(await hasher.verify(b, 'the same password twice')).toBe(true);
  });

  it('returns false for a malformed hash rather than throwing', async () => {
    expect(await hasher.verify('not a hash at all', 'anything')).toBe(false);
  });

  it('uses the OWASP parameters, encoded in the hash itself', async () => {
    const hash = await hasher.hash('a sufficiently long password' as RawPassword);
    expect(hash).toContain('$m=19456,t=2,p=1$');
  });
});

describe('token generator', () => {
  const generator = new CryptoTokenGenerator();

  it('issues a distinct 256-bit token each time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generator.issue().token));
    expect(seen.size).toBe(200);
    expect(Buffer.from([...seen][0]!, 'base64url')).toHaveLength(32);
  });

  it('is URL-safe, so a mail client cannot mangle the link', () => {
    for (let i = 0; i < 200; i += 1) {
      const { token } = generator.issue();
      expect(token).toBe(encodeURIComponent(token));
    }
  });

  it('hashes a presented token the same way it hashed the issued one', () => {
    const issued = generator.issue();
    expect(generator.hashOf(issued.token)).toBe(issued.tokenHash);
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

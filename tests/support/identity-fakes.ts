import type {
  AccessTokenIssuer,
  CreateUserOutcome,
  IdentityMailer,
  IssuedToken,
  PasswordHasher,
  PasswordResetTokenRepository,
  PendingRegistrationRepository,
  PresentTokenOutcome,
  RedeemResetOutcome,
  RedeemOutcome,
  RefreshTokenRepository,
  UserRepository,
  VerificationTokenGenerator,
} from '@/modules/identity/domain/ports';
import type { Email } from '@/modules/identity/domain/email';
import type { RawPassword } from '@/modules/identity/domain/password';
import type { User } from '@/modules/identity/domain/user';
import type { PendingRegistration } from '@/modules/identity/domain/verification';
import type { RefreshToken } from '@/modules/identity/domain/session';
import type { PasswordResetToken } from '@/modules/identity/domain/password-reset';

/**
 * In-memory doubles for identity's ports.
 *
 * The point of defining ports in the domain is that the use cases can be
 * exercised without Postgres, Argon2 or a mail server — so these exist to make
 * the rules testable at the speed of a unit test. The adapters get their own
 * integration tests against the real thing.
 */

export class FakeUserRepository implements UserRepository {
  readonly users = new Map<string, User>();

  async findByEmail(email: Email): Promise<User | null> {
    for (const user of this.users.values()) if (user.email === email) return user;
    return null;
  }

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async create(user: User): Promise<CreateUserOutcome> {
    if ((await this.findByEmail(user.email)) !== null) return { kind: 'email-taken' };
    this.users.set(user.id, user);
    return { kind: 'created' };
  }

  async updatePassword(input: {
    userId: string;
    passwordHash: string;
    expectedVersion: number;
    now: Date;
  }): Promise<boolean> {
    const user = this.users.get(input.userId);
    // Mirrors the real repository's conditional UPDATE, so a test can exercise
    // the stale-write path without a database.
    if (!user || user.version !== input.expectedVersion) return false;

    this.users.set(input.userId, {
      ...user,
      passwordHash: input.passwordHash,
      updatedAt: input.now,
      version: user.version + 1,
    });
    return true;
  }
}

export class FakePasswordResetTokenRepository implements PasswordResetTokenRepository {
  readonly rows = new Map<string, PasswordResetToken>();

  async issue(token: PasswordResetToken): Promise<void> {
    this.rows.set(token.tokenHash, token);
  }

  async redeem(tokenHash: string, now: Date): Promise<RedeemResetOutcome> {
    const token = this.rows.get(tokenHash);
    if (!token) return { kind: 'not-found' };
    if (token.consumedAt !== null || token.invalidatedAt !== null)
      return { kind: 'spent' };

    this.rows.set(tokenHash, { ...token, consumedAt: now });
    if (token.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };

    return { kind: 'redeemed', token };
  }

  async invalidateAllForUser(userId: string, now: Date): Promise<number> {
    let invalidated = 0;
    for (const [hash, token] of this.rows) {
      if (
        token.userId === userId &&
        token.consumedAt === null &&
        token.invalidatedAt === null
      ) {
        this.rows.set(hash, { ...token, invalidatedAt: now });
        invalidated += 1;
      }
    }
    return invalidated;
  }
}

export class FakePendingRegistrationRepository implements PendingRegistrationRepository {
  readonly rows = new Map<string, PendingRegistration>();

  async start(registration: PendingRegistration): Promise<void> {
    this.rows.set(registration.tokenHash, registration);
  }

  async redeem(tokenHash: string, now: Date): Promise<RedeemOutcome> {
    const row = this.rows.get(tokenHash);
    if (!row) return { kind: 'not-found' };
    // Mirrors the real repository: the row is claimed before expiry is judged,
    // so a stale link is consumed rather than left to be retried forever.
    this.rows.delete(tokenHash);
    if (row.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
    return { kind: 'redeemed', registration: row };
  }

  async discardOthersFor(email: Email): Promise<number> {
    let removed = 0;
    for (const [hash, row] of this.rows) {
      if (row.email === email) {
        this.rows.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }
}

/** Reversible stand-in for Argon2, so a test can assert *which* password was hashed. */
export class FakePasswordHasher implements PasswordHasher {
  hashCalls = 0;
  burnCalls = 0;

  async hash(password: RawPassword): Promise<string> {
    this.hashCalls += 1;
    return `hashed:${password}`;
  }

  async verify(hash: string, candidate: string): Promise<boolean> {
    return hash === `hashed:${candidate}`;
  }

  /** Counted rather than slept: a test asserts it was called, not that it took time. */
  async burnVerificationTime(): Promise<void> {
    this.burnCalls += 1;
  }
}

export class FakeTokenGenerator implements VerificationTokenGenerator {
  private counter = 0;

  issue(): IssuedToken {
    this.counter += 1;
    const token = `token-${this.counter}`;
    return { token, tokenHash: this.hashOf(token) };
  }

  hashOf(token: string): string {
    return `hash-of:${token}`;
  }
}

export interface SentEmail {
  kind: 'verification' | 'duplicate-registration' | 'password-reset' | 'no-such-account';
  to: string;
  url: string;
}

export class FakeMailer implements IdentityMailer {
  readonly sent: SentEmail[] = [];

  async sendVerification(input: { to: Email; verificationUrl: string }): Promise<void> {
    this.sent.push({ kind: 'verification', to: input.to, url: input.verificationUrl });
  }

  async sendDuplicateRegistrationNotice(input: {
    to: Email;
    signInUrl: string;
  }): Promise<void> {
    this.sent.push({
      kind: 'duplicate-registration',
      to: input.to,
      url: input.signInUrl,
    });
  }

  async sendPasswordReset(input: { to: Email; resetUrl: string }): Promise<void> {
    this.sent.push({ kind: 'password-reset', to: input.to, url: input.resetUrl });
  }

  async sendPasswordResetForUnknownAddress(input: {
    to: Email;
    registerUrl: string;
  }): Promise<void> {
    this.sent.push({ kind: 'no-such-account', to: input.to, url: input.registerUrl });
  }
}

export class FakeAccessTokenIssuer implements AccessTokenIssuer {
  private counter = 0;

  async issue(userId: string): Promise<string> {
    this.counter += 1;
    return `access:${userId}:${this.counter}`;
  }

  async verify(token: string): Promise<string | null> {
    const parts = token.split(':');
    return parts[0] === 'access' && parts[1] ? parts[1] : null;
  }
}

export class FakeRefreshTokenRepository implements RefreshTokenRepository {
  readonly rows = new Map<string, RefreshToken>();

  async start(token: RefreshToken): Promise<void> {
    this.rows.set(token.tokenHash, token);
  }

  async present(tokenHash: string, now: Date): Promise<PresentTokenOutcome> {
    const token = this.rows.get(tokenHash);
    if (!token) return { kind: 'unknown' };

    // Same order as the real repository, and for the same reason: `reused` must
    // not be lost behind an expiry that has since caught up with it.
    if (token.revokedAt !== null) return { kind: 'revoked' };
    if (token.consumedAt !== null) return { kind: 'reused', token };
    if (token.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };
    return { kind: 'valid', token };
  }

  async rotate(
    previousHash: string,
    replacement: RefreshToken,
    now: Date,
  ): Promise<boolean> {
    const previous = this.rows.get(previousHash);
    if (!previous || previous.consumedAt !== null || previous.revokedAt !== null)
      return false;

    this.rows.set(previousHash, { ...previous, consumedAt: now });
    this.rows.set(replacement.tokenHash, replacement);
    return true;
  }

  async revokeFamily(familyId: string, now: Date): Promise<number> {
    let revoked = 0;
    for (const [hash, token] of this.rows) {
      if (
        token.familyId === familyId &&
        token.consumedAt === null &&
        token.revokedAt === null
      ) {
        this.rows.set(hash, { ...token, revokedAt: now });
        revoked += 1;
      }
    }
    return revoked;
  }

  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    let revoked = 0;
    for (const [hash, token] of this.rows) {
      if (
        token.userId === userId &&
        token.consumedAt === null &&
        token.revokedAt === null
      ) {
        this.rows.set(hash, { ...token, revokedAt: now });
        revoked += 1;
      }
    }
    return revoked;
  }
}

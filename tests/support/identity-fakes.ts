import type {
  CreateUserOutcome,
  IdentityMailer,
  IssuedToken,
  PasswordHasher,
  PendingRegistrationRepository,
  RedeemOutcome,
  UserRepository,
  VerificationTokenGenerator,
} from '@/modules/identity/domain/ports';
import type { Email } from '@/modules/identity/domain/email';
import type { RawPassword } from '@/modules/identity/domain/password';
import type { User } from '@/modules/identity/domain/user';
import type { PendingRegistration } from '@/modules/identity/domain/verification';

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

  async hash(password: RawPassword): Promise<string> {
    this.hashCalls += 1;
    return `hashed:${password}`;
  }

  async verify(hash: string, candidate: string): Promise<boolean> {
    return hash === `hashed:${candidate}`;
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
  kind: 'verification' | 'duplicate-registration';
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
}

import type { Email } from './email';
import type { RawPassword } from './password';
import type { User } from './user';
import type { RefreshToken } from './session';
import type { PendingRegistration } from './verification';

/**
 * The ports identity needs (hexagonal architecture, architecture.md §1).
 *
 * These live in domain/ and are implemented in infrastructure/. The direction
 * matters: the domain states what it needs in its own vocabulary, and the
 * adapters bend to fit. Reversing it — letting the domain import a Prisma
 * client or an HTTP mailer — is what makes business rules impossible to test
 * without a database and impossible to move later.
 */

export interface PasswordHasher {
  hash(password: RawPassword): Promise<string>;

  verify(hash: string, candidate: string): Promise<boolean>;

  /**
   * Spend a verification's worth of work without having a hash to check.
   *
   * Part of the port, not an adapter detail: sign-in has branches that reach no
   * stored hash at all — an unknown address, a malformed one — and returning
   * from those in microseconds while a real check costs tens of milliseconds
   * tells an attacker which addresses are registered. The domain needs to be
   * able to say "spend it anyway", so the contract has to offer it.
   */
  burnVerificationTime(): Promise<void>;
}

/** The token handed to the user, paired with the hash that gets stored. */
export interface IssuedToken {
  readonly token: string;
  readonly tokenHash: string;
}

export interface VerificationTokenGenerator {
  issue(): IssuedToken;

  /** Same hash function as `issue`, for looking a presented token back up. */
  hashOf(token: string): string;
}

/**
 * Why `create` returns a result rather than throwing: two registrations for the
 * same address can race past a "does this email exist?" check and both attempt
 * an insert. One of them loses to the unique index. That is expected, not
 * exceptional, so it is in the return type where the caller has to handle it.
 */
export type CreateUserOutcome = { kind: 'created' } | { kind: 'email-taken' };

export interface UserRepository {
  findByEmail(email: Email): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  create(user: User): Promise<CreateUserOutcome>;
}

/**
 * `redeem` claims a pending registration and reports what it found in one step.
 *
 * Split into a read then a delete, two requests carrying the same link could
 * both see the row and both go on to create an account — and only one of those
 * inserts can win the unique index, so the other user gets an error for a link
 * that was perfectly valid. Claiming atomically means exactly one caller ever
 * holds the registration.
 */
export type RedeemOutcome =
  | { kind: 'redeemed'; registration: PendingRegistration }
  | { kind: 'not-found' }
  | { kind: 'expired' };

export interface PendingRegistrationRepository {
  start(registration: PendingRegistration): Promise<void>;

  /** Atomically removes and returns the row for this token hash. */
  redeem(tokenHash: string, now: Date): Promise<RedeemOutcome>;

  /**
   * Drops any other outstanding attempts for an address once one has succeeded.
   * They cannot produce an account any more — the email is taken — and each one
   * holds a password hash worth not keeping.
   */
  discardOthersFor(email: Email): Promise<number>;
}

/**
 * Identity-shaped rather than a generic `send(subject, body)`.
 *
 * A port describes what the domain needs, and what it needs is "tell this
 * person how to verify their address" — not "deliver arbitrary text". Keeping
 * templates behind the port means the application layer never composes a
 * subject line, and swapping Resend for something else touches one file.
 */
export interface IdentityMailer {
  sendVerification(input: {
    to: Email;
    displayName: string | null;
    verificationUrl: string;
  }): Promise<void>;

  /**
   * Sent when someone registers with an address that already has an account.
   * The registration endpoint cannot say "that email is taken" without becoming
   * an account-enumeration oracle, so the *owner* is told instead — which is
   * also the person who would want to know.
   */
  sendDuplicateRegistrationNotice(input: {
    to: Email;
    displayName: string | null;
    signInUrl: string;
  }): Promise<void>;
}

/**
 * Issues and reads the short-lived access token.
 *
 * A port rather than a direct call into a JWT library, for the ordinary reason:
 * the domain should be able to say "give me a token for this user" without
 * knowing what a JWT is, and the use cases should be testable without a signing
 * key.
 */
export interface AccessTokenIssuer {
  issue(userId: string): Promise<string>;

  /** Returns the subject, or null for anything that does not verify. */
  verify(token: string): Promise<string | null>;
}

export interface RefreshTokenGenerator {
  issue(): IssuedToken;
  hashOf(token: string): string;
}

/**
 * What presenting a refresh token turned out to mean.
 *
 * `reused` is the one that matters. Rotation alone limits the damage of a
 * stolen token to the window before the real client next refreshes; it is this
 * outcome that makes the theft *visible*, because a token that has already been
 * exchanged can only be presented again by someone replaying it. There is no
 * way to tell the thief from the victim, so the family goes.
 */
export type PresentTokenOutcome =
  | { kind: 'valid'; token: RefreshToken }
  | { kind: 'unknown' }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'reused'; token: RefreshToken };

export interface RefreshTokenRepository {
  start(token: RefreshToken): Promise<void>;

  /** Reads a token and classifies it, without changing anything. */
  present(tokenHash: string, now: Date): Promise<PresentTokenOutcome>;

  /**
   * Atomically consumes a token and stores its replacement.
   *
   * Both halves or neither: a consume that succeeded without its replacement
   * being written would sign the client out mid-refresh, and a replacement
   * written without the consume would leave two live tokens in one family, so
   * the next honest refresh would look like reuse and revoke the session.
   * Returns false if the token was no longer consumable, which is how two
   * concurrent refreshes resolve to one winner.
   */
  rotate(previousHash: string, replacement: RefreshToken, now: Date): Promise<boolean>;

  /** Revokes every live token in a family. Returns how many it revoked. */
  revokeFamily(familyId: string, now: Date): Promise<number>;

  /** Revokes every live token for a user — "sign out everywhere". */
  revokeAllForUser(userId: string, now: Date): Promise<number>;
}

import { uuidv7, type Clock } from '@/shared/kernel';
import type { Email } from './email';

/**
 * A person with an account (architecture.md §4).
 *
 * Readonly throughout: a state change returns a new User rather than mutating
 * one in place, so a value read before a change cannot silently become the
 * value after it while another code path still holds it.
 */
export interface User {
  readonly id: string;
  readonly email: Email;
  /**
   * Null for an account that only signs in with Google (architecture.md §4).
   * A placeholder hash would be a credential nobody chose and nobody can use.
   */
  readonly passwordHash: string | null;
  readonly displayName: string | null;

  /**
   * The language this person reads, as a locale code.
   *
   * Here rather than in a settings module because it is not only a display
   * preference: `notifications` composes a reminder email in it, from a
   * scheduled tick that has no request and therefore no `Accept-Language`. A
   * preference nothing but the browser could read would leave those emails in
   * English for everyone.
   *
   * A plain string, validated at the edges rather than by the type. The domain
   * has no opinion on which languages exist — that list lives in
   * `shared/i18n` and is meant to grow — and an unrecognised value resolves to
   * English when the strings are looked up, so a stale row degrades rather
   * than throwing.
   */
  readonly locale: string;

  /**
   * Null until the address is proven. This is the *only* fact about
   * verification — deriving `isVerified` from it means there is no second
   * field that can disagree with it.
   */
  readonly emailVerifiedAt: Date | null;

  /**
   * Set when this account has been marked for erasure (§8.7).
   *
   * The credential path refuses a marked account, so the thirty-day grace
   * window is a chance to *recover* an account rather than a period of
   * continued use — otherwise "delete my account" would leave a working login
   * for a month, which is not what anyone asking means.
   */
  readonly erasureRequestedAt: Date | null;

  readonly createdAt: Date;
  readonly updatedAt: Date;

  /** Optimistic concurrency (architecture.md §2). */
  readonly version: number;
}

export const isVerified = (user: User): boolean => user.emailVerifiedAt !== null;

/**
 * A user whose address has just been proven.
 *
 * There is no "create an unverified user" constructor, because there are no
 * unverified users: an account comes into existence only when a verification
 * link is redeemed (see PendingRegistration). `emailVerifiedAt` stays on the
 * model because it will stop being trivially "creation time" as soon as email
 * *changes* land, and because Google sign-in (1.6) proves the address a
 * different way.
 *
 * The id is minted here rather than by the database: UUIDv7 is client-generated
 * by design (architecture.md §2) so a row created offline has its final id
 * immediately, and the id sorts by creation time for cursor pagination.
 */
export function createVerifiedUser(input: {
  email: Email;
  passwordHash: string | null;
  displayName?: string | null;
  /** What the browser asked for at registration, if this app speaks it. */
  locale?: string | undefined;
  clock: Clock;
}): User {
  const now = input.clock.now();
  return {
    id: uuidv7(now.getTime()),
    email: input.email,
    passwordHash: input.passwordHash,
    displayName: input.displayName ?? null,
    // English unless something knew better, matching the column's default so
    // a row inserted by either path says the same thing.
    locale: input.locale ?? 'en',
    emailVerifiedAt: now,
    // A new account is never mid-erasure; the column exists for the accounts
    // that later ask to be.
    erasureRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

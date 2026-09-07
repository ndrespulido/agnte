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
  readonly passwordHash: string;
  readonly displayName: string | null;

  /**
   * Null until the address is proven. This is the *only* fact about
   * verification — deriving `isVerified` from it means there is no second
   * field that can disagree with it.
   */
  readonly emailVerifiedAt: Date | null;

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
  passwordHash: string;
  displayName?: string | null;
  clock: Clock;
}): User {
  const now = input.clock.now();
  return {
    id: uuidv7(now.getTime()),
    email: input.email,
    passwordHash: input.passwordHash,
    displayName: input.displayName ?? null,
    emailVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
}

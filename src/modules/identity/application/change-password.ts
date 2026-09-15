import { err, ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import { invalidCredentials } from '../domain/errors';
import { parsePassword } from '../domain/password';
import type {
  PasswordHasher,
  PasswordResetTokenRepository,
  RefreshTokenRepository,
  UserRepository,
} from '../domain/ports';

export interface ChangePasswordDeps {
  users: UserRepository;
  resets: PasswordResetTokenRepository;
  sessions: RefreshTokenRepository;
  hasher: PasswordHasher;
  clock: Clock;
}

export interface ChangePasswordOutcome {
  /**
   * Sessions ended by the change — *including the caller's own*. Surfaced so
   * the client can say so rather than letting it be discovered fifteen minutes
   * later when the access token expires.
   */
  readonly sessionsRevoked: number;
}

/**
 * Change the password of someone who is already signed in.
 *
 * Distinct from `resetPassword` in exactly one way that matters: the proof is
 * the current password rather than a mailed token. Everything after that proof
 * is deliberately identical, because the consequences are identical —
 *
 *  1. outstanding reset links are invalidated, since §4 requires a link to die
 *     on password change (a link that outlives the password it was issued
 *     against is a standing way back in for whoever asked for it),
 *  2. and every session is revoked, because the reason someone changes a
 *     password is usually that they think somebody else has it.
 *
 * "Every session" includes the caller's own, which is a real cost — you change
 * your password and are immediately signed out of the device in your hand.
 * Sparing it would mean knowing *which* session is calling, and an access
 * token carries only a user id (see `authenticate`); the repository can revoke
 * all of a user's tokens or none. Given that choice, revoking everything is
 * the conservative half: signing in again with the password just set costs
 * seconds, and the alternative leaves an attacker's refresh token alive
 * precisely when someone has decided there might be one.
 *
 * A user with no password at all — signed up through Google — cannot use this:
 * there is no current password to prove, and accepting one would let anyone
 * holding a hijacked access token set one. They get the same
 * `invalid_credentials` as a wrong password, which is also true.
 */
export async function changePassword(
  input: { userId: string; currentPassword: string; newPassword: string },
  deps: ChangePasswordDeps,
): Promise<Result<ChangePasswordOutcome, DomainError>> {
  // Policy first, before doing any work or any hashing: a too-short new
  // password is the caller's mistake to fix, and checking it costs nothing.
  const password = parsePassword(input.newPassword);
  if (!password.ok) return err(password.error);

  const user = await deps.users.findById(input.userId);
  // Deliberately the same answer as a wrong password. A signed-in caller whose
  // user row has vanished is not a case worth its own message.
  if (user === null || user.passwordHash === null) return err(invalidCredentials());

  const correct = await deps.hasher.verify(user.passwordHash, input.currentPassword);
  if (!correct) return err(invalidCredentials());

  const now = deps.clock.now();
  const updated = await deps.users.updatePassword({
    userId: user.id,
    passwordHash: await deps.hasher.hash(password.value),
    expectedVersion: user.version,
    now,
  });

  // The row moved between the read and the write — a reset landed first.
  // Reporting success would claim a change that did not happen.
  if (!updated) return err(invalidCredentials());

  await deps.resets.invalidateAllForUser(user.id, now);
  const sessionsRevoked = await deps.sessions.revokeAllForUser(user.id, now);

  return ok({ sessionsRevoked });
}

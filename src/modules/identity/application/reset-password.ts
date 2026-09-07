import { err, ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import {
  resetTokenAlreadyUsed,
  resetTokenExpired,
  resetTokenInvalid,
} from '../domain/errors';
import { parsePassword } from '../domain/password';
import type {
  PasswordHasher,
  PasswordResetTokenRepository,
  RefreshTokenRepository,
  UserRepository,
  VerificationTokenGenerator,
} from '../domain/ports';

export interface ResetPasswordDeps {
  users: UserRepository;
  resets: PasswordResetTokenRepository;
  sessions: RefreshTokenRepository;
  hasher: PasswordHasher;
  tokens: VerificationTokenGenerator;
  clock: Clock;
}

export interface ResetPasswordOutcome {
  readonly userId: string;
  /** Sessions ended by the reset. Surfaced so a client can say "signed out on 3 devices". */
  readonly sessionsRevoked: number;
}

/**
 * Redeem a reset link and set a new password.
 *
 * Three things happen, and all three matter:
 *
 *  1. The token is claimed atomically, so two clicks cannot both reset.
 *  2. Every other outstanding reset token for the user is invalidated — §4
 *     requires a reset link to die on password change, because a link that
 *     outlives the password it was issued against is a standing way back in for
 *     whoever requested it.
 *  3. Every session is revoked. If the reset is happening *because* the account
 *     was compromised, leaving the attacker's refresh tokens alive would make
 *     the whole exercise pointless — they would simply keep refreshing.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  deps: ResetPasswordDeps,
): Promise<Result<ResetPasswordOutcome, DomainError>> {
  // Policy first: rejecting a too-short password should not burn the token.
  // Otherwise a typo costs the user their link and a fresh trip through email.
  const password = parsePassword(newPassword);
  if (!password.ok) return err(password.error);

  const now = deps.clock.now();
  const outcome = await deps.resets.redeem(deps.tokens.hashOf(token), now);

  if (outcome.kind === 'not-found') return err(resetTokenInvalid());
  if (outcome.kind === 'expired') return err(resetTokenExpired());
  if (outcome.kind === 'spent') return err(resetTokenAlreadyUsed());

  const user = await deps.users.findById(outcome.token.userId);
  if (user === null) return err(resetTokenInvalid());

  const passwordHash = await deps.hasher.hash(password.value);
  const updated = await deps.users.updatePassword({
    userId: user.id,
    passwordHash,
    expectedVersion: user.version,
    now,
  });

  if (!updated) {
    // The row moved between the read and the write — another reset landed
    // first. Reporting success would claim a password change that did not
    // happen.
    return err(resetTokenInvalid());
  }

  await deps.resets.invalidateAllForUser(user.id, now);
  const sessionsRevoked = await deps.sessions.revokeAllForUser(user.id, now);

  return ok({ userId: user.id, sessionsRevoked });
}

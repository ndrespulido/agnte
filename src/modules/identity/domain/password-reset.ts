import type { Clock } from '@/shared/kernel';

/**
 * A single-use password reset token (architecture.md §4).
 *
 * The domain sees the hash only. The token itself lives for one request, long
 * enough to put in an email.
 */
export interface PasswordResetToken {
  readonly tokenHash: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly invalidatedAt: Date | null;
}

/**
 * One hour (architecture.md §4) — a twenty-fourth of the verification token's
 * life, and deliberately so.
 *
 * A verification link proves an address nobody has claimed yet; the worst a
 * stale one does is create an account. A reset link replaces the password on an
 * account that exists, so it is the single most valuable string this system
 * emails anyone. An hour is long enough to find the message and short enough
 * that a mailbox compromised next week is not also an account compromised next
 * week.
 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export type PasswordResetTokenState = 'valid' | 'expired' | 'consumed' | 'invalidated';

/**
 * Order matters, and it is not the same order as expiry-first.
 *
 * `consumed` and `invalidated` both say something happened — the link was used,
 * or the password changed by another route — and either is more useful to the
 * person holding it than "expired", which by now it probably also is.
 */
export function passwordResetTokenState(
  token: PasswordResetToken,
  clock: Clock,
): PasswordResetTokenState {
  if (token.consumedAt !== null) return 'consumed';
  if (token.invalidatedAt !== null) return 'invalidated';
  if (token.expiresAt.getTime() <= clock.now().getTime()) return 'expired';
  return 'valid';
}

export function issuePasswordReset(input: {
  tokenHash: string;
  userId: string;
  clock: Clock;
}): PasswordResetToken {
  const now = input.clock.now();
  return {
    tokenHash: input.tokenHash,
    userId: input.userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
    consumedAt: null,
    invalidatedAt: null,
  };
}

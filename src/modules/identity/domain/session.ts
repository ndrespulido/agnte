import { uuidv7, type Clock } from '@/shared/kernel';

/**
 * A refresh token, as the domain sees it — hash only, never the token itself
 * (architecture.md §4).
 */
export interface RefreshToken {
  readonly tokenHash: string;
  readonly userId: string;
  readonly familyId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
}

/**
 * Fifteen minutes for the access token.
 *
 * A JWT cannot be withdrawn once signed — that is the price of not touching the
 * database on every request — so its lifetime *is* the revocation delay. Long
 * enough that a normal session refreshes rarely; short enough that "sign out
 * everywhere" means something within a quarter of an hour.
 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

/**
 * Thirty days for the refresh token.
 *
 * This is how long a phone can be left alone and still not ask for a password.
 * It is a long time for a bearer credential to be valid, which is exactly why
 * rotation and reuse detection below are not optional extras.
 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type RefreshTokenState = 'valid' | 'expired' | 'consumed' | 'revoked';

/**
 * Order matters. Revoked is checked first because a revoked token says
 * something happened — a sign-out, or a family killed by reuse detection — and
 * that is more informative than "expired", which it may also be by now.
 * Consumed is checked before expiry for the same reason: a consumed token
 * presented again is the reuse signal, and it must not be lost behind an
 * expiry that has since caught up with it.
 */
export function refreshTokenState(token: RefreshToken, clock: Clock): RefreshTokenState {
  if (token.revokedAt !== null) return 'revoked';
  if (token.consumedAt !== null) return 'consumed';
  if (token.expiresAt.getTime() <= clock.now().getTime()) return 'expired';
  return 'valid';
}

/**
 * The first token of a new sign-in. A fresh family id starts the lineage that
 * rotation extends and reuse detection revokes.
 */
export function startSession(input: {
  tokenHash: string;
  userId: string;
  clock: Clock;
}): RefreshToken {
  const now = input.clock.now();
  return {
    tokenHash: input.tokenHash,
    userId: input.userId,
    familyId: uuidv7(now.getTime()),
    createdAt: now,
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    consumedAt: null,
    revokedAt: null,
  };
}

/**
 * The replacement issued when a token is exchanged.
 *
 * The expiry is recomputed from now rather than inherited, so an actively used
 * session does not expire thirty days after it began. A session that goes quiet
 * for thirty days still does.
 */
export function rotateSession(
  previous: RefreshToken,
  tokenHash: string,
  clock: Clock,
): RefreshToken {
  const now = clock.now();
  return {
    tokenHash,
    userId: previous.userId,
    familyId: previous.familyId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    consumedAt: null,
    revokedAt: null,
  };
}

/** What a successful sign-in or refresh hands back. */
export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly tokenType: 'Bearer';
}

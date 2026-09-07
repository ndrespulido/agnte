import { err, ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import { refreshTokenInvalid, sessionRevoked } from '../domain/errors';
import { ACCESS_TOKEN_TTL_MS, rotateSession, type TokenPair } from '../domain/session';
import type {
  AccessTokenIssuer,
  RefreshTokenGenerator,
  RefreshTokenRepository,
} from '../domain/ports';

export interface RefreshDeps {
  sessions: RefreshTokenRepository;
  accessTokens: AccessTokenIssuer;
  refreshTokens: RefreshTokenGenerator;
  clock: Clock;
}

/**
 * Exchange a refresh token for a new pair, rotating it.
 *
 * Rotation means a stolen token is only useful until the real client next
 * refreshes. Reuse detection is what turns that from damage limitation into
 * detection: presenting an already-consumed token means someone is replaying,
 * and since there is no way to tell the thief from the victim, the whole
 * family goes and both sign in again.
 */
export async function refresh(
  presented: string,
  deps: RefreshDeps,
): Promise<Result<TokenPair, DomainError>> {
  const now = deps.clock.now();
  const tokenHash = deps.refreshTokens.hashOf(presented);
  const outcome = await deps.sessions.present(tokenHash, now);

  if (outcome.kind === 'reused') {
    await deps.sessions.revokeFamily(outcome.token.familyId, now);
    return err(sessionRevoked());
  }

  if (outcome.kind === 'revoked') return err(sessionRevoked());
  if (outcome.kind !== 'valid') return err(refreshTokenInvalid());

  const issued = deps.refreshTokens.issue();
  const replacement = rotateSession(outcome.token, issued.tokenHash, deps.clock);

  const rotated = await deps.sessions.rotate(tokenHash, replacement, now);
  if (!rotated) {
    // Another refresh with the same token won the race between `present` and
    // `rotate`. Not reuse — the client simply asked twice — but only one new
    // pair exists and this caller does not have it, so it retries.
    return err(refreshTokenInvalid());
  }

  return ok({
    accessToken: await deps.accessTokens.issue(outcome.token.userId),
    refreshToken: issued.token,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    tokenType: 'Bearer',
  });
}

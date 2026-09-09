import type { Clock } from '@/shared/kernel';
import { ACCESS_TOKEN_TTL_MS, startSession, type TokenPair } from '../domain/session';
import type {
  AccessTokenIssuer,
  RefreshTokenGenerator,
  RefreshTokenRepository,
} from '../domain/ports';

export interface SessionIssuingDeps {
  sessions: RefreshTokenRepository;
  accessTokens: AccessTokenIssuer;
  refreshTokens: RefreshTokenGenerator;
  clock: Clock;
}

/**
 * Start a session and hand back the pair (architecture.md §4).
 *
 * Extracted because three paths now end here — password sign-in, the Google
 * handoff exchange, and whatever a native client eventually uses — and every
 * one of them must produce the *same* kind of session. A path that differed,
 * even by forgetting to persist the refresh token, would be a sign-in that
 * cannot be revoked, which is the property the whole refresh table exists for.
 *
 * `refresh` is not a caller: it rotates an existing token rather than starting
 * a session, which is a different operation on the same table.
 */
export async function issueSession(
  userId: string,
  deps: SessionIssuingDeps,
): Promise<TokenPair> {
  const issued = deps.refreshTokens.issue();

  await deps.sessions.start(
    startSession({ tokenHash: issued.tokenHash, userId, clock: deps.clock }),
  );

  return {
    accessToken: await deps.accessTokens.issue(userId),
    refreshToken: issued.token,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    tokenType: 'Bearer',
  };
}

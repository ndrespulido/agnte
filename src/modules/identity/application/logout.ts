import { ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import type { RefreshTokenGenerator, RefreshTokenRepository } from '../domain/ports';

export interface LogoutDeps {
  sessions: RefreshTokenRepository;
  refreshTokens: RefreshTokenGenerator;
  clock: Clock;
}

export interface LogoutOutcome {
  /** How many live tokens were revoked. Zero is a success, not a failure. */
  readonly revoked: number;
}

/**
 * Sign out.
 *
 * Revokes the whole family, not just the presented token: the family *is* the
 * session, and rotation means the token in hand is only its current link.
 * Revoking one link would leave a session that the next refresh resurrects.
 *
 * Always succeeds. An unknown, expired or already-revoked token means the
 * caller is signed out, which is what they asked for — and reporting failure
 * would turn sign-out into a way to probe which tokens exist.
 */
export async function logout(
  presented: string,
  deps: LogoutDeps,
): Promise<Result<LogoutOutcome, DomainError>> {
  const now = deps.clock.now();
  const outcome = await deps.sessions.present(deps.refreshTokens.hashOf(presented), now);

  if (outcome.kind === 'valid' || outcome.kind === 'reused') {
    return ok({ revoked: await deps.sessions.revokeFamily(outcome.token.familyId, now) });
  }

  return ok({ revoked: 0 });
}

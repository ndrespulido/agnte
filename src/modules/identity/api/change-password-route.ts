import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { changePassword } from '../application/change-password';
import { IdentityErrorCode } from '../domain/errors';
import { Argon2PasswordHasher } from '../infrastructure/argon2-password-hasher';
import { PrismaPasswordResetTokenRepository } from '../infrastructure/prisma-password-reset-token-repository';
import { PrismaRefreshTokenRepository } from '../infrastructure/prisma-refresh-token-repository';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import { authenticate } from './authenticate';

const Body = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string(),
});

const noStore = { 'cache-control': 'no-store' };

/**
 * Change the password of someone already signed in.
 *
 * Rate-limited despite requiring a valid access token, because the current
 * password is a secret this endpoint checks — and anything that checks a
 * secret is something to guess at. A hijacked access token should not also
 * become an oracle for the password behind it.
 *
 * Answers 200 with `sessionsRevoked` rather than 204: the caller has just been
 * signed out everywhere, including here, and needs to be told that in the same
 * breath as being told the change worked.
 */
export async function handleChangePassword(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const raw: unknown = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError('bad_request', 'Send currentPassword and newPassword.'),
      400,
      rateLimitHeaders(decision),
    );
  }

  const result = await changePassword(
    {
      userId: auth.userId,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    },
    {
      users: new PrismaUserRepository(),
      resets: new PrismaPasswordResetTokenRepository(),
      sessions: new PrismaRefreshTokenRepository(),
      hasher: new Argon2PasswordHasher(),
      clock: systemClock,
    },
  );

  if (!result.ok) {
    /*
     * A wrong current password is 403, not 401.
     *
     * 401 means "your token is not good" and would send the client's
     * `authedFetch` off to refresh and retry — which cannot help, because the
     * token was never the problem, and which turns one wrong guess into two
     * requests.
     */
    const status = result.error.code === IdentityErrorCode.InvalidCredentials ? 403 : 422;
    return jsonError(result.error, status, rateLimitHeaders(decision));
  }

  return Response.json(
    { status: 'changed', sessionsRevoked: result.value.sessionsRevoked },
    { status: 200, headers: { ...noStore, ...rateLimitHeaders(decision) } },
  );
}

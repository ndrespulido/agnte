import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { loadConfig } from '@/shared/infra/config';
import { getEmailTransport } from '@/shared/infra/email';
import { consume } from '@/shared/infra/rate-limit';
import { forgotPassword } from '../application/forgot-password';
import { resetPassword } from '../application/reset-password';
import { IdentityErrorCode } from '../domain/errors';
import { Argon2PasswordHasher } from '../infrastructure/argon2-password-hasher';
import { CryptoTokenGenerator } from '../infrastructure/crypto-token-generator';
import { TransportIdentityMailer } from '../infrastructure/mailer';
import { PrismaPasswordResetTokenRepository } from '../infrastructure/prisma-password-reset-token-repository';
import { PrismaRefreshTokenRepository } from '../infrastructure/prisma-refresh-token-repository';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import { baseUrl, jsonError, rateLimitHeaders, tooManyRequests } from './http';

const ForgotBody = z.object({ email: z.string() });
const ResetBody = z.object({ token: z.string().min(1), password: z.string() });

const noStore = { 'cache-control': 'no-store' } as const;

/**
 * The one response a reset request ever gives. A constant, so it is visible at
 * a glance that no branch produces a different body.
 */
const ACCEPTED = {
  status: 'accepted',
  message: 'If that address has an account, a reset link is on its way.',
} as const;

export async function handleForgotPassword(request: Request): Promise<Response> {
  const config = loadConfig();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(new DomainError('bad_request', 'Body must be JSON.'), 400);
  }

  const parsed = ForgotBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError('bad_request', 'Body is not shaped correctly.'),
      400,
    );
  }

  // §8.6: 3 per hour per *email*, not per IP. The address is what is being
  // protected here — from being mailbombed with reset links by someone who
  // knows it — and an attacker moving between IPs should not get a fresh
  // allowance against the same victim.
  //
  // The residual, stated rather than silently accepted: one IP can still walk
  // a list of addresses at three each. That is volume, not targeting, and
  // volume is what the edge layer in §3.1 is in front for. If it ever needs
  // catching here, the fix is a second bucket keyed on IP, not a smaller
  // per-email number — which would only make it easier to lock a real user out
  // of their own reset.
  const decision = await consume('auth.forgot-password', {
    email: parsed.data.email.trim().toLowerCase(),
  });
  if (!decision.allowed) return tooManyRequests(decision);

  const transport = getEmailTransport();
  if (!transport) {
    return jsonError(
      new DomainError('email_unavailable', 'Password reset is temporarily unavailable.'),
      503,
      rateLimitHeaders(decision),
    );
  }

  const origin = baseUrl(request, config.APP_BASE_URL);

  const result = await forgotPassword(parsed.data.email, {
    users: new PrismaUserRepository(),
    resets: new PrismaPasswordResetTokenRepository(),
    tokens: new CryptoTokenGenerator(),
    mailer: new TransportIdentityMailer(transport),
    clock: systemClock,
    resetUrl: (token) => `${origin}/reset-password?token=${encodeURIComponent(token)}`,
    registerUrl: `${origin}/register`,
  });

  // A malformed address is the one thing worth reporting: it says nothing about
  // who has an account, and silently accepting a typo helps nobody.
  if (!result.ok) return jsonError(result.error, 422, rateLimitHeaders(decision));

  return Response.json(ACCEPTED, {
    status: 202,
    headers: { ...noStore, ...rateLimitHeaders(decision) },
  });
}

export async function handleResetPassword(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(new DomainError('bad_request', 'Body must be JSON.'), 400);
  }

  const parsed = ResetBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError('bad_request', 'Body is not shaped correctly.'),
      400,
    );
  }

  const result = await resetPassword(parsed.data.token, parsed.data.password, {
    users: new PrismaUserRepository(),
    resets: new PrismaPasswordResetTokenRepository(),
    sessions: new PrismaRefreshTokenRepository(),
    hasher: new Argon2PasswordHasher(),
    tokens: new CryptoTokenGenerator(),
    clock: systemClock,
  });

  if (!result.ok) {
    // 410 for a link that was real and is now spent or stale, 422 for a
    // password that breaks policy, 400 for a link that never existed. Safe to
    // distinguish: holding the token already proves you are the recipient.
    const status =
      result.error.code === IdentityErrorCode.ResetTokenExpired ||
      result.error.code === IdentityErrorCode.ResetTokenAlreadyUsed
        ? 410
        : result.error.code === IdentityErrorCode.ResetTokenInvalid
          ? 400
          : 422;

    return jsonError(result.error, status);
  }

  return Response.json(
    {
      status: 'reset',
      // Surfaced so a client can say "you have been signed out on 3 devices",
      // which is the reassurance someone resetting after a compromise wants.
      sessionsRevoked: result.value.sessionsRevoked,
    },
    { status: 200, headers: noStore },
  );
}

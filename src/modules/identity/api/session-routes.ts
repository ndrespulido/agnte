import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { loadConfig } from '@/shared/infra/config';
import { consume } from '@/shared/infra/rate-limit';
import { login } from '../application/login';
import { logout } from '../application/logout';
import { refresh } from '../application/refresh';
import { IdentityErrorCode } from '../domain/errors';
import { Argon2PasswordHasher } from '../infrastructure/argon2-password-hasher';
import { CryptoTokenGenerator } from '../infrastructure/crypto-token-generator';
import {
  JwtAccessTokenIssuer,
  accessTokenSecret,
} from '../infrastructure/jwt-access-token-issuer';
import { PrismaRefreshTokenRepository } from '../infrastructure/prisma-refresh-token-repository';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import { clientIp, jsonError, rateLimitHeaders, tooManyRequests } from './http';

const LoginBody = z.object({ email: z.string(), password: z.string() });
const RefreshBody = z.object({ refreshToken: z.string().min(1) });

const noStore = { 'cache-control': 'no-store' } as const;

/**
 * Resolves the signing key, or explains why there is none.
 *
 * A 503 rather than a boot failure, for the same reason email is: the code that
 * needs the secret has to be deployable before the secret exists, and the
 * status page is where that gap belongs.
 */
function issuer(): JwtAccessTokenIssuer | undefined {
  const config = loadConfig();
  const secret = accessTokenSecret(config.JWT_SECRET, config.APP_ENV === 'local');
  return secret ? new JwtAccessTokenIssuer(secret) : undefined;
}

const signingUnavailable = (): Response =>
  jsonError(
    new DomainError('signing_unavailable', 'Sign-in is temporarily unavailable.'),
    503,
  );

const readJson = async <T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> => {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonError(new DomainError('bad_request', 'Body must be JSON.'), 400),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError(
        new DomainError('bad_request', 'Body is not shaped correctly.', {
          details: {
            issues: parsed.error.issues.map((i) => i.path.join('.') || '(root)'),
          },
        }),
        400,
      ),
    };
  }

  return { ok: true, data: parsed.data };
};

export async function handleLogin(request: Request): Promise<Response> {
  const ip = clientIp(request);

  const body = await readJson(request, LoginBody);
  if (!body.ok) return body.response;

  // §8.6: 5 per 15 minutes per IP *and* email. Keying on both means one
  // attacker cannot lock a victim out of their own account by burning the
  // limit from elsewhere, and cannot spread an attack across addresses from
  // one address either.
  const decision = await consume('auth.login', {
    ip,
    email: body.data.email.trim().toLowerCase(),
  });
  if (!decision.allowed) return tooManyRequests(decision);

  const accessTokens = issuer();
  if (!accessTokens) return signingUnavailable();

  const result = await login(body.data, {
    users: new PrismaUserRepository(),
    sessions: new PrismaRefreshTokenRepository(),
    hasher: new Argon2PasswordHasher(),
    accessTokens,
    refreshTokens: new CryptoTokenGenerator(),
    clock: systemClock,
  });

  if (!result.ok) return jsonError(result.error, 401, rateLimitHeaders(decision));

  return Response.json(result.value, {
    status: 200,
    headers: { ...noStore, ...rateLimitHeaders(decision) },
  });
}

export async function handleRefresh(request: Request): Promise<Response> {
  const body = await readJson(request, RefreshBody);
  if (!body.ok) return body.response;

  const accessTokens = issuer();
  if (!accessTokens) return signingUnavailable();

  const result = await refresh(body.data.refreshToken, {
    sessions: new PrismaRefreshTokenRepository(),
    accessTokens,
    refreshTokens: new CryptoTokenGenerator(),
    clock: systemClock,
  });

  if (!result.ok) {
    // 401 either way — the client's job is the same, sign in again. The code
    // carries the distinction so a client can say *why* if it wants to.
    return jsonError(result.error, 401);
  }

  return Response.json(result.value, { status: 200, headers: noStore });
}

export async function handleLogout(request: Request): Promise<Response> {
  const body = await readJson(request, RefreshBody);
  if (!body.ok) return body.response;

  const result = await logout(body.data.refreshToken, {
    sessions: new PrismaRefreshTokenRepository(),
    refreshTokens: new CryptoTokenGenerator(),
    clock: systemClock,
  });

  // Always 204, whatever was presented. An unknown or already-dead token means
  // the caller is signed out, which is what they asked for — and answering
  // differently would make sign-out a way to probe which tokens exist.
  if (!result.ok) return jsonError(result.error, 400);

  return new Response(null, { status: 204, headers: noStore });
}

export const SESSION_ERROR_CODES = IdentityErrorCode;

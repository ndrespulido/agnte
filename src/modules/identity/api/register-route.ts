import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { loadConfig } from '@/shared/infra/config';
import { getEmailTransport } from '@/shared/infra/email';
import {
  claim,
  complete,
  fingerprint,
  release,
  scopeFor,
} from '@/shared/infra/idempotency';
import { consume } from '@/shared/infra/rate-limit';
import { register } from '../application/register';
import { Argon2PasswordHasher } from '../infrastructure/argon2-password-hasher';
import { CryptoTokenGenerator } from '../infrastructure/crypto-token-generator';
import { TransportIdentityMailer } from '../infrastructure/mailer';
import { PrismaPendingRegistrationRepository } from '../infrastructure/prisma-pending-registration-repository';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import { baseUrl, clientIp, jsonError, rateLimitHeaders, tooManyRequests } from './http';

const Body = z.object({
  email: z.string(),
  password: z.string(),
  displayName: z.string().trim().min(1).max(120).nullish(),
});

/**
 * The one response registration ever gives on success. Spelled out as a
 * constant so it is obvious there is no branch producing a different body —
 * that sameness is the anti-enumeration property (see the use case).
 */
const ACCEPTED = {
  status: 'accepted',
  message: 'If that address can be registered, a verification email is on its way.',
} as const;

export async function handleRegister(request: Request): Promise<Response> {
  const config = loadConfig();
  const ip = clientIp(request);

  // Rate limit first: §8.6 puts registration at 3/hour per IP, and the check
  // has to happen before the expensive parts (an Argon2 hash, an email) rather
  // than after them.
  const decision = await consume('auth.register', { ip });
  if (!decision.allowed) return tooManyRequests(decision);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonError(new DomainError('bad_request', 'Body must be JSON.'), 400);
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError('bad_request', 'Body is not shaped correctly.', {
        details: { issues: parsed.error.issues.map((i) => i.path.join('.') || '(root)') },
      }),
      400,
      rateLimitHeaders(decision),
    );
  }

  const transport = getEmailTransport();
  if (!transport) {
    // Better a clear 503 than accepting a registration whose verification email
    // will never be sent — that would leave someone waiting for a link that
    // does not exist, with no way to tell.
    return jsonError(
      new DomainError('email_unavailable', 'Registration is temporarily unavailable.'),
      503,
      rateLimitHeaders(decision),
    );
  }

  // Idempotency (§6): a mobile client whose network retried under it must not
  // send two verification emails. The key is scoped to the caller so one client
  // cannot replay or block another's request by guessing a key.
  const idempotencyKey = request.headers.get('idempotency-key');
  const scope = scopeFor(undefined, ip);
  const print = fingerprint('POST', '/v1/auth/register', parsed.data);

  if (idempotencyKey) {
    const outcome = await claim(scope, idempotencyKey, print, systemClock);
    if (outcome.kind === 'replay') {
      return Response.json(outcome.body, {
        status: outcome.status,
        headers: { 'cache-control': 'no-store', 'idempotent-replay': 'true' },
      });
    }
    if (outcome.kind === 'in-progress') {
      return jsonError(
        new DomainError('request_in_progress', 'That request is still being processed.'),
        409,
      );
    }
    if (outcome.kind === 'mismatch') {
      return jsonError(
        new DomainError(
          'idempotency_key_reused',
          'That Idempotency-Key was already used for a different request.',
        ),
        422,
      );
    }
  }

  try {
    const result = await register(parsed.data, {
      users: new PrismaUserRepository(),
      pending: new PrismaPendingRegistrationRepository(),
      hasher: new Argon2PasswordHasher(),
      tokens: new CryptoTokenGenerator(),
      mailer: new TransportIdentityMailer(transport),
      clock: systemClock,
      verificationUrl: (token) =>
        `${baseUrl(request, config.APP_BASE_URL)}/v1/auth/verify-email?token=${encodeURIComponent(token)}`,
      signInUrl: `${baseUrl(request, config.APP_BASE_URL)}/sign-in`,
    });

    if (!result.ok) {
      const status = 422;
      if (idempotencyKey) {
        // A validation failure is a real, reproducible answer to this exact
        // request, so it is stored and replayed like any other. Retrying it
        // unchanged should keep giving the same 422, not a fresh attempt.
        await complete(scope, idempotencyKey, status, {
          error: { code: result.error.code },
        });
      }
      return jsonError(result.error, status, rateLimitHeaders(decision));
    }

    if (idempotencyKey) await complete(scope, idempotencyKey, 202, ACCEPTED);

    return Response.json(ACCEPTED, {
      status: 202,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    });
  } catch (error) {
    // Release rather than leave the key claimed: the work did not happen, so a
    // retry should be allowed to do it rather than be told "in progress"
    // forever.
    if (idempotencyKey) await release(scope, idempotencyKey);

    // Name the dependency that broke.
    //
    // This was a bare 500, which is indistinguishable from any other crash —
    // and the reason (Resend's own message, e.g. a From address on a domain
    // this account cannot send from) existed only in the container logs.
    // Someone registering saw a blank failure and had no way to tell a
    // misconfiguration from a bug.
    //
    // 502, because the failure is upstream rather than in the request. The
    // provider's text is deliberately not echoed: it is written for us, not
    // for whoever is signing up, and it can name internal configuration.
    if (error instanceof Error && error.message.startsWith('Resend rejected')) {
      return jsonError(
        new DomainError(
          'email_send_failed',
          'We could not send the verification email. This is our problem, not yours — try again shortly.',
        ),
        502,
        rateLimitHeaders(decision),
      );
    }

    throw error;
  }
}

import { DomainError, systemClock } from '@/shared/kernel';
import { loadConfig } from '@/shared/infra/config';
import { consume } from '@/shared/infra/rate-limit';
import { issueSession } from '../application/issue-session';
import { signInWithGoogle } from '../application/sign-in-with-google';
import { issueOAuthHandoff } from '../domain/oauth-handoff';
import { IdentityErrorCode } from '../domain/errors';
import { CryptoTokenGenerator } from '../infrastructure/crypto-token-generator';
import { GoogleOAuthProvider } from '../infrastructure/google-oauth-provider';
import {
  JwtAccessTokenIssuer,
  accessTokenSecret,
} from '../infrastructure/jwt-access-token-issuer';
import { JwtOAuthStateSigner } from '../infrastructure/jwt-oauth-state-signer';
import { PrismaOAuthAccountRepository } from '../infrastructure/prisma-oauth-account-repository';
import { PrismaOAuthHandoffRepository } from '../infrastructure/prisma-oauth-handoff-repository';
import { PrismaRefreshTokenRepository } from '../infrastructure/prisma-refresh-token-repository';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import { baseUrl, clientIp, jsonError, tooManyRequests } from './http';

const noStore = { 'cache-control': 'no-store' } as const;

/**
 * Everything Google sign-in needs, or nothing.
 *
 * Returns undefined when Google is not configured, which is the normal state
 * for every preview environment — Google does not accept wildcard redirect
 * URIs, so a per-pull-request URL cannot be registered in advance.
 */
function googleContext(request: Request) {
  const config = loadConfig();
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) return undefined;

  const secret = accessTokenSecret(config.JWT_SECRET, config.APP_ENV === 'local');
  if (!secret) return undefined;

  return {
    provider: new GoogleOAuthProvider({
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
    }),
    state: new JwtOAuthStateSigner(secret),
    accessTokens: new JwtAccessTokenIssuer(secret, config.APP_ENV),
    // Must match byte for byte what was sent to the authorization endpoint and
    // what is registered with Google — the token exchange checks it.
    redirectUri: `${baseUrl(request, config.APP_BASE_URL)}/v1/auth/google/callback`,
  };
}

const notConfigured = (): Response =>
  jsonError(
    new DomainError(
      'google_not_configured',
      'Google sign-in is not available in this environment.',
    ),
    503,
  );

/** Starts the flow: mints state and redirects to Google. */
export async function handleGoogleStart(request: Request): Promise<Response> {
  const context = googleContext(request);
  if (!context) return notConfigured();

  const decision = await consume('auth.login', {
    ip: clientIp(request),
    email: 'google',
  });
  if (!decision.allowed) return tooManyRequests(decision);

  const state = await context.state.issue();

  return new Response(null, {
    status: 302,
    headers: {
      location: context.provider.authorizationUrl({
        redirectUri: context.redirectUri,
        state,
      }),
      ...noStore,
    },
  });
}

/**
 * Google's callback.
 *
 * Redirects to the app with a single-use handoff code in the fragment, and
 * the client trades that for a session at `/v1/auth/google/exchange`.
 *
 * This used to answer with the token pair as JSON, on the reasoning — still
 * correct — that a redirect carrying an access token puts a credential in
 * browser history, in the Referer of whatever loads next, and in any proxy
 * log on the way. What that reasoning missed is that Google redirects the
 * *browser* here, so the JSON was a page someone was looking at rather than a
 * value any client could pick up: the flow simply had no ending.
 *
 * A code is not a credential. It names a user, dies in two minutes, and works
 * exactly once (domain/oauth-handoff.ts), so the objection to a redirect does
 * not apply to it. The fragment is never sent to a server at all, which is
 * what keeps it out of the Referer and the proxy logs the old comment worried
 * about.
 */
export async function handleGoogleCallback(request: Request): Promise<Response> {
  const context = googleContext(request);
  if (!context) return notConfigured();

  const url = new URL(request.url);

  // Google reports a declined consent screen this way. Not an error worth
  // alarming anyone about — the person pressed cancel.
  const denied = url.searchParams.get('error');
  if (denied) {
    return jsonError(
      new DomainError('google_sign_in_cancelled', 'Google sign-in was not completed.', {
        details: { reason: denied },
      }),
      400,
    );
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return jsonError(new DomainError('bad_request', 'Missing code or state.'), 400);
  }

  const result = await signInWithGoogle(
    { code, state, redirectUri: context.redirectUri },
    {
      users: new PrismaUserRepository(),
      accounts: new PrismaOAuthAccountRepository(),
      provider: context.provider,
      state: context.state,
      clock: systemClock,
    },
  );

  if (!result.ok) {
    // 403 for an address Google will not vouch for — the request was
    // well-formed and is being refused. 400 for a stale or forged state, which
    // is a broken flow the client should restart. 502 for anything that went
    // wrong between here and Google, because it is not the caller's fault.
    const status =
      result.error.code === IdentityErrorCode.OAuthEmailUnverified
        ? 403
        : result.error.code === IdentityErrorCode.OAuthStateInvalid
          ? 400
          : 502;

    return jsonError(result.error, status);
  }

  const issued = new CryptoTokenGenerator().issue();
  await new PrismaOAuthHandoffRepository().issue(
    issueOAuthHandoff({
      codeHash: issued.tokenHash,
      userId: result.value.userId,
      created: result.value.created,
      clock: systemClock,
    }),
  );

  // 303, so the browser follows with GET however it arrived, and a relative
  // location so this can never become an open redirect — the target is this
  // app's own root, and the code rides in the fragment.
  return new Response(null, {
    status: 303,
    headers: { location: `/#code=${issued.token}`, ...noStore },
  });
}

/**
 * Trades a handoff code for a session.
 *
 * The one place a Google sign-in becomes a token pair. It answers the same
 * shape `/v1/auth/login` does, because a client should not care which of the
 * two got it here.
 *
 * Every failure is one error: unknown code, expired code, already-spent code.
 * They are indistinguishable on purpose — nobody reads this response but a
 * script that just followed a redirect, so there is no message to improve,
 * and separating them would only help someone guessing.
 */
export async function handleGoogleExchange(request: Request): Promise<Response> {
  const decision = await consume('auth.login', {
    ip: clientIp(request),
    email: 'google-exchange',
  });
  if (!decision.allowed) return tooManyRequests(decision);

  const body: unknown = await request.json().catch(() => null);
  const code =
    typeof body === 'object' && body !== null && 'code' in body
      ? (body as { code: unknown }).code
      : null;

  if (typeof code !== 'string' || code.length === 0) {
    return jsonError(new DomainError('bad_request', 'Missing code.'), 400);
  }

  const config = loadConfig();
  const secret = accessTokenSecret(config.JWT_SECRET, config.APP_ENV === 'local');
  if (!secret) return notConfigured();

  const generator = new CryptoTokenGenerator();
  const handoff = await new PrismaOAuthHandoffRepository().consume(
    generator.hashOf(code),
    systemClock.now(),
  );

  if (!handoff) {
    return jsonError(
      new DomainError(
        'oauth_handoff_invalid',
        'That sign-in link has already been used or has expired. Try signing in again.',
      ),
      400,
    );
  }

  const tokens = await issueSession(handoff.userId, {
    sessions: new PrismaRefreshTokenRepository(),
    accessTokens: new JwtAccessTokenIssuer(secret, config.APP_ENV),
    refreshTokens: generator,
    clock: systemClock,
  });

  return Response.json(
    { ...tokens, created: handoff.created },
    { status: 200, headers: noStore },
  );
}

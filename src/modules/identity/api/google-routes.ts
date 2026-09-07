import { DomainError, systemClock } from '@/shared/kernel';
import { loadConfig } from '@/shared/infra/config';
import { consume } from '@/shared/infra/rate-limit';
import { signInWithGoogle } from '../application/sign-in-with-google';
import { IdentityErrorCode } from '../domain/errors';
import { CryptoTokenGenerator } from '../infrastructure/crypto-token-generator';
import { GoogleOAuthProvider } from '../infrastructure/google-oauth-provider';
import {
  JwtAccessTokenIssuer,
  accessTokenSecret,
} from '../infrastructure/jwt-access-token-issuer';
import { JwtOAuthStateSigner } from '../infrastructure/jwt-oauth-state-signer';
import { PrismaOAuthAccountRepository } from '../infrastructure/prisma-oauth-account-repository';
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
    accessTokens: new JwtAccessTokenIssuer(secret),
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
 * Returns JSON rather than redirecting with tokens in the URL. A redirect
 * carrying an access token puts a credential in browser history, in the
 * Referer header of whatever the page loads next, and in any proxy log along
 * the way. The web client will exchange this for its own storage; the native
 * client (§4) needs the JSON anyway.
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
      sessions: new PrismaRefreshTokenRepository(),
      provider: context.provider,
      state: context.state,
      accessTokens: context.accessTokens,
      refreshTokens: new CryptoTokenGenerator(),
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

  return Response.json(
    { ...result.value.tokens, created: result.value.created },
    { status: 200, headers: noStore },
  );
}

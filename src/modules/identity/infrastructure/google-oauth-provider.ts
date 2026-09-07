import { createRemoteJWKSet, jwtVerify } from 'jose';
import { parseEmail } from '../domain/email';
import { oauthExchangeFailed, oauthEmailUnverified } from '../domain/errors';
import type { OAuthProvider, ProviderIdentity } from '../domain/ports';

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Cached across requests deliberately.
 *
 * createRemoteJWKSet keeps Google's signing keys in memory and refetches when
 * it sees an unknown `kid`. Building a new one per request would fetch the key
 * set on every sign-in — slower, and a good way to get rate-limited by Google
 * for no benefit.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

const getJwks = (uri: string) => {
  jwks ??= createRemoteJWKSet(new URL(uri));
  return jwks;
};

/** Test seam: forget the cached key set so a test can point at its own server. */
export function resetGoogleJwksForTests(): void {
  jwks = undefined;
}

export interface GoogleOAuthOptions {
  clientId: string;
  clientSecret: string;
  /** Overridable so tests can point at a local stand-in for Google. */
  tokenEndpoint?: string;
  jwksUri?: string;
  authorizationEndpoint?: string;
}

export class GoogleOAuthProvider implements OAuthProvider {
  constructor(private readonly options: GoogleOAuthOptions) {}

  authorizationUrl(input: { redirectUri: string; state: string }): string {
    const url = new URL(this.options.authorizationEndpoint ?? AUTHORIZATION_ENDPOINT);

    url.searchParams.set('client_id', this.options.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    // Only what is needed to identify the person. Asking for more would show up
    // on Google's consent screen and would have to be justified there.
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', input.state);
    // No refresh token wanted: this is sign-in, not ongoing access to a
    // person's Google data. Nothing here ever calls a Google API again, so a
    // refresh token would be a long-lived credential stored for no purpose.
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');

    return url.toString();
  }

  /**
   * Exchange the code, then verify the ID token properly.
   *
   * The ID token arrives over a direct TLS connection to Google, which is why
   * some implementations skip verifying it. Verifying anyway costs one cached
   * key lookup and removes a whole class of mistake — a misconfigured token
   * endpoint, a proxy, a future refactor that gets the token from somewhere
   * less trustworthy.
   */
  async exchange(input: {
    code: string;
    redirectUri: string;
  }): Promise<ProviderIdentity> {
    const response = await fetch(this.options.tokenEndpoint ?? TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw oauthExchangeFailed(
        `token endpoint returned ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      id_token?: unknown;
    } | null;
    const idToken = body?.id_token;
    if (typeof idToken !== 'string') {
      throw oauthExchangeFailed('token response carried no id_token');
    }

    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, getJwks(this.options.jwksUri ?? JWKS_URI), {
        issuer: ISSUERS,
        // Pinned to *our* client id. Without this, an ID token Google issued
        // for some other application would verify here — it is signed by the
        // same keys — and anyone with such a token could sign in as its subject.
        audience: this.options.clientId,
      }));
    } catch (error) {
      throw oauthExchangeFailed(
        `id_token did not verify: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }

    const subject = payload.sub;
    if (typeof subject !== 'string' || subject.length === 0) {
      throw oauthExchangeFailed('id_token carried no subject');
    }

    // Google sends this as a boolean, but has historically sent the string
    // "true" as well. Accepting only a real boolean would reject valid
    // sign-ins; accepting anything truthy would accept the string "false".
    const emailVerified =
      payload.email_verified === true || payload.email_verified === 'true';

    const email = parseEmail(typeof payload.email === 'string' ? payload.email : '');
    if (!email.ok) throw oauthExchangeFailed('id_token carried no usable email');

    if (!emailVerified) throw oauthEmailUnverified();

    return {
      provider: 'google',
      subject,
      email: email.value,
      emailVerified,
      displayName:
        typeof payload.name === 'string' && payload.name.length > 0 ? payload.name : null,
    };
  }
}

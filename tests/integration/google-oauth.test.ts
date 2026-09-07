import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import {
  GoogleOAuthProvider,
  resetGoogleJwksForTests,
} from '@/modules/identity/infrastructure/google-oauth-provider';
import { JwtOAuthStateSigner } from '@/modules/identity/infrastructure/jwt-oauth-state-signer';
import { IdentityErrorCode } from '@/modules/identity/domain/errors';
import { DomainError } from '@/shared/kernel';

/**
 * A stand-in for Google: a real HTTP server with a real JWKS and real RS256
 * signatures.
 *
 * Mocking `fetch` would prove the adapter calls something; this proves it
 * verifies a signature it did not produce, against a key set it fetched, and
 * rejects tokens that fail for each of the reasons that matter. Those are the
 * checks standing between a stranger's ID token and someone's account, and
 * they are exactly what a mock cannot vouch for.
 */

const CLIENT_ID = 'agnte-test-client.apps.googleusercontent.com';
const ISSUER = 'https://accounts.google.com';

let server: Server;
let origin: string;
let privateKey: CryptoKey;
let publicJwk: JWK;
/** What the token endpoint should return next. */
let tokenResponse: { status: number; body: unknown };

const kid = 'test-key-1';

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: 'RS256', use: 'sig' };

  server = createServer((req, res) => {
    if (req.url?.startsWith('/certs')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    if (req.url?.startsWith('/token')) {
      res.writeHead(tokenResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tokenResponse.body));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

const provider = () =>
  new GoogleOAuthProvider({
    clientId: CLIENT_ID,
    clientSecret: 'a-secret',
    tokenEndpoint: `${origin}/token`,
    jwksUri: `${origin}/certs`,
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  });

interface Claims {
  sub?: string;
  email?: string;
  email_verified?: unknown;
  name?: string;
  aud?: string;
  iss?: string;
  expiresIn?: string;
}

const idToken = async (claims: Claims = {}) => {
  const { aud = CLIENT_ID, iss = ISSUER, expiresIn = '5m', ...rest } = claims;
  return new SignJWT({
    email: 'person@example.com',
    email_verified: true,
    name: 'A Person',
    ...rest,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject(rest.sub ?? 'google-subject-1')
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
};

const exchangeWith = async (claims: Claims = {}) => {
  // Fresh each time: the adapter caches the key set across calls, and a test
  // that changed keys mid-run would otherwise fail for the wrong reason.
  resetGoogleJwksForTests();
  tokenResponse = { status: 200, body: { id_token: await idToken(claims) } };
  return provider().exchange({ code: 'the-code', redirectUri: 'https://agnte.test/cb' });
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError
      ? error.code
      : `not-a-DomainError:${String(error)}`;
  }
  throw new Error('expected the exchange to fail');
};

describe('GoogleOAuthProvider.authorizationUrl', () => {
  it('asks for only what it needs, and no refresh token', async () => {
    const url = new URL(
      provider().authorizationUrl({ redirectUri: 'https://agnte.test/cb', state: 'abc' }),
    );

    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe('https://agnte.test/cb');
    // Nothing here ever calls a Google API again, so a refresh token would be a
    // long-lived credential stored for no purpose.
    expect(url.searchParams.get('access_type')).toBe('online');
  });
});

describe('GoogleOAuthProvider.exchange', () => {
  it('accepts a properly signed token and reads the identity out', async () => {
    const identity = await exchangeWith();

    expect(identity).toMatchObject({
      provider: 'google',
      subject: 'google-subject-1',
      email: 'person@example.com',
      emailVerified: true,
      displayName: 'A Person',
    });
  });

  it('normalises the address Google supplied', async () => {
    const identity = await exchangeWith({ email: 'Person@Example.COM' });
    expect(identity.email).toBe('person@example.com');
  });

  it('accepts email_verified as the string Google has historically sent', async () => {
    // Accepting only a real boolean would reject valid sign-ins; accepting
    // anything truthy would accept the string "false".
    const identity = await exchangeWith({ email_verified: 'true' });
    expect(identity.emailVerified).toBe(true);
  });

  it('rejects the string "false" rather than treating it as truthy', async () => {
    expect(await codeOf(exchangeWith({ email_verified: 'false' }))).toBe(
      IdentityErrorCode.OAuthEmailUnverified,
    );
  });

  it('refuses an unverified address', async () => {
    expect(await codeOf(exchangeWith({ email_verified: false }))).toBe(
      IdentityErrorCode.OAuthEmailUnverified,
    );
  });

  it('refuses a token minted for a different client', async () => {
    // The check that matters most here. An ID token Google issued for some
    // other application is signed by the same keys and would otherwise verify,
    // letting anyone holding one sign in as its subject.
    expect(
      await codeOf(
        exchangeWith({ aud: 'someone-elses-client.apps.googleusercontent.com' }),
      ),
    ).toBe(IdentityErrorCode.OAuthExchangeFailed);
  });

  it('refuses a token from the wrong issuer', async () => {
    expect(await codeOf(exchangeWith({ iss: 'https://accounts.evil.example' }))).toBe(
      IdentityErrorCode.OAuthExchangeFailed,
    );
  });

  it('refuses an expired token', async () => {
    expect(await codeOf(exchangeWith({ expiresIn: '-1s' }))).toBe(
      IdentityErrorCode.OAuthExchangeFailed,
    );
  });

  it('refuses a token signed by a key Google does not publish', async () => {
    resetGoogleJwksForTests();
    const impostor = await generateKeyPair('RS256', { extractable: true });
    const forged = await new SignJWT({
      email: 'person@example.com',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject('google-subject-1')
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(impostor.privateKey);

    tokenResponse = { status: 200, body: { id_token: forged } };

    expect(
      await codeOf(
        provider().exchange({ code: 'c', redirectUri: 'https://agnte.test/cb' }),
      ),
    ).toBe(IdentityErrorCode.OAuthExchangeFailed);
  });

  it('refuses a token carrying no email', async () => {
    expect(await codeOf(exchangeWith({ email: '' }))).toBe(
      IdentityErrorCode.OAuthExchangeFailed,
    );
  });

  it('reports a token endpoint that refuses the code', async () => {
    resetGoogleJwksForTests();
    tokenResponse = { status: 400, body: { error: 'invalid_grant' } };

    expect(
      await codeOf(
        provider().exchange({ code: 'used', redirectUri: 'https://agnte.test/cb' }),
      ),
    ).toBe(IdentityErrorCode.OAuthExchangeFailed);
  });

  it('reports a token response with no id_token', async () => {
    resetGoogleJwksForTests();
    tokenResponse = { status: 200, body: { access_token: 'only-this' } };

    expect(
      await codeOf(
        provider().exchange({ code: 'c', redirectUri: 'https://agnte.test/cb' }),
      ),
    ).toBe(IdentityErrorCode.OAuthExchangeFailed);
  });
});

describe('JwtOAuthStateSigner', () => {
  const signer = new JwtOAuthStateSigner('a'.repeat(32));

  it('accepts a state it issued', async () => {
    expect(await signer.verify(await signer.issue())).toBe(true);
  });

  it('refuses a state signed with a different key', async () => {
    const other = new JwtOAuthStateSigner('b'.repeat(32));
    expect(await signer.verify(await other.issue())).toBe(false);
  });

  it('refuses rubbish', async () => {
    for (const bad of ['', 'not.a.jwt', 'a.b.c']) {
      expect(await signer.verify(bad)).toBe(false);
    }
  });

  it('cannot be swapped with an access token, despite sharing a key', async () => {
    // They are signed with the same secret, so only the audience and `typ`
    // claims keep them apart. If either check were dropped, an access token
    // would pass as OAuth state and — worse — a state token would authenticate
    // a request as whatever subject it carried.
    const { JwtAccessTokenIssuer } =
      await import('@/modules/identity/infrastructure/jwt-access-token-issuer');
    const secret = 'a'.repeat(32);
    const access = new JwtAccessTokenIssuer(secret);
    const state = new JwtOAuthStateSigner(secret);

    expect(await state.verify(await access.issue('some-user-id'))).toBe(false);
    expect(await access.verify(await state.issue())).toBeNull();
  });

  it('issues a different state each time', async () => {
    // Two sign-ins started in the same second must not share a state, or one
    // could be replayed for the other.
    const states = new Set(
      await Promise.all([signer.issue(), signer.issue(), signer.issue()]),
    );
    expect(states.size).toBe(3);
  });
});

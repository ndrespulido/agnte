import { SignJWT, jwtVerify } from 'jose';
import { uuidv7 } from '@/shared/kernel';
import type { OAuthStateSigner } from '../domain/ports';

/**
 * Five minutes.
 *
 * The state exists for one redirect out to Google and back — seconds, plus
 * however long the consent screen takes. Anything longer widens the window in
 * which a captured authorization URL can be replayed at a victim.
 */
const STATE_TTL_SECONDS = 5 * 60;

const ISSUER = 'agnte';
const AUDIENCE = 'agnte-oauth-state';
const TOKEN_TYPE = 'oauth-state';
const ALGORITHM = 'HS256';

/**
 * Signed, not stored.
 *
 * The value has to survive a redirect to Google and back with nothing kept in
 * between, which a signature gives for free — no table, no cookie, no cleanup.
 * The trade is that it cannot be revoked before it expires, which is why it
 * expires in five minutes.
 *
 * Uses the same key as access tokens, but is fenced off from them by audience
 * and `typ`: a state token presented as an access token fails both checks, and
 * an access token presented as state fails both too.
 */
export class JwtOAuthStateSigner implements OAuthStateSigner {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(): Promise<string> {
    return (
      new SignJWT({ typ: TOKEN_TYPE })
        .setProtectedHeader({ alg: ALGORITHM })
        // A nonce, so two sign-ins started in the same second do not produce the
        // same state — which would let one be replayed for the other.
        .setJti(uuidv7())
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${STATE_TTL_SECONDS}s`)
        .sign(this.key)
    );
  }

  async verify(state: string): Promise<boolean> {
    try {
      const { payload } = await jwtVerify(state, this.key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      return payload.typ === TOKEN_TYPE;
    } catch {
      return false;
    }
  }
}

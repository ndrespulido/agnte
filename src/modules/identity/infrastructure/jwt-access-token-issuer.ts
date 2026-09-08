import { randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { uuidv7 } from '@/shared/kernel';
import { ACCESS_TOKEN_TTL_MS } from '../domain/session';
import type { AccessTokenIssuer } from '../domain/ports';

/**
 * HS256 rather than an asymmetric algorithm.
 *
 * One deployable signs and verifies, so there is no second party that needs a
 * public key and must not have the private one. When the monolith splits and
 * another service verifies tokens it did not issue, that is the moment to move
 * to EdDSA — swapping the algorithm here and publishing a JWKS, not a redesign.
 */
const ALGORITHM = 'HS256';

const ISSUER = 'agnte';

/**
 * The audience is scoped to the environment.
 *
 * Preview and production were mounting the same signing secret, so a token
 * minted on any preview verified against production — and preview databases
 * are branched from production, so signing in on a preview was enough to get a
 * production token. Separating the secrets is the primary fix; this is the
 * belt to that pair of braces, and it is the half that holds even if a secret
 * is ever shared again by accident.
 *
 * Production keeps the bare `agnte-api`, so tokens already in the wild stay
 * valid. Only the environments whose tokens should never have been portable
 * change.
 */
export const audienceFor = (appEnv: string): string =>
  appEnv === 'production' ? 'agnte-api' : `agnte-api-${appEnv}`;

/**
 * Marks what the token is for.
 *
 * Cheap insurance against a class of bug where a token minted for one purpose
 * is accepted for another — a password-reset token presented as an access
 * token, say. Everything this project signs will carry a `typ`, and every
 * verifier will check it.
 */
const TOKEN_TYPE = 'access';

export class JwtAccessTokenIssuer implements AccessTokenIssuer {
  private readonly key: Uint8Array;
  private readonly audience: string;

  /**
   * `appEnv` is required rather than defaulted. A default would be the
   * production audience, and the one environment that must not accidentally
   * mint production-valid tokens is the one a developer is most likely to
   * construct this in without thinking.
   */
  constructor(secret: string, appEnv: string) {
    this.key = new TextEncoder().encode(secret);
    this.audience = audienceFor(appEnv);
  }

  async issue(userId: string): Promise<string> {
    const now = Date.now();

    return (
      new SignJWT({ typ: TOKEN_TYPE })
        .setProtectedHeader({ alg: ALGORITHM })
        .setSubject(userId)
        .setIssuer(ISSUER)
        .setAudience(this.audience)
        .setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(Math.floor((now + ACCESS_TOKEN_TTL_MS) / 1000))
        // A unique id per token, so a future deny-list can name one without
        // revoking every token a user holds.
        .setJti(uuidv7(now))
        .sign(this.key)
    );
  }

  /**
   * Returns the subject, or null for anything that does not verify.
   *
   * Null rather than a thrown error, and one null for every reason: expired,
   * wrong signature, wrong issuer, wrong type. A caller that could distinguish
   * them would be tempted to report the difference, and "signature invalid"
   * versus "expired" is a hint worth withholding from someone probing.
   */
  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        // Pinned. Without this, jose accepts whatever the token's own header
        // claims — the "alg: none" and HMAC-vs-RSA confusion families of bug.
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: this.audience,
      });

      if (payload.typ !== TOKEN_TYPE) return null;
      return typeof payload.sub === 'string' ? payload.sub : null;
    } catch {
      return null;
    }
  }
}

let developmentSecret: string | undefined;

/**
 * The signing secret, or a throwaway one in local development.
 *
 * `npm run dev` has to work with no configuration (architecture.md §7.1), and a
 * signing key is not something a developer should have to obtain. Generated per
 * process rather than checked in: a fixed development secret in a public
 * repository is exactly the value that eventually gets used in production by
 * accident. The cost is that tokens stop working across a restart, which in
 * development is a re-login.
 *
 * Deployed environments get nothing back when the secret is missing — the
 * caller turns that into a 503 rather than signing tokens with a value that
 * vanishes on the next cold start.
 */
export function accessTokenSecret(
  configured: string | undefined,
  isLocal: boolean,
): string | undefined {
  if (configured) return configured;
  if (!isLocal) return undefined;

  developmentSecret ??= randomBytes(32).toString('hex');
  return developmentSecret;
}

/** Test seam: forget the generated development secret. */
export function resetDevelopmentSecretForTests(): void {
  developmentSecret = undefined;
}

import { DomainError } from '@/shared/kernel';
import { loadConfig } from '@/shared/infra/config';
import {
  JwtAccessTokenIssuer,
  accessTokenSecret,
} from '../infrastructure/jwt-access-token-issuer';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import type { User } from '../domain/user';
import { jsonError } from './http';

/**
 * The route guard: turns an Authorization header into a user, or into the
 * response to send back.
 *
 * A discriminated union rather than a throw-or-return-null: a caller has to
 * handle the failure branch to reach the user, and the response it should send
 * comes with it, so no two protected routes can disagree about what a bad token
 * looks like.
 */
export type Authenticated =
  { ok: true; user: User; userId: string } | { ok: false; response: Response };

const unauthorized = (message: string): Response => {
  const error = new DomainError('unauthenticated', message);
  return jsonError(error, 401, {
    // RFC 6750 §3. A client that gets this back knows to refresh rather than to
    // send the user to a login form.
    'www-authenticate': 'Bearer realm="agnte", error="invalid_token"',
  });
};

/**
 * Reads a Bearer token, verifies it, and loads the user.
 *
 * The database read is deliberate, rather than trusting the token's subject.
 * A JWT survives its user being deleted — that is the whole trade of not
 * checking on every request — and a deleted account (GDPR erasure, §8.7) must
 * stop working immediately, not in fifteen minutes.
 */
export async function authenticate(request: Request): Promise<Authenticated> {
  const header = request.headers.get('authorization');

  if (!header) return { ok: false, response: unauthorized('Authentication required.') };

  // RFC 7235: the scheme is case-insensitive and is followed by one or more
  // spaces (`1*SP`) — not a tab, and not nothing. `\S+` then requires a
  // non-empty token with no whitespace in it, which is what stops "Bearer  "
  // from being read as an empty credential.
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  if (!match?.[1]) {
    return {
      ok: false,
      response: unauthorized('Authorization header must be "Bearer <token>".'),
    };
  }

  const config = loadConfig();
  const secret = accessTokenSecret(config.JWT_SECRET, config.APP_ENV === 'local');
  if (!secret) {
    return {
      ok: false,
      response: jsonError(
        new DomainError(
          'signing_unavailable',
          'Authentication is temporarily unavailable.',
        ),
        503,
      ),
    };
  }

  const userId = await new JwtAccessTokenIssuer(secret).verify(match[1]);
  if (!userId) return { ok: false, response: unauthorized('That token is not valid.') };

  const user = await new PrismaUserRepository().findById(userId);
  if (!user) {
    // Signed correctly, but the account is gone. Same 401 as a bad token: the
    // holder's next step is identical, and saying "that account no longer
    // exists" would confirm an id to anyone holding an old token.
    return { ok: false, response: unauthorized('That token is not valid.') };
  }

  return { ok: true, user, userId };
}

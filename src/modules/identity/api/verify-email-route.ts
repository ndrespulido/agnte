import { DomainError, systemClock } from '@/shared/kernel';
import { loadConfig } from '@/shared/infra/config';
import { baseUrl } from '@/shared/infra/http';
import { IdentityErrorCode } from '../domain/errors';
import { verifyEmail } from '../application/verify-email';
import { CryptoTokenGenerator } from '../infrastructure/crypto-token-generator';
import { PrismaPendingRegistrationRepository } from '../infrastructure/prisma-pending-registration-repository';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import { jsonError } from './http';

/**
 * Whether the caller is a browser following a link, or a program calling the API.
 *
 * Tested on an explicit `text/html` rather than on the absence of
 * `application/json`, because `curl` and most HTTP clients send a wildcard
 * Accept header — treating that as "a browser" would redirect every scripted
 * caller and break the versioned contract this route is part of. Only
 * something that actually asked for a page gets one.
 */
function wantsPage(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/** 303, not 302: the GET had a side effect, and what follows is a different resource. */
const seeOther = (location: string): Response =>
  new Response(null, {
    status: 303,
    headers: { location, 'cache-control': 'no-store' },
  });

/**
 * GET, not POST.
 *
 * The link is clicked from a mail client, which can only issue a GET — so this
 * is a GET that changes state, which usually deserves an argument. The argument
 * is that the alternative (a landing page that POSTs) either needs JavaScript
 * or an extra click, and the thing that makes GET-with-side-effects dangerous
 * — prefetchers and crawlers firing it — is bounded here: redeeming the token
 * is exactly what the recipient wants, and it happens at most once.
 */
export async function handleVerifyEmail(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get('token');
  const origin = baseUrl(request, loadConfig().APP_BASE_URL);

  if (!token) {
    if (wantsPage(request)) return seeOther(`${origin}/?verifyError=invalid`);
    return jsonError(new DomainError('bad_request', 'Missing token.'), 400);
  }

  const result = await verifyEmail(token, {
    users: new PrismaUserRepository(),
    pending: new PrismaPendingRegistrationRepository(),
    tokens: new CryptoTokenGenerator(),
    clock: systemClock,
  });

  if (!result.ok) {
    // 410 for a link that was real and is now spent or stale, 400 for one that
    // never existed. The distinction is safe here — holding the token already
    // proves you are the recipient — and it is the difference between "request
    // a new link" and "check you copied the whole URL".
    const expired = result.error.code === IdentityErrorCode.VerificationTokenExpired;

    // The same distinction the status codes make, carried into the page: one
    // asks for a fresh link, the other asks whether the whole URL was copied.
    if (wantsPage(request)) {
      return seeOther(`${origin}/?verifyError=${expired ? 'expired' : 'invalid'}`);
    }

    return jsonError(result.error, expired ? 410 : 400);
  }

  /*
   * A browser gets the app, not the JSON.
   *
   * This link is clicked from a mail client, so what arrived here is a person,
   * and what they saw until now was a raw API body — technically a correct
   * response to a request they never knowingly made. The JSON stays for the
   * planned native client, which will call this the same way and does want a
   * body back.
   */
  if (wantsPage(request)) return seeOther(`${origin}/?verified=1`);

  return Response.json(
    {
      status: 'verified',
      user: {
        id: result.value.user.id,
        email: result.value.user.email,
        displayName: result.value.user.displayName,
      },
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

import { DomainError, systemClock } from '@/shared/kernel';
import { IdentityErrorCode } from '../domain/errors';
import { verifyEmail } from '../application/verify-email';
import { CryptoVerificationTokenGenerator } from '../infrastructure/crypto-token-generator';
import { PrismaPendingRegistrationRepository } from '../infrastructure/prisma-pending-registration-repository';
import { PrismaUserRepository } from '../infrastructure/prisma-user-repository';
import { jsonError } from './http';

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

  if (!token) {
    return jsonError(new DomainError('bad_request', 'Missing token.'), 400);
  }

  const result = await verifyEmail(token, {
    users: new PrismaUserRepository(),
    pending: new PrismaPendingRegistrationRepository(),
    tokens: new CryptoVerificationTokenGenerator(),
    clock: systemClock,
  });

  if (!result.ok) {
    // 410 for a link that was real and is now spent or stale, 400 for one that
    // never existed. The distinction is safe here — holding the token already
    // proves you are the recipient — and it is the difference between "request
    // a new link" and "check you copied the whole URL".
    const status =
      result.error.code === IdentityErrorCode.VerificationTokenExpired ? 410 : 400;
    return jsonError(result.error, status);
  }

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

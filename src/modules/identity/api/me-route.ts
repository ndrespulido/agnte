import { consume } from '@/shared/infra/rate-limit';
import { authenticate } from './authenticate';
import { rateLimitHeaders, tooManyRequests } from './http';

/**
 * The signed-in user.
 *
 * Deliberately narrow: id, email, display name, timestamps. Not the password
 * hash, not the version, not the row. A response shape that starts as "the user
 * record" grows into one by default, and the first field nobody meant to
 * publish arrives without a decision being made.
 */
export async function handleMe(request: Request): Promise<Response> {
  const authenticated = await authenticate(request);
  if (!authenticated.ok) return authenticated.response;

  // §8.6's general authenticated limit: 1000/hour per user. Applied after
  // authentication so the bucket is the user, not the address they came from —
  // a shared network should not have its members competing against each other.
  const decision = await consume('authenticated', { user: authenticated.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const { user } = authenticated;

  return Response.json(
    {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

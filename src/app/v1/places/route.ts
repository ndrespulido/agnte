import { DomainError } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import {
  MIN_QUERY_LENGTH,
  PlacesNotConfigured,
  suggestPlaces,
} from '@/shared/infra/places';

export const dynamic = 'force-dynamic';

/**
 * Place suggestions for the location field.
 *
 * Proxied through this app rather than called from the browser, for three
 * reasons that all point the same way: the API key stays server-side where it
 * cannot be lifted and spent, the Content-Security-Policy keeps `connect-src
 * 'self'` with no third-party origin added to it, and what someone types into
 * a field on an app that holds medical notes does not travel to Google
 * carrying their IP.
 *
 * Authenticated and rate-limited like every other `/v1/*` endpoint — which
 * here is a budget control as much as an access one, since this is the single
 * metered dependency in the system (see shared/infra/places.ts).
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const query = new URL(request.url).searchParams.get('q') ?? '';

  // Answered here rather than by the adapter so a short query never becomes a
  // billed request, even if a future caller forgets to check.
  if (query.trim().length < MIN_QUERY_LENGTH) {
    return Response.json(
      { suggestions: [] },
      {
        status: 200,
        headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
      },
    );
  }

  try {
    const suggestions = await suggestPlaces(query);
    return Response.json(
      { suggestions },
      {
        status: 200,
        headers: {
          // Someone's typed location is theirs; a shared cache has no business
          // holding it, however briefly.
          'cache-control': 'no-store',
          ...rateLimitHeaders(decision),
        },
      },
    );
  } catch (cause) {
    if (cause instanceof PlacesNotConfigured) {
      // Not an error the caller can fix, and not a failure of their request:
      // the field simply stays plain text, which is its normal state locally
      // and in every preview.
      return jsonError(
        new DomainError('places.not_configured', 'Place suggestions are not enabled.'),
        501,
        rateLimitHeaders(decision),
      );
    }

    return jsonError(
      new DomainError('places.unavailable', 'Could not reach the places service.'),
      502,
      rateLimitHeaders(decision),
    );
  }
}

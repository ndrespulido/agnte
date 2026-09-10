import { DomainError } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { browseDeepTime } from '../application/browse-deep-time';
import { DEFAULT_CATALOGUE_LIMIT, MAX_CATALOGUE_LIMIT } from '../domain/deep-time-event';
import { PrismaDeepTimeRepository } from '../infrastructure/prisma-deep-time-repository';

/**
 * The shared catalogue, walked backwards.
 *
 * Authenticated even though the content is identical for everyone and secret
 * from nobody. Two reasons, and neither is about the catalogue: an open
 * endpoint is an open endpoint to rate-limit by IP rather than by user, and
 * this is only ever called by a signed-in client continuing a scroll it has
 * already been reading. Requiring the token costs that client nothing and
 * keeps one rule about who may call `/v1/*`.
 *
 * `before` defaults to 0 — the year 2000 on the shared axis — rather than to
 * now, because the whole catalogue is prehistory and the difference between
 * those two is far below the precision of the nearest entry either way.
 */
export async function handleDeepTime(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const params = new URL(request.url).searchParams;

  const beforeRaw = params.get('before');
  const before = beforeRaw === null ? 0 : Number(beforeRaw);
  if (!Number.isFinite(before)) {
    return jsonError(
      new DomainError('invalid_query', 'before must be a number of years.'),
      400,
      rateLimitHeaders(decision),
    );
  }

  const limitRaw = params.get('limit');
  const limit = limitRaw === null ? DEFAULT_CATALOGUE_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CATALOGUE_LIMIT) {
    return jsonError(
      new DomainError(
        'invalid_query',
        `limit must be between 1 and ${MAX_CATALOGUE_LIMIT}.`,
      ),
      400,
      rateLimitHeaders(decision),
    );
  }

  const page = await browseDeepTime(
    { before, limit, cursor: params.get('cursor') },
    { events: new PrismaDeepTimeRepository() },
  );

  return Response.json(
    {
      events: page.events.map((event) => ({
        id: event.id,
        slug: event.slug,
        timelineYears: event.timelineYears,
        title: event.title,
        detail: event.detail,
        category: event.category,
      })),
      nextCursor: page.nextCursor,
    },
    {
      status: 200,
      headers: {
        /*
         * The one genuinely cacheable response in this application.
         *
         * It is the same bytes for every user and changes only when a
         * migration adds an entry, so it is worth saying so — every other
         * route here is `no-store` because it is somebody's private data.
         * Public rather than private for the same reason: there is nothing
         * user-specific in it to leak into a shared cache.
         */
        'cache-control': 'public, max-age=3600',
        ...rateLimitHeaders(decision),
      },
    },
  );
}

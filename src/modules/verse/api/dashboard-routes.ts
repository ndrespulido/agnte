import { systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { MediaModuleAdapter } from '../infrastructure/media-adapter';
import { PrismaShareRepository } from '../infrastructure/prisma-share-repository';
import { PrismaTagRepository } from '../infrastructure/prisma-tag-repository';
import { PrismaVerseRepository } from '../infrastructure/prisma-verse-repository';
import { tagDashboard } from '../application/dashboard';
import { VerseErrorCode } from '../domain/errors';
import { VERTICALS, format } from '../domain/tag';

/**
 * A tag's dashboard.
 *
 * Every tag is "a filterable sub-timeline with its own dashboard" (CLAUDE.md);
 * this is the second half of that sentence. Nested under the tag rather than
 * given its own top-level resource because it is a view *of* the tag and has no
 * identity apart from it.
 *
 * Read-only, so no idempotency key: there is nothing here a retry could
 * duplicate.
 */
export async function handleTagDashboard(
  request: Request,
  tagId: string,
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const verses = new PrismaVerseRepository();

  const result = await tagDashboard(
    {
      ownerId: auth.userId,
      viewerId: auth.userId,
      tagId,
      now: systemClock.now(),
    },
    {
      verses,
      tags: new PrismaTagRepository(),
      shares: new PrismaShareRepository(),
      media: new MediaModuleAdapter(),
    },
  );

  if (!result.ok) {
    // 404 for a tag that is not yours, which is what `forbidden()` means here —
    // see the use case for why the two are not distinguished.
    const status = result.error.code === VerseErrorCode.Forbidden ? 404 : 400;
    return jsonError(result.error, status, rateLimitHeaders(decision));
  }

  const { tag, summary, truncated } = result.value;

  return Response.json(
    {
      tag: {
        id: tag.id,
        name: tag.name,
        label: format(tag),
        visibility: tag.visibility,
        vertical: tag.vertical,
        suggestedProperties: tag.vertical ? [...VERTICALS[tag.vertical]] : [],
      },
      summary: {
        ...summary,
        // Dates cross the wire as ISO strings like everywhere else in this API;
        // null stays null rather than becoming an empty string, because "no
        // dated verse in this tag" is a fact the client renders differently
        // from a date.
        firstEvent: summary.firstEvent?.toISOString() ?? null,
        lastEvent: summary.lastEvent?.toISOString() ?? null,
      },
      truncated,
    },
    {
      status: 200,
      headers: {
        // A dashboard is a view of someone's own private data; a shared cache
        // has no business holding it, which is the same rule /v1/places follows.
        'cache-control': 'no-store',
        ...rateLimitHeaders(decision),
      },
    },
  );
}

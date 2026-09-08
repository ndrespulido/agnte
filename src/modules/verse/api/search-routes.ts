import { DomainError } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { PrismaVerseRepository } from '../infrastructure/prisma-verse-repository';
import { PrismaShareRepository } from '../infrastructure/prisma-share-repository';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  searchVerses,
} from '../application/search';
import { verseBody } from './verse-body';

/**
 * Search.
 *
 * Everything is a query parameter, including the filters, so a result page is a
 * URL the user can bookmark or share with themselves — which is the habit this
 * whole app came out of.
 */
export async function handleSearch(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const params = new URL(request.url).searchParams;
  const bad = (message: string) =>
    jsonError(new DomainError('invalid_query', message), 400, rateLimitHeaders(decision));

  const text = params.get('q');
  if (text === null) return bad('Pass ?q= with something to search for.');

  const limitRaw = params.get('limit');
  const limit = limitRaw === null ? DEFAULT_SEARCH_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    return bad(`limit must be between 1 and ${MAX_SEARCH_LIMIT}.`);
  }

  const date = (name: string): Date | null | 'invalid' => {
    const raw = params.get(name);
    if (raw === null) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? 'invalid' : parsed;
  };

  const from = date('from');
  const to = date('to');
  if (from === 'invalid' || to === 'invalid') {
    return bad('from and to must be ISO 8601 dates.');
  }

  const ratingRaw = params.get('ratingAtLeast');
  const ratingAtLeast = ratingRaw === null ? null : Number(ratingRaw);
  if (ratingAtLeast !== null && !Number.isFinite(ratingAtLeast)) {
    return bad('ratingAtLeast must be a number.');
  }

  // Absent means "do not filter"; present means filter to that answer. A plain
  // `=== 'true'` would turn ?hasMedia=false into "no filter", which is the
  // opposite of what it says.
  const hasMediaRaw = params.get('hasMedia');
  const hasMedia = hasMediaRaw === null ? null : hasMediaRaw === 'true';

  const tagIds = params.getAll('tag');

  const result = await searchVerses(
    {
      ownerId: auth.userId,
      viewerId: auth.userId,
      text,
      limit,
      cursor: params.get('cursor'),
      ...(tagIds.length > 0 ? { tagIds } : {}),
      matchAllTags: params.get('match') === 'all',
      ratingAtLeast,
      from,
      to,
      hasMedia,
    },
    { verses: new PrismaVerseRepository(), shares: new PrismaShareRepository() },
  );

  if (!result.ok) {
    return jsonError(result.error, 422, rateLimitHeaders(decision));
  }

  return Response.json(
    {
      verses: result.value.items.map((hit) => ({
        ...verseBody(hit),
        rank: hit.rank,
      })),
      nextCursor: result.value.nextCursor,
    },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

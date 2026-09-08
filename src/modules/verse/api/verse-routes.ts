import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { idempotently } from './idempotent';
import { PrismaTagRepository } from '../infrastructure/prisma-tag-repository';
import { PrismaVerseRepository } from '../infrastructure/prisma-verse-repository';
import { PrismaShareRepository } from '../infrastructure/prisma-share-repository';
import {
  createVerseFor,
  deleteVerseFor,
  updateVerseFor,
} from '../application/write-verse';
import { visible } from '../application/read-verse';
import { VerseErrorCode } from '../domain/errors';
import type { VisibleVerse } from '../domain/ports';
import { format } from '../domain/tag';

/**
 * The response shape.
 *
 * `visibility` is the *resolved* answer, not the stored column: a client
 * showing a badge needs to know what the verse actually is, and the stored null
 * meaning "inherit" would show as nothing. `explicitVisibility` carries the
 * stored value separately, so an editor can tell "inherited private" from
 * "deliberately private" — they look identical otherwise and mean different
 * things when a tag changes.
 */
const verseBody = (v: VisibleVerse) => ({
  id: v.verse.id,
  eventStart: v.verse.eventStart?.toISOString() ?? null,
  eventEnd: v.verse.eventEnd?.toISOString() ?? null,
  deepTimeYears: v.verse.deepTimeYears,
  location: v.verse.location,
  rating: v.verse.rating,
  xp: v.verse.xp,
  properties: v.verse.properties,
  visibility: v.effectiveVisibility,
  explicitVisibility: v.verse.visibility,
  tags: v.tags.map((t) => ({ id: t.id, name: t.name, label: format(t) })),
  mediaIds: v.verse.mediaIds,
  createdAt: v.verse.createdAt.toISOString(),
  updatedAt: v.verse.updatedAt.toISOString(),
  version: v.verse.version,
});

const Fields = {
  eventStart: z.string().nullish(),
  eventEnd: z.string().nullish(),
  deepTimeYears: z.number().nullish(),
  location: z.string().nullish(),
  rating: z.number().nullish(),
  xp: z.string().nullish(),
  properties: z.record(z.string(), z.unknown()).optional(),
  visibility: z.string().nullish(),
  mediaIds: z.array(z.uuid()).optional(),
};

const CreateBody = z.object({
  ...Fields,
  /** At least one tag: a Verse without one has nothing to inherit from. */
  tagIds: z.array(z.uuid()).min(1),
  id: z.uuid().optional(),
});

const UpdateBody = z.object({
  ...Fields,
  tagIds: z.array(z.uuid()).optional(),
  expectedVersion: z.number().int().min(0),
});

const statusFor = (code: string): number => {
  switch (code) {
    // Both are "you cannot have this", and both answer 404 rather than 403 so
    // an id's existence is not confirmed to someone who cannot see it.
    case VerseErrorCode.Forbidden:
    case VerseErrorCode.VerseNotFound:
    case VerseErrorCode.TagNotFound:
      return 404;
    case VerseErrorCode.VersionConflict:
      return 409;
    default:
      return 422;
  }
};

const deps = () => ({
  verses: new PrismaVerseRepository(),
  tags: new PrismaTagRepository(),
  shares: new PrismaShareRepository(),
  clock: systemClock,
});

export async function handleCreateVerse(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const raw: unknown = await request.json().catch(() => null);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError('invalid_body', 'Send a JSON object with at least one tag id.'),
      400,
      rateLimitHeaders(decision),
    );
  }

  return idempotently(
    request,
    { userId: auth.userId, path: '/v1/verses', body: parsed.data },
    async () => {
      const result = await createVerseFor(
        { ownerId: auth.userId, ...parsed.data },
        deps(),
      );

      if (!result.ok) {
        return {
          status: statusFor(result.error.code),
          body: { error: result.error.toJSON() },
          headers: rateLimitHeaders(decision),
        };
      }

      // Read back through the visibility path rather than shaping the response
      // from what was just written: the resolved visibility is what the client
      // needs, and computing it a second way here is exactly the duplication
      // this module forbids.
      const seen = await visible(result.value.id, auth.userId, deps());
      if (!seen.ok) {
        return {
          status: 500,
          body: { error: { code: 'verse.unreadable_after_write' } },
        };
      }

      return {
        status: 201,
        body: verseBody(seen.value),
        headers: rateLimitHeaders(decision),
      };
    },
  );
}

export async function handleGetVerse(
  request: Request,
  verseId: string,
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const result = await visible(verseId, auth.userId, deps());
  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(decision),
    );
  }

  return Response.json(verseBody(result.value), {
    status: 200,
    headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
  });
}

export async function handleUpdateVerse(
  request: Request,
  verseId: string,
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const raw: unknown = await request.json().catch(() => null);
  const parsed = UpdateBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError(
        'invalid_body',
        'Send a JSON object including the expectedVersion you read.',
      ),
      400,
      rateLimitHeaders(decision),
    );
  }

  const result = await updateVerseFor(
    { ownerId: auth.userId, verseId, ...parsed.data },
    deps(),
  );

  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(decision),
    );
  }

  const seen = await visible(verseId, auth.userId, deps());
  if (!seen.ok) return jsonError(seen.error, 404, rateLimitHeaders(decision));

  return Response.json(verseBody(seen.value), {
    status: 200,
    headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
  });
}

export async function handleDeleteVerse(
  request: Request,
  verseId: string,
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  // Read as a string first: Number(null) is 0, and 0 is a valid version, so
  // converting first would turn a missing parameter into "I read version 0".
  const raw = new URL(request.url).searchParams.get('expectedVersion');
  const version = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(version) || version < 0) {
    return jsonError(
      new DomainError(
        'invalid_body',
        'Pass ?expectedVersion= with the version you read.',
      ),
      400,
      rateLimitHeaders(decision),
    );
  }

  const result = await deleteVerseFor(
    { ownerId: auth.userId, verseId, expectedVersion: version },
    { verses: new PrismaVerseRepository() },
  );

  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(decision),
    );
  }

  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
  });
}

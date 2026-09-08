import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { PrismaTagRepository } from '../infrastructure/prisma-tag-repository';
import { PrismaVerseRepository } from '../infrastructure/prisma-verse-repository';
import { PrismaShareRepository } from '../infrastructure/prisma-share-repository';
import {
  listTagShares,
  revokeTagShare,
  revokeVerseShare,
  shareTagWith,
  shareVerseWith,
} from '../application/share';
import { VerseErrorCode } from '../domain/errors';

const ShareBody = z.object({
  /**
   * A user id, not an email address. Sharing by address needs an invitation
   * flow that answers identically for known and unknown addresses — otherwise
   * the endpoint is a user-enumeration oracle. See application/share.ts.
   */
  granteeId: z.uuid(),
  permission: z.string().default('read'),
});

const statusFor = (code: string): number => {
  switch (code) {
    case VerseErrorCode.TagNotFound:
    case VerseErrorCode.Forbidden:
    case VerseErrorCode.VerseNotFound:
      return 404;
    case VerseErrorCode.ShareNotPermitted:
      // 501, not 400: the request is well-formed and will be valid one day.
      // A 400 would read as "you got this wrong" rather than "not yet built".
      return 501;
    default:
      return 422;
  }
};

const deps = () => ({
  shares: new PrismaShareRepository(),
  tags: new PrismaTagRepository(),
  verses: new PrismaVerseRepository(),
  clock: systemClock,
});

async function guard(request: Request) {
  const auth = await authenticate(request);
  if (!auth.ok) return { ok: false as const, response: auth.response };

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed)
    return { ok: false as const, response: tooManyRequests(decision) };

  return { ok: true as const, userId: auth.userId, decision };
}

export async function handleListTagShares(
  request: Request,
  tagId: string,
): Promise<Response> {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const result = await listTagShares({ ownerId: g.userId, tagId }, deps());
  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(g.decision),
    );
  }

  return Response.json(
    {
      shares: result.value.map((s) => ({
        granteeId: s.granteeId,
        permission: s.permission,
        createdAt: s.createdAt.toISOString(),
      })),
    },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(g.decision) },
    },
  );
}

export async function handleShareTag(request: Request, tagId: string): Promise<Response> {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const parsed = ShareBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      new DomainError('invalid_body', 'Send a JSON object with a granteeId.'),
      400,
      rateLimitHeaders(g.decision),
    );
  }

  const result = await shareTagWith({ ownerId: g.userId, tagId, ...parsed.data }, deps());

  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(g.decision),
    );
  }

  return Response.json(
    {
      granteeId: result.value.granteeId,
      permission: result.value.permission,
      createdAt: result.value.createdAt.toISOString(),
    },
    {
      status: 201,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(g.decision) },
    },
  );
}

export async function handleRevokeTagShare(
  request: Request,
  tagId: string,
): Promise<Response> {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const granteeId = new URL(request.url).searchParams.get('granteeId');
  if (granteeId === null || granteeId.trim() === '') {
    return jsonError(
      new DomainError('invalid_query', 'Pass ?granteeId= with the person to revoke.'),
      400,
      rateLimitHeaders(g.decision),
    );
  }

  const result = await revokeTagShare({ ownerId: g.userId, tagId, granteeId }, deps());
  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(g.decision),
    );
  }

  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store', ...rateLimitHeaders(g.decision) },
  });
}

export async function handleShareVerse(
  request: Request,
  verseId: string,
): Promise<Response> {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const parsed = ShareBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      new DomainError('invalid_body', 'Send a JSON object with a granteeId.'),
      400,
      rateLimitHeaders(g.decision),
    );
  }

  const result = await shareVerseWith(
    { ownerId: g.userId, verseId, ...parsed.data },
    deps(),
  );

  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(g.decision),
    );
  }

  return Response.json(
    {
      granteeId: result.value.granteeId,
      permission: result.value.permission,
      createdAt: result.value.createdAt.toISOString(),
    },
    {
      status: 201,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(g.decision) },
    },
  );
}

export async function handleRevokeVerseShare(
  request: Request,
  verseId: string,
): Promise<Response> {
  const g = await guard(request);
  if (!g.ok) return g.response;

  const granteeId = new URL(request.url).searchParams.get('granteeId');
  if (granteeId === null || granteeId.trim() === '') {
    return jsonError(
      new DomainError('invalid_query', 'Pass ?granteeId= with the person to revoke.'),
      400,
      rateLimitHeaders(g.decision),
    );
  }

  const result = await revokeVerseShare(
    { ownerId: g.userId, verseId, granteeId },
    deps(),
  );
  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(g.decision),
    );
  }

  return new Response(null, {
    status: 204,
    headers: { 'cache-control': 'no-store', ...rateLimitHeaders(g.decision) },
  });
}

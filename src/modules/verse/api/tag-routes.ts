import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { idempotently } from '@/shared/infra/idempotent-write';
import { authenticate } from '@/modules/identity';
import { PrismaTagRepository } from '../infrastructure/prisma-tag-repository';
import { PrismaVerseRepository } from '../infrastructure/prisma-verse-repository';
import { createTagFor } from '../application/create-tag';
import { deleteTag, listTags, updateTag } from '../application/manage-tags';
import { VerseErrorCode } from '../domain/errors';
import { VERTICALS, format, type Tag } from '../domain/tag';

/**
 * Tag endpoints.
 *
 * `vertical` and `suggestedProperties` travel together in the response so a
 * client building the quick-add form does not need its own copy of the vertical
 * table — the one in the domain stays the only one.
 */
const tagBody = (tag: Tag) => ({
  id: tag.id,
  name: tag.name,
  /** How it is written and typed: `.barcelona-trip`. */
  label: format(tag),
  displayName: tag.displayName,
  visibility: tag.visibility,
  shortcut: tag.shortcut,
  vertical: tag.vertical,
  suggestedProperties: tag.vertical ? [...VERTICALS[tag.vertical]] : [],
  createdAt: tag.createdAt.toISOString(),
  updatedAt: tag.updatedAt.toISOString(),
  version: tag.version,
});

const CreateBody = z.object({
  name: z.string(),
  displayName: z.string().trim().min(1).max(120).nullish(),
  visibility: z.string().optional(),
  // `.nullish()` rather than `.optional()`: explicit null means "no shortcut,
  // do not pick one for me", which is a different instruction from silence.
  shortcut: z.string().nullish(),
  vertical: z.string().nullish(),
});

const UpdateBody = z.object({
  name: z.string().optional(),
  displayName: z.string().trim().min(1).max(120).nullish(),
  visibility: z.string().optional(),
  shortcut: z.string().nullish(),
  /**
   * Required, not optional. Optimistic concurrency only protects a client that
   * sends the version it read; letting it be omitted would make the protection
   * opt-in, and the writes that most need it are exactly the ones written in a
   * hurry (architecture.md §2).
   */
  expectedVersion: z.number().int().min(0),
});

const statusFor = (code: string): number => {
  switch (code) {
    case VerseErrorCode.TagNotFound:
      return 404;
    case VerseErrorCode.TagAlreadyExists:
    case VerseErrorCode.TagShortcutTaken:
    case VerseErrorCode.VersionConflict:
      return 409;
    case VerseErrorCode.NoTags:
      // Refusing to orphan a verse. 409 rather than 400: the request is
      // well-formed, it conflicts with the current state.
      return 409;
    default:
      return 422;
  }
};

export async function handleListTags(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const tags = await listTags(auth.userId, { tags: new PrismaTagRepository() });

  return Response.json(
    { tags: tags.map(tagBody) },
    {
      status: 200,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

export async function handleCreateTag(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const raw: unknown = await request.json().catch(() => null);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError('invalid_body', 'Send a JSON object with a tag name.'),
      400,
      rateLimitHeaders(decision),
    );
  }

  return idempotently(
    request,
    { userId: auth.userId, path: '/v1/tags', body: parsed.data },
    async () => {
      const result = await createTagFor(
        { ownerId: auth.userId, ...parsed.data },
        { tags: new PrismaTagRepository(), clock: systemClock },
      );

      if (!result.ok) {
        return {
          status: statusFor(result.error.code),
          body: { error: result.error.toJSON() },
          headers: rateLimitHeaders(decision),
        };
      }

      return {
        status: 201,
        body: tagBody(result.value),
        headers: rateLimitHeaders(decision),
      };
    },
  );
}

export async function handleUpdateTag(
  request: Request,
  tagId: string,
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

  const result = await updateTag(
    { ownerId: auth.userId, tagId, ...parsed.data },
    {
      tags: new PrismaTagRepository(),
      search: new PrismaVerseRepository(),
      clock: systemClock,
    },
  );

  if (!result.ok) {
    return jsonError(
      result.error,
      statusFor(result.error.code),
      rateLimitHeaders(decision),
    );
  }

  return Response.json(tagBody(result.value), {
    status: 200,
    headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
  });
}

export async function handleDeleteTag(
  request: Request,
  tagId: string,
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  // Read as a string first, and reject a missing one before converting.
  // `Number(null)` is 0, and 0 is a perfectly valid version — so converting
  // first would turn "I forgot to send it" into "I read version 0", which
  // silently succeeds against any freshly created tag. Optimistic concurrency
  // you can forget to opt into is not concurrency control.
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

  const result = await deleteTag(
    { ownerId: auth.userId, tagId, expectedVersion: version },
    { tags: new PrismaTagRepository(), verses: new PrismaVerseRepository() },
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

import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { idempotently } from '@/shared/infra/idempotent-write';
import { authenticate } from '@/modules/identity';
import { confirmUpload } from '../application/confirm-upload';
import { deleteMedia } from '../application/delete-media';
import { requestUpload } from '../application/request-upload';
import { MediaErrorCode, storageUnavailable } from '../domain/errors';
import { getMediaBlobStore } from '../infrastructure/blob-store';
import { PrismaMediaRepository } from '../infrastructure/prisma-media-repository';
import { getThumbnailQueue } from '../infrastructure/thumbnail-queue';
import { mediaBody } from './media-body';

/**
 * `/v1/media`: request an upload target, confirm the upload, or delete a
 * Media item. Reading media happens through verse (a Verse's attached media
 * resolved with signed URLs once visibility is decided) rather than through
 * a route here — see media/index.ts's doc comment.
 */

const RequestUploadBody = z.object({
  contentType: z.string(),
  declaredSizeBytes: z.number(),
  id: z.uuid().optional(),
});

const ConfirmBody = z.object({
  expectedVersion: z.number().int().min(0),
});

const statusFor = (code: string): number => {
  switch (code) {
    case MediaErrorCode.NotFound:
      return 404;
    case MediaErrorCode.NotPending:
    case MediaErrorCode.NotReady:
    case MediaErrorCode.VersionConflict:
      return 409;
    case MediaErrorCode.StorageUnavailable:
      return 503;
    // ContentTypeNotAllowed, TooLarge, UploadMismatch: the request is
    // well-formed JSON, it just asks for a Media that cannot exist as
    // described — the same 422 verse uses for its own "no tags" case.
    default:
      return 422;
  }
};

export async function handleRequestUpload(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const raw: unknown = await request.json().catch(() => null);
  const parsed = RequestUploadBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError(
        'invalid_body',
        'Send { "contentType": "...", "declaredSizeBytes": <number> }.',
      ),
      400,
      rateLimitHeaders(decision),
    );
  }

  const blobStore = getMediaBlobStore();
  if (!blobStore) {
    return jsonError(storageUnavailable(), 503, rateLimitHeaders(decision));
  }

  return idempotently(
    request,
    { userId: auth.userId, path: '/v1/media', body: parsed.data },
    async () => {
      const result = await requestUpload(
        { ownerId: auth.userId, ...parsed.data },
        { media: new PrismaMediaRepository(), blobStore, clock: systemClock },
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
        body: { media: mediaBody(result.value.media), upload: result.value.upload },
        headers: rateLimitHeaders(decision),
      };
    },
  );
}

/**
 * Wrapped in `idempotently()` for the same reason verse's writes are: a
 * confirm whose response is lost in transit moves the row out of `pending`
 * regardless, so a naive retry would answer `media.not_pending` for a
 * request that actually succeeded the first time.
 */
export async function handleConfirmUpload(
  request: Request,
  mediaId: string,
): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const raw: unknown = await request.json().catch(() => null);
  const parsed = ConfirmBody.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError('invalid_body', 'Send { "expectedVersion": <version you read> }.'),
      400,
      rateLimitHeaders(decision),
    );
  }

  const blobStore = getMediaBlobStore();
  if (!blobStore) {
    return jsonError(storageUnavailable(), 503, rateLimitHeaders(decision));
  }

  return idempotently(
    request,
    { userId: auth.userId, path: `/v1/media/${mediaId}/confirm`, body: parsed.data },
    async () => {
      const result = await confirmUpload(
        { ownerId: auth.userId, mediaId, expectedVersion: parsed.data.expectedVersion },
        {
          media: new PrismaMediaRepository(),
          blobStore,
          queue: getThumbnailQueue(),
          clock: systemClock,
        },
      );

      if (!result.ok) {
        return {
          status: statusFor(result.error.code),
          body: { error: result.error.toJSON() },
          headers: rateLimitHeaders(decision),
        };
      }

      return {
        status: 200,
        body: mediaBody(result.value),
        headers: rateLimitHeaders(decision),
      };
    },
  );
}

export async function handleDeleteMedia(
  request: Request,
  mediaId: string,
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

  const blobStore = getMediaBlobStore();
  if (!blobStore) {
    return jsonError(storageUnavailable(), 503, rateLimitHeaders(decision));
  }

  const result = await deleteMedia(
    { ownerId: auth.userId, mediaId, expectedVersion: version },
    { media: new PrismaMediaRepository(), blobStore },
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

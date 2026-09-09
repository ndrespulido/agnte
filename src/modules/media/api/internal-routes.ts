import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { jsonError } from '@/shared/infra/http';
import { verifyInternalRequest } from '@/shared/infra/internal-auth';
import { processThumbnailJob } from '../application/process-thumbnail';
import { storageUnavailable } from '../domain/errors';
import { getMediaBlobStore } from '../infrastructure/blob-store';
import { PrismaMediaRepository } from '../infrastructure/prisma-media-repository';
import { SharpThumbnailGenerator } from '../infrastructure/sharp-thumbnail-generator';

/**
 * The Cloud Tasks callback for thumbnail generation (architecture.md §1.3,
 * §8.3). Guarded by `verifyInternalRequest` — the shared-secret bearer token,
 * not user authentication — because the caller is this deployment's own task
 * queue, not a browser.
 */

const Body = z.object({ mediaId: z.uuid() });

export async function handleThumbnailJob(request: Request): Promise<Response> {
  const auth = verifyInternalRequest(request);
  if (!auth.ok) return auth.response;

  const raw: unknown = await request.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return jsonError(
      new DomainError('invalid_body', 'Send { "mediaId": "<uuid>" }.'),
      400,
    );
  }

  const blobStore = getMediaBlobStore();
  if (!blobStore) return jsonError(storageUnavailable(), 503);

  // Errors that mean "this specific image cannot be thumbnailed" are already
  // handled inside processThumbnailJob by writing `failed` to the row; only
  // an infrastructure failure (the database unreachable) reaches here, and
  // for that, a 500 is exactly right — it is the case Cloud Tasks' retry
  // exists for.
  await processThumbnailJob(parsed.data.mediaId, {
    media: new PrismaMediaRepository(),
    blobStore,
    generator: new SharpThumbnailGenerator(),
    clock: systemClock,
  });

  return new Response(null, { status: 204 });
}

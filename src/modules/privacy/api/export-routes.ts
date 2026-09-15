import { z } from 'zod';
import { DomainError, systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { verifyInternalRequest } from '@/shared/infra/internal-auth';
import { authenticate } from '@/modules/identity';
import { buildExport, latestExport, requestExport } from '../application/export';

/**
 * `POST /v1/privacy/export` — ask for a copy of everything (§8.5).
 *
 * 202 and a row, not a file: the work happens in a Cloud Task because an export
 * that had to finish inside this request would have its size capped by a
 * request deadline.
 */
export async function handleRequestExport(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  const result = await requestExport(auth.userId, systemClock.now());

  if (!result.ok) {
    // 429 rather than 422: it is a rate limit, just a per-day one expressed in
    // the request table rather than in the shared limiter.
    return jsonError(result.error, 429, rateLimitHeaders(decision));
  }

  return Response.json(
    {
      id: result.value.id,
      status: 'pending',
      /*
       * Said out loud rather than hidden behind a cheerful 202.
       *
       * Without deferred work configured the row exists and nothing will ever
       * pick it up — which is precisely the silent failure that cost this
       * project a day of blank thumbnails. Someone waiting for an email that
       * is not coming deserves to be told now.
       */
      queued: result.value.queued,
      ...(result.value.queued
        ? {}
        : {
            warning:
              'Deferred work is not configured in this environment, so this export will not be built.',
          }),
    },
    {
      status: 202,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

/** `GET /v1/privacy/export` — how the last request is getting on. */
export async function handleExportStatus(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const latest = await latestExport(auth.userId);

  return Response.json(
    latest
      ? {
          id: latest.id,
          status: latest.status,
          requestedAt: latest.requestedAt.toISOString(),
          completedAt: latest.completedAt?.toISOString() ?? null,
          error: latest.error,
        }
      : null,
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

const JobBody = z.object({ exportId: z.uuid() });

/**
 * The Cloud Task callback that actually assembles the export.
 *
 * Guarded by the shared internal secret like every other `/internal/*` route:
 * Cloud Run runs this service `--allow-unauthenticated`, so IAM cannot gate a
 * subset of paths.
 */
export async function handleBuildExport(request: Request): Promise<Response> {
  const auth = verifyInternalRequest(request);
  if (!auth.ok) return auth.response;

  const parsed = JobBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(new DomainError('bad_request', 'Missing exportId.'), 400);
  }

  const built = await buildExport(parsed.data.exportId, systemClock.now());

  // 200 either way: `false` means the row was already ready or gone, which is
  // a duplicate delivery rather than a failure, and answering non-2xx would
  // make Cloud Tasks retry something that is already done.
  return Response.json(
    { built },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

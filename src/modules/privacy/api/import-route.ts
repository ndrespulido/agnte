import { DomainError, systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { jsonError, rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { importForUser } from '../application/import';

/** Bounded so one request cannot ask the container to hold an entire archive. */
const MAX_IMPORT_BYTES = 5_000_000;

/**
 * `POST /v1/privacy/import` — read an export back in.
 *
 * The other half of portability, and the reason Phase 9 does not need a bespoke
 * migration: converting v1's tables into an `agnte.export.v1` document is a
 * standalone script, and everything after that is this endpoint, which is
 * tested and goes through the domain.
 *
 * Deliberately not idempotency-keyed like other writes. The import is already
 * idempotent by content — rows are matched by id and skipped — which is a
 * stronger guarantee than a 24-hour key window, and the natural way to use this
 * is to run it, read what was rejected, fix the file and run it again.
 */
export async function handleImport(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  /*
   * Checked before parsing rather than after. `request.json()` buffers the
   * whole body first, so a document large enough to matter has already cost the
   * memory by the time anything can look at it — and this runs in a container
   * sized for serving pages, not for holding someone's entire archive.
   *
   * Absent on a chunked request, in which case the row limit in the verse
   * module is what catches it. This is the cheap guard, not the only one.
   */
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_IMPORT_BYTES) {
    return jsonError(
      new DomainError(
        'bad_request',
        `That document is larger than ${Math.round(MAX_IMPORT_BYTES / 1_000_000)}MB. ` +
          'Split it and run the pieces in order; re-running a piece is a no-op.',
      ),
      413,
      rateLimitHeaders(decision),
    );
  }

  const document = await request.json().catch(() => null);
  if (!document || typeof document !== 'object') {
    return jsonError(
      new DomainError('bad_request', 'That is not a JSON document.'),
      400,
      rateLimitHeaders(decision),
    );
  }

  const result = await importForUser(
    auth.userId,
    document as Record<string, unknown>,
    systemClock,
  );

  if (!result.ok) {
    return jsonError(result.error, 422, rateLimitHeaders(decision));
  }

  return Response.json(result.value, {
    // 200, not 201: an import that skipped everything created nothing, and the
    // interesting part of the answer is the summary rather than a location.
    status: 200,
    headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
  });
}

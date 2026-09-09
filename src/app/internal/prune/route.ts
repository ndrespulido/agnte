import { systemClock } from '@/shared/kernel';
import { verifyInternalRequest } from '@/shared/infra/internal-auth';
import { pruneIdempotencyKeys } from '@/shared/infra/idempotency';
import { pruneRateLimits } from '@/shared/infra/rate-limit';
import {
  pruneOAuthHandoffs,
  prunePasswordResetTokens,
  prunePendingRegistrations,
  pruneRefreshTokens,
} from '@/modules/identity';
import { prunePendingMedia } from '@/modules/media';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The scheduled sweep (architecture.md §1.3).
 *
 * Every one of these pruners already existed and was tested, and not one of
 * them had a caller — several say so in their own doc comments. Expired rows
 * accumulated in six tables: idempotency keys, rate-limit windows, refresh
 * tokens, password reset tokens, pending registrations (each holding a
 * password hash), and now OAuth handoffs and abandoned uploads.
 *
 * Cloud Scheduler calls this daily. Locally there is no scheduler and no need
 * for one: nothing accumulates meaningfully on a development machine, and the
 * route is here to be curled by hand when it does (architecture.md §7.1's
 * "manual trigger route").
 *
 * Guarded by the same shared secret as the thumbnail callback, for the same
 * reason: Cloud Run runs --allow-unauthenticated, so IAM cannot gate a subset
 * of routes.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = verifyInternalRequest(request);
  if (!auth.ok) return auth.response;

  const now = systemClock.now();

  /**
   * Sequential, not `Promise.all`.
   *
   * These are seven `DELETE` statements against one small Postgres instance
   * on a free plan; running them together buys nothing a daily job needs and
   * makes a lock-contention problem harder to read in the logs. The counts
   * are returned so a scheduler run is legible in the logs and so a human
   * curling this can see what it actually did.
   */
  const swept = {
    idempotencyKeys: await pruneIdempotencyKeys(),
    rateLimitWindows: await pruneRateLimits(),
    refreshTokens: await pruneRefreshTokens(now),
    passwordResetTokens: await prunePasswordResetTokens(now),
    pendingRegistrations: await prunePendingRegistrations(now),
    oauthHandoffs: await pruneOAuthHandoffs(now),
    abandonedUploads: await prunePendingMedia(now),
  };

  return Response.json(
    { swept, at: now.toISOString() },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

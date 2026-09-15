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
import { prunePendingMedia, requeueStalledThumbnails } from '@/modules/media';
import { retryDeadLetters } from '@/shared/events';
import { registerErasureHandlers, sweepErasures } from '@/modules/privacy';

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

  /**
   * Reported separately from `swept`, because it is not one: nothing is
   * deleted here. A thumbnail job whose enqueue was lost leaves its Media
   * `processing` forever (see `requeueStalledThumbnails`), and this daily run
   * is what gives it another go.
   */
  const requeued = { thumbnails: await requeueStalledThumbnails(now) };

  /*
   * Dead-lettered event handlers get another go here.
   *
   * A handler that failed during an outage is otherwise waiting for someone to
   * notice — and the events that go through this bus are erasure requests
   * (§8.7), so "waiting for someone to notice" means a module still holding
   * data a person asked to have deleted. The sweep already runs daily and is
   * already the place where things nobody is watching get picked up.
   */
  const recovered = { eventHandlers: await retryDeadLetters() };

  /*
   * Accounts whose thirty-day grace window has closed (§8.7).
   *
   * Here rather than on its own schedule because it is the same shape as every
   * other pruner: a daily pass over rows whose time has come. The sweep
   * republishes the erasure event before deleting anything, so a module that
   * dead-lettered a month ago is not the reason data outlives the account it
   * belonged to.
   *
   * Registered on this path too: the tick and the sweep are different entry
   * points and neither can rely on the other having run first.
   */
  registerErasureHandlers();
  const erased = { accounts: await sweepErasures(now) };

  return Response.json(
    { swept, requeued, recovered, erased, at: now.toISOString() },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

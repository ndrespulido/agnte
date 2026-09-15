import { systemClock } from '@/shared/kernel';
import { consume } from '@/shared/infra/rate-limit';
import { rateLimitHeaders, tooManyRequests } from '@/shared/infra/http';
import { authenticate } from '@/modules/identity';
import { requestErasure } from '../application/erasure';
import { registerErasureHandlers } from '../application/erasure';

/**
 * `DELETE /v1/me` — the right to erasure (§8.7).
 *
 * Answers 202, not 204: the account is *marked* and every module has purged,
 * but the row itself survives a thirty-day grace window before the sweep
 * removes it. 204 would claim a completeness that is not true yet, and the
 * difference matters to the person on the other end — it is the window in which
 * they can still change their mind.
 *
 * No confirmation token, no re-entered password. That is a deliberate choice
 * and the grace window is what pays for it: the destructive step is thirty days
 * away and reversible until then, so a friction-free request costs nothing that
 * cannot be undone, while a password prompt would block exactly the people
 * least able to answer it — someone whose account was compromised, or who signs
 * in with Google and has no password at all.
 */
export async function handleEraseMe(request: Request): Promise<Response> {
  const auth = await authenticate(request);
  if (!auth.ok) return auth.response;

  const decision = await consume('authenticated', { user: auth.userId });
  if (!decision.allowed) return tooManyRequests(decision);

  // Registered here rather than at import time: a module's side effects at
  // import are invisible, and this is the only entry point that needs them.
  // `subscribe` ignores a duplicate, so calling it per request is free.
  registerErasureHandlers();

  const result = await requestErasure(auth.userId, systemClock.now());

  return Response.json(
    {
      status: 'erasure_requested',
      /*
       * Reported rather than hidden. A module that could not purge is the one
       * fact someone exercising this right most needs — "we have started" with
       * a silent failure underneath is the worst possible answer — and the
       * sweep will retry it before the account is removed.
       */
      modulesPurged: result.handled,
      modulesFailed: result.deadLettered,
      alreadyRequested: !result.marked,
    },
    {
      status: 202,
      headers: { 'cache-control': 'no-store', ...rateLimitHeaders(decision) },
    },
  );
}

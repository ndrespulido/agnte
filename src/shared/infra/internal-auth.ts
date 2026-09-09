import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError } from '@/shared/kernel';
import { jsonError } from './http';
import { loadConfig } from './config';

/**
 * Guards `/internal/*` routes (architecture.md §1.3): the callback Cloud Tasks
 * and Cloud Scheduler hit to do deferred work.
 *
 * Cloud Run runs this service with `--allow-unauthenticated`, because a
 * preview has to be reachable from a phone with no Google account attached —
 * so Cloud Run's own IAM cannot be what keeps `/internal/*` private, the way
 * it could if the service required authentication. Instead, whatever enqueues
 * the task signs it with a header only this deployment could produce, and this
 * is the one place that checks it — every `/internal/*` route calls this
 * first and nothing else duplicates the check.
 *
 * A shared secret rather than verifying a Cloud Tasks OIDC token: OIDC would
 * need `google-auth-library` to fetch and cache Google's public keys and
 * verify a JWT, for a benefit — proving the caller is *specifically* Cloud
 * Tasks — this design does not need, since the secret is never handed to
 * anything but this deployment's own runtime service account. Revisit if a
 * second, less-trusted caller ever needs to reach an `/internal/*` route.
 */

export type InternalAuthResult = { ok: true } | { ok: false; response: Response };

/**
 * `timingSafeEqual` throws on a length mismatch rather than returning false,
 * which would itself leak the length difference through which branch throws.
 * Padding both to a fixed digest length via SHA-256 first removes the length
 * signal entirely, at the cost of a comparison that is never literally
 * "compare the secret" — which is exactly the point.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

const unauthorized = (message: string): Response =>
  jsonError(new DomainError('internal_unauthorized', message), 401);

/**
 * Verifies the `Authorization: Bearer <secret>` header a task callback must
 * carry.
 *
 * Reads the database rather than trusting the token's subject is identity's
 * rule for a *user's* credential, where an account can be deleted mid-session;
 * there is no equivalent state here to go stale, so a bare string compare is
 * the whole check.
 */
export function verifyInternalRequest(request: Request): InternalAuthResult {
  const config = loadConfig();

  if (!config.INTERNAL_TASKS_SECRET) {
    return {
      ok: false,
      response: jsonError(
        new DomainError(
          'internal_unavailable',
          'Deferred work is not configured in this environment.',
        ),
        503,
      ),
    };
  }

  const header = request.headers.get('authorization');
  const match = /^Bearer +(\S+)$/i.exec(header?.trim() ?? '');
  const provided = match?.[1];

  if (!provided || !constantTimeEquals(provided, config.INTERNAL_TASKS_SECRET)) {
    return { ok: false, response: unauthorized('Not authorized.') };
  }

  return { ok: true };
}

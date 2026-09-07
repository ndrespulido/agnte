import { createHash } from 'node:crypto';
import { systemClock, type Clock } from '@/shared/kernel/clock';
import { getDatabase } from './database';

/**
 * Replay protection for write endpoints (architecture.md §6).
 *
 * Mobile networks retry underneath the client, so the same POST can arrive
 * twice and the client cannot tell whether the first one landed. Every write
 * endpoint accepts an Idempotency-Key; the first request claims it, and a retry
 * replays the stored response rather than doing the work again.
 *
 * Four outcomes, and the ones that are easy to miss matter most:
 *
 *   proceed      first time — do the work, then record the response
 *   replay       already completed — return what it returned
 *   in-progress  the first attempt is still running; doing the work now would
 *                double it, which is the exact failure this prevents
 *   mismatch     same key, different request — a client bug, and answering it
 *                with the first response would hide it
 */

/** How long a key is honoured (§8.7 retention). */
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type IdempotencyOutcome =
  | { readonly kind: 'proceed' }
  | { readonly kind: 'replay'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'in-progress' }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'unavailable' };

/**
 * Identifies the request, so a repeated key carrying different content is
 * recognised rather than answered from the first request's result.
 */
export function fingerprint(method: string, path: string, body: unknown): string {
  const canonical = JSON.stringify({
    method: method.toUpperCase(),
    path,
    body: body ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Scopes a key to its caller. Without this, one client could replay — or block
 * with an in-progress claim — another client's request by guessing a key.
 */
export const scopeFor = (userId: string | undefined, ip: string): string =>
  userId ? `user:${userId}` : `anon:${ip}`;

export async function claim(
  scope: string,
  key: string,
  requestFingerprint: string,
  clock: Clock = systemClock,
): Promise<IdempotencyOutcome> {
  const database = getDatabase();
  if (!database) return { kind: 'unavailable' };

  const now = clock.now();
  const expiresAt = new Date(now.getTime() + RETENTION_MS);

  // Claims the key, and reclaims it if the existing row has expired — both in
  // one statement, so two concurrent first-attempts cannot both win. The
  // conditional DO UPDATE returns no row when a live claim already exists,
  // which is how the caller learns to go and look at it.
  const claimed = await database.$queryRaw<{ scope: string }[]>`
    INSERT INTO platform.idempotency_key
      (scope, key, request_fingerprint, status, created_at, expires_at)
    VALUES (${scope}, ${key}, ${requestFingerprint}, 'in_progress', ${now}, ${expiresAt})
    ON CONFLICT (scope, key) DO UPDATE
      SET request_fingerprint = EXCLUDED.request_fingerprint,
          status              = 'in_progress',
          response_status     = NULL,
          response_body       = NULL,
          created_at          = EXCLUDED.created_at,
          completed_at        = NULL,
          expires_at          = EXCLUDED.expires_at
      WHERE platform.idempotency_key.expires_at < ${now}
    RETURNING scope
  `;

  if (claimed.length > 0) return { kind: 'proceed' };

  const existing = await database.$queryRaw<
    {
      request_fingerprint: string;
      status: string;
      response_status: number | null;
      response_body: unknown;
    }[]
  >`
    SELECT request_fingerprint, status, response_status, response_body
    FROM platform.idempotency_key
    WHERE scope = ${scope} AND key = ${key}
  `;

  const row = existing[0];
  // Raced with an expiry sweep between the two statements; treat as fresh.
  if (!row) return claim(scope, key, requestFingerprint, clock);

  if (row.request_fingerprint !== requestFingerprint) return { kind: 'mismatch' };
  if (row.status === 'in_progress') return { kind: 'in-progress' };

  return { kind: 'replay', status: row.response_status ?? 200, body: row.response_body };
}

/** Records the response so a later retry can replay it. */
export async function complete(
  scope: string,
  key: string,
  status: number,
  body: unknown,
  clock: Clock = systemClock,
): Promise<void> {
  const database = getDatabase();
  if (!database) return;

  await database.$executeRaw`
    UPDATE platform.idempotency_key
    SET status = 'completed',
        response_status = ${status},
        response_body = ${JSON.stringify(body ?? null)}::jsonb,
        completed_at = ${clock.now()}
    WHERE scope = ${scope} AND key = ${key}
  `;
}

/**
 * Drops a claim whose work failed.
 *
 * Without this a request that errors would hold its key for 24 hours and every
 * retry would get "in progress" — the client would be locked out of an
 * operation that never happened.
 */
export async function release(scope: string, key: string): Promise<void> {
  const database = getDatabase();
  if (!database) return;

  await database.$executeRaw`
    DELETE FROM platform.idempotency_key
    WHERE scope = ${scope} AND key = ${key} AND status = 'in_progress'
  `;
}

export async function pruneIdempotencyKeys(clock: Clock = systemClock): Promise<number> {
  const database = getDatabase();
  if (!database) return 0;

  return database.$executeRaw`
    DELETE FROM platform.idempotency_key WHERE expires_at < ${clock.now()}
  `;
}

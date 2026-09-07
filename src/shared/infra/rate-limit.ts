import { systemClock, type Clock } from '@/shared/kernel/clock';
import { getDatabase } from './database';

/**
 * Application-level rate limiting (architecture.md §8.6).
 *
 * Fixed windows in Postgres, not Redis: at this scale Redis would cost more
 * than everything else in the system combined. A fixed window is coarser than a
 * sliding one — a caller can burst across a boundary and briefly get twice the
 * limit — but these limits exist to stop credential stuffing and account
 * enumeration, not to smooth traffic, and for that the difference does not
 * matter.
 *
 * This is the second layer. Cloudflare rules at the edge are the first, and
 * stop abuse before it reaches billable compute (§3.1).
 */

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The table from §8.6, as code. Endpoints reference these by name so the
 * document and the behaviour cannot drift apart silently.
 */
export const RATE_LIMITS = {
  'auth.login': { limit: 5, windowMs: 15 * MINUTE },
  'auth.register': { limit: 3, windowMs: HOUR },
  'auth.forgot-password': { limit: 3, windowMs: HOUR },
  'media.upload-url': { limit: 100, windowMs: HOUR },
  'privacy.export': { limit: 1, windowMs: 24 * HOUR },
  authenticated: { limit: 1000, windowMs: HOUR },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  /** Never negative, even though the counter keeps climbing while blocked. */
  readonly remaining: number;
  readonly resetAt: Date;
  /** Seconds until the window resets — the Retry-After header value. */
  readonly retryAfterSeconds: number;
}

/**
 * Builds the bucket key. Sorting the parts keeps the key stable regardless of
 * the order a caller happens to pass them, so the same subject is never counted
 * in two buckets.
 */
export function bucketFor(name: RateLimitName, parts: Record<string, string>): string {
  const suffix = Object.entries(parts)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('|');
  return suffix ? `${name}:${suffix}` : name;
}

const windowStartFor = (at: Date, windowMs: number): Date =>
  new Date(Math.floor(at.getTime() / windowMs) * windowMs);

/**
 * Counts one attempt and reports whether it is allowed.
 *
 * The counter is incremented even when the attempt is already over the limit.
 * That is deliberate: it keeps the write a single atomic statement, and a
 * caller that keeps hammering does not get a fresh allowance the moment it
 * pauses.
 */
export async function consume(
  name: RateLimitName,
  parts: Record<string, string>,
  clock: Clock = systemClock,
): Promise<RateLimitDecision> {
  const rule = RATE_LIMITS[name];
  const database = getDatabase();
  const now = clock.now();
  const windowStart = windowStartFor(now, rule.windowMs);
  const resetAt = new Date(windowStart.getTime() + rule.windowMs);
  const retryAfterSeconds = Math.max(
    0,
    Math.ceil((resetAt.getTime() - now.getTime()) / 1000),
  );

  if (!database) {
    // No database configured. Failing open is the right call for a limiter:
    // refusing every request would turn a missing dependency into a total
    // outage, and the edge layer (§3.1) is still in front.
    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetAt,
      retryAfterSeconds,
    };
  }

  // One statement, so concurrent requests cannot both read the same count and
  // each believe they are under the limit.
  const rows = await database.$queryRaw<{ count: number }[]>`
    INSERT INTO platform.rate_limit_window (bucket, window_start, count)
    VALUES (${bucketFor(name, parts)}, ${windowStart}, 1)
    ON CONFLICT (bucket, window_start)
    DO UPDATE SET count = platform.rate_limit_window.count + 1
    RETURNING count
  `;

  const count = rows[0]?.count ?? 1;

  return {
    allowed: count <= rule.limit,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - count),
    resetAt,
    retryAfterSeconds,
  };
}

/**
 * Drops windows that can no longer be current. Rows are keyed by window start,
 * so anything older than the longest window is unreachable.
 */
export async function pruneRateLimits(clock: Clock = systemClock): Promise<number> {
  const database = getDatabase();
  if (!database) return 0;

  const longest = Math.max(...Object.values(RATE_LIMITS).map((rule) => rule.windowMs));
  const cutoff = new Date(clock.now().getTime() - longest);

  return database.$executeRaw`
    DELETE FROM platform.rate_limit_window WHERE window_start < ${cutoff}
  `;
}

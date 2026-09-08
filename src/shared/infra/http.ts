import { DomainError } from '@/shared/kernel';
import type { RateLimitDecision } from './rate-limit';

/**
 * HTTP shapes shared by every module's routes.
 *
 * This is infrastructure, not domain: an error envelope, a rate-limit header
 * set and a way to read the client's IP describe the transport, not any
 * module's rules. Sharing it is what keeps two modules from disagreeing about
 * what a 429 looks like — sharing *domain* types is what would re-couple them
 * (CLAUDE.md).
 *
 * A single error envelope so a client can handle failures generically:
 * `code` is the stable contract, `message` is for humans, `details` carries
 * whatever the specific error saw fit to add.
 */
export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export const errorBody = (error: DomainError): ErrorBody => ({
  error: {
    code: error.code,
    message: error.message,
    ...(Object.keys(error.details).length > 0 ? { details: { ...error.details } } : {}),
  },
});

export const jsonError = (
  error: DomainError,
  status: number,
  headers: Record<string, string> = {},
): Response =>
  Response.json(errorBody(error), {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  });

export const rateLimitHeaders = (
  decision: RateLimitDecision,
): Record<string, string> => ({
  'ratelimit-limit': String(decision.limit),
  'ratelimit-remaining': String(decision.remaining),
  'ratelimit-reset': String(decision.retryAfterSeconds),
});

export const tooManyRequests = (decision: RateLimitDecision): Response =>
  jsonError(
    new DomainError('rate_limited', 'Too many requests. Try again shortly.', {
      details: { retryAfterSeconds: decision.retryAfterSeconds },
    }),
    429,
    { ...rateLimitHeaders(decision), 'retry-after': String(decision.retryAfterSeconds) },
  );

/**
 * The caller's IP, from Cloud Run's X-Forwarded-For.
 *
 * The *first* entry is the client; everything after it is a proxy that added
 * itself. Reading the last would rate-limit Google's load balancer, and reading
 * a client-supplied header on a service that is not behind a proxy would let
 * anyone pick their own bucket — which is why this falls back to a constant
 * rather than to something attacker-controlled.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first && first.length > 0 ? first : 'unknown';
}

/**
 * Origin for links that go into emails.
 *
 * Configuration wins. Falling back to the request's own headers is what lets a
 * preview environment work without being told its URL, but it trusts a header
 * the client sets — so a forged Host would put an attacker's domain in a
 * verification link carrying the victim's token. Deployed environments set
 * APP_BASE_URL and never reach the fallback.
 */
export function baseUrl(request: Request, configured: string | undefined): string {
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}

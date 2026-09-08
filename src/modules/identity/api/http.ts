/**
 * Identity's HTTP helpers.
 *
 * The envelope, rate-limit headers and client-IP reading moved to
 * `shared/infra/http.ts` when the verse module needed them too: the boundary
 * rules stop one module importing another's internals, and copying them would
 * have let the two drift into disagreeing about what an error looks like.
 * Re-exported here so identity's routes did not all have to change.
 */
export {
  baseUrl,
  clientIp,
  errorBody,
  jsonError,
  rateLimitHeaders,
  tooManyRequests,
} from '@/shared/infra/http';
export type { ErrorBody } from '@/shared/infra/http';

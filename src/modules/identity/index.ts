/**
 * Identity's public surface.
 *
 * Everything another module or the app layer may use, and nothing else. The
 * ESLint boundary rules fail the build on any import that reaches past this
 * file (architecture.md §1.1), which is what keeps a later split into services
 * mechanical rather than archaeological.
 */
export { handleRegister } from './api/register-route';
export { handleVerifyEmail } from './api/verify-email-route';
export { handleLogin, handleLogout, handleRefresh } from './api/session-routes';

export { IdentityErrorCode } from './domain/errors';
export { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from './domain/password';
export { MAX_EMAIL_LENGTH } from './domain/email';
export type { User } from './domain/user';
export { isVerified } from './domain/user';
export { prunePendingRegistrations } from './infrastructure/prisma-pending-registration-repository';
export { pruneRefreshTokens } from './infrastructure/prisma-refresh-token-repository';

/** Access-token verification, for the route guard that lands with /v1/me (1.7). */
export {
  JwtAccessTokenIssuer,
  accessTokenSecret,
} from './infrastructure/jwt-access-token-issuer';
export { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from './domain/session';
export type { TokenPair } from './domain/session';

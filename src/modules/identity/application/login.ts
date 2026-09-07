import { err, ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import { parseEmail } from '../domain/email';
import { invalidCredentials } from '../domain/errors';
import { ACCESS_TOKEN_TTL_MS, startSession, type TokenPair } from '../domain/session';
import type {
  AccessTokenIssuer,
  PasswordHasher,
  RefreshTokenGenerator,
  RefreshTokenRepository,
  UserRepository,
} from '../domain/ports';

export interface LoginDeps {
  users: UserRepository;
  sessions: RefreshTokenRepository;
  hasher: PasswordHasher;
  accessTokens: AccessTokenIssuer;
  refreshTokens: RefreshTokenGenerator;
  clock: Clock;
}

export interface LoginCommand {
  email: string;
  password: string;
}

/**
 * Sign in.
 *
 * Every failure is the same error, and every path costs the same time. Those
 * are two separate defences against the same attack — telling an attacker
 * whether an address is registered — and skipping either one defeats both.
 */
export async function login(
  command: LoginCommand,
  deps: LoginDeps,
): Promise<Result<TokenPair, DomainError>> {
  const email = parseEmail(command.email);
  if (!email.ok) {
    // Even a malformed address burns the time, so "not an address" and "not a
    // user" are indistinguishable from outside.
    await deps.hasher.burnVerificationTime();
    return err(invalidCredentials());
  }

  const user = await deps.users.findByEmail(email.value);

  if (user === null) {
    // No hash to check, so spend the equivalent work on a decoy. Returning here
    // immediately is a ~40ms tell that the address is unregistered.
    await deps.hasher.burnVerificationTime();
    return err(invalidCredentials());
  }

  const matches = await deps.hasher.verify(user.passwordHash, command.password);
  if (!matches) return err(invalidCredentials());

  // No verified check: an account only exists once its address is proven
  // (see PendingRegistration), so there are no unverified users to turn away.
  const issued = deps.refreshTokens.issue();
  await deps.sessions.start(
    startSession({ tokenHash: issued.tokenHash, userId: user.id, clock: deps.clock }),
  );

  return ok({
    accessToken: await deps.accessTokens.issue(user.id),
    refreshToken: issued.token,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    tokenType: 'Bearer',
  });
}

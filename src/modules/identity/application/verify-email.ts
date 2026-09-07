import { err, ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import { createVerifiedUser } from '../domain/user';
import type { User } from '../domain/user';
import { verificationTokenExpired, verificationTokenInvalid } from '../domain/errors';
import type {
  PendingRegistrationRepository,
  UserRepository,
  VerificationTokenGenerator,
} from '../domain/ports';

export interface VerifyEmailDeps {
  users: UserRepository;
  pending: PendingRegistrationRepository;
  tokens: VerificationTokenGenerator;
  clock: Clock;
}

export interface VerifyEmailOutcome {
  readonly user: User;
  /** False when this exact link had already created the account. */
  readonly created: boolean;
}

/**
 * Redeem a verification link.
 *
 * Unlike registration, this may report precisely what went wrong. The token is
 * a secret: anyone holding it is the person the email was sent to, so telling
 * them "expired, request another" leaks nothing and saves them guessing.
 */
export async function verifyEmail(
  token: string,
  deps: VerifyEmailDeps,
): Promise<Result<VerifyEmailOutcome, DomainError>> {
  const tokenHash = deps.tokens.hashOf(token);
  const now = deps.clock.now();

  const redeemed = await deps.pending.redeem(tokenHash, now);
  if (redeemed.kind === 'not-found') return err(verificationTokenInvalid());
  if (redeemed.kind === 'expired') return err(verificationTokenExpired());

  const registration = redeemed.registration;

  const user = createVerifiedUser({
    email: registration.email,
    passwordHash: registration.passwordHash,
    displayName: registration.displayName,
    clock: deps.clock,
  });

  const created = await deps.users.create(user);

  if (created.kind === 'email-taken') {
    // Another registration for the same address won the race, or the same
    // person registered twice and redeemed the other link first. Either way an
    // account exists and this link has done its job, so this is a success with
    // a different user — not an error the person clicking can act on.
    const existing = await deps.users.findByEmail(registration.email);
    if (existing === null) return err(verificationTokenInvalid());

    return ok({ user: existing, created: false });
  }

  // Sibling attempts cannot produce an account any more, and each one holds a
  // password hash worth not keeping around for the rest of its 24 hours.
  await deps.pending.discardOthersFor(registration.email);

  return ok({ user, created: true });
}

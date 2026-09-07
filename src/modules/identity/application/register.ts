import { isErr, type Clock, type DomainError, type Result } from '@/shared/kernel';
import { err, ok } from '@/shared/kernel';
import { parseEmail } from '../domain/email';
import { parsePassword } from '../domain/password';
import { startRegistration } from '../domain/verification';
import type {
  IdentityMailer,
  PasswordHasher,
  PendingRegistrationRepository,
  UserRepository,
  VerificationTokenGenerator,
} from '../domain/ports';

export interface RegisterDeps {
  users: UserRepository;
  pending: PendingRegistrationRepository;
  hasher: PasswordHasher;
  tokens: VerificationTokenGenerator;
  mailer: IdentityMailer;
  clock: Clock;
  /** Builds the link that lands in the email, given the raw token. */
  verificationUrl: (token: string) => string;
  signInUrl: string;
}

export interface RegisterCommand {
  email: string;
  password: string;
  displayName?: string | null | undefined;
}

/**
 * Registration always reports the same thing.
 *
 * "Accepted, check your email" whether the address was free, already had an
 * account, or already had a pending registration. Anything that distinguishes
 * those turns this endpoint into an account-enumeration oracle — a way to ask
 * "does this person have an account here?" and get an answer. §8.6 requires
 * this of password reset for the same reason; registration leaks exactly as
 * much if it is not held to it too.
 *
 * Validation failures are still reported, because "that is not an email
 * address" says nothing about who has an account.
 */
export type RegisterOutcome = { kind: 'accepted' };

export async function register(
  command: RegisterCommand,
  deps: RegisterDeps,
): Promise<Result<RegisterOutcome, DomainError>> {
  const email = parseEmail(command.email);
  if (isErr(email)) return err(email.error);

  const password = parsePassword(command.password);
  if (isErr(password)) return err(password.error);

  // Hash before the lookup, and hash unconditionally — including on the path
  // where the address already has an account and the hash is thrown away.
  //
  // Argon2id deliberately takes tens of milliseconds. Skipping it when the
  // address is taken would make that branch measurably faster than the branch
  // where it is free, which hands back exactly the answer the identical
  // response bodies above are there to withhold.
  const passwordHash = await deps.hasher.hash(password.value);

  const existing = await deps.users.findByEmail(email.value);

  if (existing !== null) {
    // Tell the owner, not the sender. Someone typing your address into a
    // registration form is worth knowing about, and it is the one channel that
    // reaches the right person without telling the wrong one anything.
    await deps.mailer.sendDuplicateRegistrationNotice({
      to: email.value,
      displayName: existing.displayName,
      signInUrl: deps.signInUrl,
    });
    return ok({ kind: 'accepted' });
  }

  // Each attempt gets its own token carrying its own credentials, and earlier
  // attempts are left alone rather than revoked. That is what makes clicking
  // *your own* email always activate *your own* password, no matter who else
  // typed your address into the form first.
  const issued = deps.tokens.issue();

  await deps.pending.start(
    startRegistration({
      tokenHash: issued.tokenHash,
      email: email.value,
      passwordHash,
      displayName: command.displayName ?? null,
      clock: deps.clock,
    }),
  );

  await deps.mailer.sendVerification({
    to: email.value,
    displayName: command.displayName ?? null,
    verificationUrl: deps.verificationUrl(issued.token),
  });

  return ok({ kind: 'accepted' });
}

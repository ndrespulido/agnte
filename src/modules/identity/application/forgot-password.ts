import { err, ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import { parseEmail } from '../domain/email';
import { issuePasswordReset } from '../domain/password-reset';
import type {
  IdentityMailer,
  PasswordResetTokenRepository,
  UserRepository,
  VerificationTokenGenerator,
} from '../domain/ports';

export interface ForgotPasswordDeps {
  users: UserRepository;
  resets: PasswordResetTokenRepository;
  tokens: VerificationTokenGenerator;
  mailer: IdentityMailer;
  clock: Clock;
  resetUrl: (token: string) => string;
  registerUrl: string;
}

/**
 * The one response, whatever happened — §8.6 states this requirement for this
 * endpoint by name.
 */
export type ForgotPasswordOutcome = { kind: 'accepted' };

/**
 * Request a password reset.
 *
 * Both branches send exactly one email and return exactly the same thing. The
 * unknown-address branch is not a courtesy: without it, the *absence* of an
 * email is the tell, and the endpoint becomes the account-enumeration oracle
 * the identical responses exist to prevent.
 *
 * Outstanding tokens are deliberately not invalidated when a new one is
 * issued. Someone who asks twice because the first mail was slow should find
 * both links work — and the alternative hands anyone who can trigger a reset a
 * way to invalidate a link the real owner is about to click.
 */
export async function forgotPassword(
  rawEmail: string,
  deps: ForgotPasswordDeps,
): Promise<Result<ForgotPasswordOutcome, DomainError>> {
  const email = parseEmail(rawEmail);
  if (!email.ok) return err(email.error);

  const user = await deps.users.findByEmail(email.value);

  if (user === null) {
    await deps.mailer.sendPasswordResetForUnknownAddress({
      to: email.value,
      registerUrl: deps.registerUrl,
    });
    return ok({ kind: 'accepted' });
  }

  const issued = deps.tokens.issue();
  await deps.resets.issue(
    issuePasswordReset({
      tokenHash: issued.tokenHash,
      userId: user.id,
      clock: deps.clock,
    }),
  );

  await deps.mailer.sendPasswordReset({
    to: email.value,
    displayName: user.displayName,
    resetUrl: deps.resetUrl(issued.token),
  });

  return ok({ kind: 'accepted' });
}

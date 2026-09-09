import { err, ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import { oauthEmailUnverified, oauthStateInvalid } from '../domain/errors';
import { createVerifiedUser } from '../domain/user';
import type {
  OAuthAccountRepository,
  OAuthProvider,
  OAuthStateSigner,
  UserRepository,
} from '../domain/ports';

export interface SignInWithGoogleDeps {
  users: UserRepository;
  accounts: OAuthAccountRepository;
  provider: OAuthProvider;
  state: OAuthStateSigner;
  clock: Clock;
}

export interface SignInWithGoogleCommand {
  code: string;
  state: string;
  redirectUri: string;
}

/**
 * Which account this Google identity is, and nothing more.
 *
 * Deliberately not a token pair. This used to issue the session itself, which
 * was fine while the callback answered with JSON — but the browser arrives at
 * that callback by redirect, so the tokens had nowhere to go. Resolving the
 * user and issuing a session are now separate steps, and the OAuth callback
 * puts a short-lived handoff code between them (domain/oauth-handoff.ts).
 */
export interface SignInWithGoogleOutcome {
  readonly userId: string;
  /** True when this sign-in created the account rather than finding it. */
  readonly created: boolean;
}

/**
 * Complete a Google sign-in.
 *
 * Three ways this can end, and the order they are tried in is the security
 * decision:
 *
 *  1. **The Google identity is already linked.** Sign that user in. This is
 *     matched on Google's `sub`, never the email — an address can move between
 *     Google accounts, and matching on it would follow.
 *  2. **The verified address matches an existing account.** Link the identity
 *     to it. This is the convenience that stops someone who registered with a
 *     password from being given a second, separate account, and it is only safe
 *     because the address is verified — see below.
 *  3. **Neither.** Create an account with no password, already verified: Google
 *     has proven the address, which is exactly what our own verification email
 *     proves.
 */
export async function signInWithGoogle(
  command: SignInWithGoogleCommand,
  deps: SignInWithGoogleDeps,
): Promise<Result<SignInWithGoogleOutcome, DomainError>> {
  // Before anything else, and before the code is spent: this proves the
  // callback belongs to a flow this server started. Without it an attacker can
  // hand a victim a callback URL carrying the attacker's code, and the victim's
  // browser silently ends up signed into the attacker's account — where
  // everything they then write is readable by its owner.
  if (!(await deps.state.verify(command.state))) return err(oauthStateInvalid());

  let identity;
  try {
    identity = await deps.provider.exchange({
      code: command.code,
      redirectUri: command.redirectUri,
    });
  } catch (error) {
    return err(error as DomainError);
  }

  // Belt and braces: the adapter already refuses an unverified address, but
  // this is the rule that makes step 2 safe, so it is stated where step 2 is.
  // Anyone who can get a provider to assert a victim's address — trivial on a
  // Workspace domain the attacker controls — would otherwise be handed the
  // victim's account.
  if (!identity.emailVerified) return err(oauthEmailUnverified());

  const existingLink = await deps.accounts.findByProviderAccount(
    identity.provider,
    identity.subject,
  );

  if (existingLink) {
    return finish(existingLink.userId, false);
  }

  const byEmail = await deps.users.findByEmail(identity.email);

  if (byEmail) {
    await deps.accounts.link({
      provider: identity.provider,
      providerAccountId: identity.subject,
      userId: byEmail.id,
      email: identity.email,
    });
    return finish(byEmail.id, false);
  }

  const user = createVerifiedUser({
    email: identity.email,
    // No password. A placeholder hash would be a credential nobody chose and
    // nobody can use; the account signs in with Google until its owner sets a
    // password through a reset.
    passwordHash: null,
    displayName: identity.displayName,
    clock: deps.clock,
  });

  const created = await deps.users.create(user);

  if (created.kind === 'email-taken') {
    // Another sign-in for the same address won the race. Look it up and link to
    // it rather than failing: the person did nothing wrong, and the address is
    // verified either way.
    const raced = await deps.users.findByEmail(identity.email);
    if (!raced) return err(oauthStateInvalid());

    await deps.accounts.link({
      provider: identity.provider,
      providerAccountId: identity.subject,
      userId: raced.id,
      email: identity.email,
    });
    return finish(raced.id, false);
  }

  await deps.accounts.link({
    provider: identity.provider,
    providerAccountId: identity.subject,
    userId: user.id,
    email: identity.email,
  });

  return finish(user.id, true);
}

/** The three paths above all end the same way: this is the account. */
function finish(
  userId: string,
  created: boolean,
): Result<SignInWithGoogleOutcome, DomainError> {
  return ok({ userId, created });
}

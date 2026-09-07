import { err, ok, type Clock, type DomainError, type Result } from '@/shared/kernel';
import { oauthEmailUnverified, oauthStateInvalid } from '../domain/errors';
import { ACCESS_TOKEN_TTL_MS, startSession, type TokenPair } from '../domain/session';
import { createVerifiedUser } from '../domain/user';
import type {
  AccessTokenIssuer,
  OAuthAccountRepository,
  OAuthProvider,
  OAuthStateSigner,
  RefreshTokenGenerator,
  RefreshTokenRepository,
  UserRepository,
} from '../domain/ports';

export interface SignInWithGoogleDeps {
  users: UserRepository;
  accounts: OAuthAccountRepository;
  sessions: RefreshTokenRepository;
  provider: OAuthProvider;
  state: OAuthStateSigner;
  accessTokens: AccessTokenIssuer;
  refreshTokens: RefreshTokenGenerator;
  clock: Clock;
}

export interface SignInWithGoogleCommand {
  code: string;
  state: string;
  redirectUri: string;
}

export interface SignInWithGoogleOutcome {
  readonly tokens: TokenPair;
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
    return finish(existingLink.userId, false, deps);
  }

  const byEmail = await deps.users.findByEmail(identity.email);

  if (byEmail) {
    await deps.accounts.link({
      provider: identity.provider,
      providerAccountId: identity.subject,
      userId: byEmail.id,
      email: identity.email,
    });
    return finish(byEmail.id, false, deps);
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
    return finish(raced.id, false, deps);
  }

  await deps.accounts.link({
    provider: identity.provider,
    providerAccountId: identity.subject,
    userId: user.id,
    email: identity.email,
  });

  return finish(user.id, true, deps);
}

/** Issues the same token pair a password sign-in would, so downstream sees one auth model (§4). */
async function finish(
  userId: string,
  created: boolean,
  deps: SignInWithGoogleDeps,
): Promise<Result<SignInWithGoogleOutcome, DomainError>> {
  const issued = deps.refreshTokens.issue();
  await deps.sessions.start(
    startSession({ tokenHash: issued.tokenHash, userId, clock: deps.clock }),
  );

  return ok({
    tokens: {
      accessToken: await deps.accessTokens.issue(userId),
      refreshToken: issued.token,
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      tokenType: 'Bearer',
    },
    created,
  });
}

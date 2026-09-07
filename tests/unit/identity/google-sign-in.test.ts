import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@/shared/kernel';
import { signInWithGoogle } from '@/modules/identity/application/sign-in-with-google';
import type { SignInWithGoogleDeps } from '@/modules/identity/application/sign-in-with-google';
import {
  IdentityErrorCode,
  oauthEmailUnverified,
} from '@/modules/identity/domain/errors';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import type { Email } from '@/modules/identity/domain/email';
import type { ProviderIdentity } from '@/modules/identity/domain/ports';
import {
  FakeAccessTokenIssuer,
  FakeOAuthAccountRepository,
  FakeOAuthProvider,
  FakePasswordHasher,
  FakeRefreshTokenRepository,
  FakeStateSigner,
  FakeTokenGenerator,
  FakeUserRepository,
} from '../../support/identity-fakes';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const clock = fixedClock(NOW);

const identity = (over: Partial<ProviderIdentity> = {}): ProviderIdentity => ({
  provider: 'google',
  subject: 'google-subject-1',
  email: 'person@example.com' as Email,
  emailVerified: true,
  displayName: 'A Person',
  ...over,
});

let users: FakeUserRepository;
let accounts: FakeOAuthAccountRepository;
let sessions: FakeRefreshTokenRepository;
let state: FakeStateSigner;

const deps = (provider: FakeOAuthProvider): SignInWithGoogleDeps => ({
  users,
  accounts,
  sessions,
  provider,
  state,
  accessTokens: new FakeAccessTokenIssuer(),
  refreshTokens: new FakeTokenGenerator(),
  clock,
});

const run = async (provider: FakeOAuthProvider, stateValue?: string) =>
  signInWithGoogle(
    {
      code: 'the-code',
      state: stateValue ?? (await state.issue()),
      redirectUri: 'https://agnte.test/v1/auth/google/callback',
    },
    deps(provider),
  );

beforeEach(() => {
  users = new FakeUserRepository();
  accounts = new FakeOAuthAccountRepository();
  sessions = new FakeRefreshTokenRepository();
  state = new FakeStateSigner();
});

describe('signInWithGoogle', () => {
  it('creates a passwordless, already-verified account for a new person', async () => {
    const result = await run(new FakeOAuthProvider(identity()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.tokens.tokenType).toBe('Bearer');

    const user = await users.findByEmail('person@example.com' as Email);
    // Google has proven the address, which is exactly what our own verification
    // email proves — so there is nothing left to verify.
    expect(user?.emailVerifiedAt).not.toBeNull();
    // And no password: a placeholder hash would be a credential nobody chose.
    expect(user?.passwordHash).toBeNull();
    expect(accounts.links).toHaveLength(1);
  });

  it('signs an already-linked identity in without creating anything', async () => {
    await run(new FakeOAuthProvider(identity()));
    const before = users.users.size;

    const again = await run(new FakeOAuthProvider(identity()));

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.created).toBe(false);
    expect(users.users.size).toBe(before);
    expect(accounts.links).toHaveLength(1);
  });

  it('starts a real session, so the tokens can be refreshed', async () => {
    await run(new FakeOAuthProvider(identity()));
    expect(sessions.rows.size).toBe(1);
  });

  it('carries the display name Google supplied', async () => {
    await run(new FakeOAuthProvider(identity({ displayName: 'Andrés Pulido' })));

    const user = await users.findByEmail('person@example.com' as Email);
    expect(user?.displayName).toBe('Andrés Pulido');
  });
});

/**
 * Matching is on Google's `sub`, never the email.
 *
 * An address can move between Google accounts and a Google account can change
 * its address. `sub` is the only identifier Google promises is stable and
 * unique forever, and matching on anything else means following the address
 * wherever it goes.
 */
describe('identity matching uses the provider subject, not the email', () => {
  it('follows the same person when their Google address changes', async () => {
    await run(new FakeOAuthProvider(identity()));
    const userId = [...users.users.values()][0]?.id;

    // Same Google account, new address on it.
    const moved = await run(
      new FakeOAuthProvider(identity({ email: 'new-address@example.com' as Email })),
    );

    expect(moved.ok).toBe(true);
    // No second account, and no second link.
    expect(users.users.size).toBe(1);
    expect(accounts.links).toHaveLength(1);
    expect(accounts.links[0]?.userId).toBe(userId);
  });

  it('treats a different Google account with a familiar address as a link, not a new user', async () => {
    // A password account already exists on the address, and Google asserts a
    // verified claim to it. Linking is the convenience that stops a second,
    // separate account appearing — and it is only safe because it is verified.
    const hasher = new FakePasswordHasher();
    await users.create(
      createVerifiedUser({
        email: 'person@example.com' as Email,
        passwordHash: await hasher.hash('an existing password' as never),
        clock,
      }),
    );

    const result = await run(new FakeOAuthProvider(identity()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(false);
    expect(users.users.size).toBe(1);
    expect(accounts.links).toHaveLength(1);
  });
});

describe('signInWithGoogle refuses what it should', () => {
  it('rejects a state it did not issue, before spending the code', async () => {
    // Without this an attacker hands a victim a callback URL carrying the
    // attacker's code, and the victim's browser silently ends up signed into
    // the attacker's account — where everything they then write is readable by
    // its owner.
    const provider = new FakeOAuthProvider(identity());

    const result = await run(provider, 'forged-state');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.OAuthStateInvalid);
    // The check happens first: the code is never presented to Google.
    expect(provider.exchanges).toBe(0);
    expect(users.users.size).toBe(0);
  });

  it('refuses an address Google has not verified', async () => {
    // The account-takeover this prevents: anyone who can make a provider assert
    // a victim's address — trivial on a Workspace domain the attacker owns —
    // would otherwise be linked straight into the victim's account.
    const result = await run(new FakeOAuthProvider(identity({ emailVerified: false })));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.OAuthEmailUnverified);
    expect(users.users.size).toBe(0);
    expect(accounts.links).toHaveLength(0);
  });

  it('never links an unverified address even to an account that already exists', async () => {
    await users.create(
      createVerifiedUser({
        email: 'victim@example.com' as Email,
        passwordHash: 'hashed:the real password',
        clock,
      }),
    );

    const result = await run(
      new FakeOAuthProvider(
        identity({ email: 'victim@example.com' as Email, emailVerified: false }),
      ),
    );

    expect(result.ok).toBe(false);
    expect(accounts.links).toHaveLength(0);
  });

  it('surfaces a provider failure rather than signing anyone in', async () => {
    const result = await run(new FakeOAuthProvider(oauthEmailUnverified()));

    expect(result.ok).toBe(false);
    expect(users.users.size).toBe(0);
  });
});

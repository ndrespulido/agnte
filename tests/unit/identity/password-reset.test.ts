import { beforeEach, describe, expect, it } from 'vitest';
import { mutableClock } from '@/shared/kernel';
import { forgotPassword } from '@/modules/identity/application/forgot-password';
import type { ForgotPasswordDeps } from '@/modules/identity/application/forgot-password';
import { login } from '@/modules/identity/application/login';
import { refresh } from '@/modules/identity/application/refresh';
import { resetPassword } from '@/modules/identity/application/reset-password';
import type { ResetPasswordDeps } from '@/modules/identity/application/reset-password';
import { IdentityErrorCode } from '@/modules/identity/domain/errors';
import { PASSWORD_RESET_TTL_MS } from '@/modules/identity/domain/password-reset';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import type { Email } from '@/modules/identity/domain/email';
import type { RawPassword } from '@/modules/identity/domain/password';
import {
  FakeAccessTokenIssuer,
  FakeMailer,
  FakePasswordHasher,
  FakePasswordResetTokenRepository,
  FakeRefreshTokenRepository,
  FakeTokenGenerator,
  FakeUserRepository,
} from '../../support/identity-fakes';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const OLD_PASSWORD = 'the original password';
const NEW_PASSWORD = 'the replacement password';

let users: FakeUserRepository;
let resets: FakePasswordResetTokenRepository;
let sessions: FakeRefreshTokenRepository;
let hasher: FakePasswordHasher;
let tokens: FakeTokenGenerator;
let mailer: FakeMailer;
let clock: ReturnType<typeof mutableClock>;
let userId: string;

beforeEach(async () => {
  users = new FakeUserRepository();
  resets = new FakePasswordResetTokenRepository();
  sessions = new FakeRefreshTokenRepository();
  hasher = new FakePasswordHasher();
  tokens = new FakeTokenGenerator();
  mailer = new FakeMailer();
  clock = mutableClock(NOW);

  const user = createVerifiedUser({
    email: 'a@example.com' as Email,
    passwordHash: await hasher.hash(OLD_PASSWORD as RawPassword),
    displayName: 'Andrés',
    clock,
  });
  await users.create(user);
  userId = user.id;
});

const forgotDeps = (): ForgotPasswordDeps => ({
  users,
  resets,
  tokens,
  mailer,
  clock,
  resetUrl: (token) => `https://agnte.test/reset-password?token=${token}`,
  registerUrl: 'https://agnte.test/register',
});

const resetDeps = (): ResetPasswordDeps => ({
  users,
  resets,
  sessions,
  hasher,
  tokens,
  clock,
});

const loginDeps = () => ({
  users,
  sessions,
  hasher,
  accessTokens: new FakeAccessTokenIssuer(),
  refreshTokens: tokens,
  clock,
});

const lastResetToken = (): string => {
  const url = mailer.sent.filter((m) => m.kind === 'password-reset').at(-1)?.url;
  if (!url) throw new Error('no reset email was sent');
  return new URL(url).searchParams.get('token') ?? '';
};

describe('forgotPassword', () => {
  it('issues a token and emails a link', async () => {
    const result = await forgotPassword('a@example.com', forgotDeps());

    expect(result.ok).toBe(true);
    expect(resets.rows.size).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.kind).toBe('password-reset');
  });

  it('normalises the address before looking it up', async () => {
    await forgotPassword('  A@Example.COM ', forgotDeps());
    expect(resets.rows.size).toBe(1);
  });

  it('rejects a malformed address', async () => {
    // Safe to report: "that is not an email" says nothing about who has an
    // account, and silently accepting a typo helps nobody.
    const result = await forgotPassword('not-an-address', forgotDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.EmailInvalid);
  });

  it('leaves an earlier outstanding link working', async () => {
    // Someone who asks twice because the first mail was slow should find both
    // work. Invalidating on issue would also hand anyone who can trigger a
    // reset a way to kill a link the real owner is about to click.
    await forgotPassword('a@example.com', forgotDeps());
    const first = lastResetToken();
    await forgotPassword('a@example.com', forgotDeps());

    const result = await resetPassword(first, NEW_PASSWORD, resetDeps());
    expect(result.ok).toBe(true);
  });
});

/**
 * §8.6 names this endpoint specifically. The absence of an email is as much of
 * a tell as a different status code, which is why the unknown branch still
 * sends one.
 */
describe('forgotPassword does not reveal whether an address has an account', () => {
  it('returns an identical result either way', async () => {
    const known = await forgotPassword('a@example.com', forgotDeps());
    const unknown = await forgotPassword('nobody@example.com', forgotDeps());

    expect(known).toEqual(unknown);
  });

  it('sends exactly one email either way', async () => {
    await forgotPassword('a@example.com', forgotDeps());
    const afterKnown = mailer.sent.length;
    await forgotPassword('nobody@example.com', forgotDeps());

    expect(mailer.sent.length - afterKnown).toBe(1);
  });

  it('tells an unknown address there is no account, rather than saying nothing', async () => {
    await forgotPassword('nobody@example.com', forgotDeps());

    expect(mailer.sent).toEqual([
      {
        kind: 'no-such-account',
        to: 'nobody@example.com',
        url: 'https://agnte.test/register',
      },
    ]);
    expect(resets.rows.size).toBe(0);
  });
});

describe('resetPassword', () => {
  const requestReset = async () => {
    await forgotPassword('a@example.com', forgotDeps());
    return lastResetToken();
  };

  it('replaces the password', async () => {
    const token = await requestReset();

    const result = await resetPassword(token, NEW_PASSWORD, resetDeps());
    expect(result.ok).toBe(true);

    const user = await users.findById(userId);
    expect(await hasher.verify(user!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await hasher.verify(user!.passwordHash, OLD_PASSWORD)).toBe(false);
  });

  it('lets the new password sign in and stops the old one', async () => {
    const token = await requestReset();
    await resetPassword(token, NEW_PASSWORD, resetDeps());

    expect(
      (await login({ email: 'a@example.com', password: NEW_PASSWORD }, loginDeps())).ok,
    ).toBe(true);
    expect(
      (await login({ email: 'a@example.com', password: OLD_PASSWORD }, loginDeps())).ok,
    ).toBe(false);
  });

  it('bumps the version, so a concurrent write is caught', async () => {
    const token = await requestReset();
    await resetPassword(token, NEW_PASSWORD, resetDeps());

    expect((await users.findById(userId))?.version).toBe(1);
  });

  it('rejects a second use of the same link', async () => {
    const token = await requestReset();
    await resetPassword(token, NEW_PASSWORD, resetDeps());

    const again = await resetPassword(token, 'yet another password', resetDeps());
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.code).toBe(IdentityErrorCode.ResetTokenAlreadyUsed);
  });

  it('rejects a token that was never issued', async () => {
    const result = await resetPassword('never-issued', NEW_PASSWORD, resetDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.ResetTokenInvalid);
  });

  it('rejects a link past its hour', async () => {
    const token = await requestReset();
    clock.advance(PASSWORD_RESET_TTL_MS + 1);

    const result = await resetPassword(token, NEW_PASSWORD, resetDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.ResetTokenExpired);
  });

  it('does not burn the token when the new password breaks policy', async () => {
    // A typo should cost a retry, not a fresh trip through email.
    const token = await requestReset();

    const rejected = await resetPassword(token, 'short', resetDeps());
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe(IdentityErrorCode.PasswordTooShort);

    expect((await resetPassword(token, NEW_PASSWORD, resetDeps())).ok).toBe(true);
  });
});

/**
 * §4: a reset link is invalidated on use *and* on password change.
 *
 * A link that outlives the password it was issued against is a standing way
 * back in for whoever requested it — including an attacker who requested one,
 * waited for the owner to notice nothing, and kept it.
 */
describe('a password change invalidates every outstanding reset link', () => {
  it('kills a second link issued before the reset', async () => {
    await forgotPassword('a@example.com', forgotDeps());
    const attackerLink = lastResetToken();
    await forgotPassword('a@example.com', forgotDeps());
    const ownerLink = lastResetToken();

    await resetPassword(ownerLink, NEW_PASSWORD, resetDeps());

    const stale = await resetPassword(
      attackerLink,
      'attacker chosen password',
      resetDeps(),
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe(IdentityErrorCode.ResetTokenAlreadyUsed);

    // And the password is still the owner's.
    const user = await users.findById(userId);
    expect(await hasher.verify(user!.passwordHash, NEW_PASSWORD)).toBe(true);
  });
});

/**
 * A reset is what someone does when they think the account is compromised.
 * Leaving the attacker's refresh tokens alive would make the exercise
 * pointless — they would simply keep refreshing.
 */
describe('a reset ends every existing session', () => {
  it('revokes sessions and reports how many', async () => {
    const phone = await login(
      { email: 'a@example.com', password: OLD_PASSWORD },
      loginDeps(),
    );
    const laptop = await login(
      { email: 'a@example.com', password: OLD_PASSWORD },
      loginDeps(),
    );
    expect(phone.ok && laptop.ok).toBe(true);
    if (!phone.ok || !laptop.ok) return;

    await forgotPassword('a@example.com', forgotDeps());
    const result = await resetPassword(lastResetToken(), NEW_PASSWORD, resetDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessionsRevoked).toBe(2);

    const refreshDeps = {
      sessions,
      accessTokens: new FakeAccessTokenIssuer(),
      refreshTokens: tokens,
      clock,
    };
    expect((await refresh(phone.value.refreshToken, refreshDeps)).ok).toBe(false);
    expect((await refresh(laptop.value.refreshToken, refreshDeps)).ok).toBe(false);
  });
});

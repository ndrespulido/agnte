import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock, mutableClock } from '@/shared/kernel';
import { register } from '@/modules/identity/application/register';
import type { RegisterDeps } from '@/modules/identity/application/register';
import { verifyEmail } from '@/modules/identity/application/verify-email';
import { IdentityErrorCode } from '@/modules/identity/domain/errors';
import { VERIFICATION_TOKEN_TTL_MS } from '@/modules/identity/domain/verification';
import {
  FakeMailer,
  FakePasswordHasher,
  FakePendingRegistrationRepository,
  FakeTokenGenerator,
  FakeUserRepository,
} from '../../support/identity-fakes';

const NOW = new Date('2026-09-07T12:00:00.000Z');

let users: FakeUserRepository;
let pending: FakePendingRegistrationRepository;
let hasher: FakePasswordHasher;
let mailer: FakeMailer;
let tokens: FakeTokenGenerator;
let clock: ReturnType<typeof mutableClock>;
let deps: RegisterDeps;

beforeEach(() => {
  users = new FakeUserRepository();
  pending = new FakePendingRegistrationRepository();
  hasher = new FakePasswordHasher();
  mailer = new FakeMailer();
  tokens = new FakeTokenGenerator();
  clock = mutableClock(NOW);
  deps = {
    users,
    pending,
    hasher,
    tokens,
    mailer,
    clock,
    verificationUrl: (token) => `https://agnte.test/v1/auth/verify-email?token=${token}`,
    signInUrl: 'https://agnte.test/sign-in',
  };
});

const verifyDeps = () => ({ users, pending, tokens, clock });

/** The token from the nth verification email that was sent. */
const tokenFromEmail = (index: number): string => {
  const url = mailer.sent.filter((m) => m.kind === 'verification')[index]?.url;
  if (!url) throw new Error(`no verification email at index ${index}`);
  return new URL(url).searchParams.get('token') ?? '';
};

describe('verifyEmail', () => {
  it('creates the account when the link is redeemed', async () => {
    await register({ email: 'a@example.com', password: 'a long enough password' }, deps);

    const result = await verifyEmail(tokenFromEmail(0), verifyDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toBe(true);
    expect(result.value.user.email).toBe('a@example.com');
    expect(result.value.user.emailVerifiedAt).not.toBeNull();
    expect(users.users.size).toBe(1);
  });

  it('rejects a token that was never issued', async () => {
    const result = await verifyEmail('never-issued', verifyDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.VerificationTokenInvalid);
  });

  it('rejects a second use of the same link', async () => {
    await register({ email: 'a@example.com', password: 'a long enough password' }, deps);
    const token = tokenFromEmail(0);

    await verifyEmail(token, verifyDeps());
    const second = await verifyEmail(token, verifyDeps());

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe(IdentityErrorCode.VerificationTokenInvalid);
  });

  it('rejects a link past its 24 hours', async () => {
    await register({ email: 'a@example.com', password: 'a long enough password' }, deps);
    clock.advance(VERIFICATION_TOKEN_TTL_MS + 1);

    const result = await verifyEmail(tokenFromEmail(0), verifyDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.VerificationTokenExpired);
    expect(users.users.size).toBe(0);
  });

  it('drops sibling attempts once one has succeeded', async () => {
    await register({ email: 'a@example.com', password: 'first attempt password' }, deps);
    await register({ email: 'a@example.com', password: 'second attempt password' }, deps);
    expect(pending.rows.size).toBe(2);

    await verifyEmail(tokenFromEmail(0), verifyDeps());

    // The other row can no longer produce an account, and it holds a password
    // hash worth not keeping for the rest of its 24 hours.
    expect(pending.rows.size).toBe(0);
  });
});

/**
 * Account pre-hijacking — the reason the account is not created until the
 * address is proven, and the reason the candidate password lives on the token
 * rather than on a placeholder user row.
 *
 * The attack: someone registers a victim's address before the victim does. With
 * one user row per address whose password is overwritten by the most recent
 * registration, the victim clicking the link in their own inbox can activate an
 * account holding the *attacker's* password — and the attacker then signs in.
 *
 * The property that defeats it: clicking your own email always gives you your
 * own password, whatever anyone else did first.
 */
describe('account pre-hijacking', () => {
  const ATTACKER = 'the attacker password';
  const VICTIM = 'the victim real password';

  it('gives the victim their own password when the attacker registered first', async () => {
    await register({ email: 'victim@example.com', password: ATTACKER }, deps);
    await register({ email: 'victim@example.com', password: VICTIM }, deps);

    // The victim clicks the email they caused — the second one.
    const result = await verifyEmail(tokenFromEmail(1), verifyDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await hasher.verify(result.value.user.passwordHash, VICTIM)).toBe(true);
    expect(await hasher.verify(result.value.user.passwordHash, ATTACKER)).toBe(false);
  });

  it('gives the victim their own password when the attacker registered second', async () => {
    await register({ email: 'victim@example.com', password: VICTIM }, deps);
    await register({ email: 'victim@example.com', password: ATTACKER }, deps);

    // The victim clicks the email they caused — the first one. Crucially it
    // still works: the attacker's later registration did not revoke it.
    const result = await verifyEmail(tokenFromEmail(0), verifyDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await hasher.verify(result.value.user.passwordHash, VICTIM)).toBe(true);
    expect(await hasher.verify(result.value.user.passwordHash, ATTACKER)).toBe(false);
  });

  it("leaves the attacker's link unable to change an account that now exists", async () => {
    await register({ email: 'victim@example.com', password: VICTIM }, deps);
    await register({ email: 'victim@example.com', password: ATTACKER }, deps);
    const attackerToken = tokenFromEmail(1);

    await verifyEmail(tokenFromEmail(0), verifyDeps());
    const attacker = await verifyEmail(attackerToken, verifyDeps());

    // Whether it reports "invalid" (the sibling was discarded) or succeeds
    // against the existing account, what must not happen is the password
    // changing.
    const account = await users.findByEmail('victim@example.com' as never);
    expect(await hasher.verify(account?.passwordHash ?? '', VICTIM)).toBe(true);
    expect(attacker.ok === true && attacker.value.created).not.toBe(true);
  });
});

describe('fixedClock guards against a test moving time by accident', () => {
  it('does not let a caller mutate the clock it was handed', () => {
    const frozen = fixedClock(NOW);
    frozen.now().setFullYear(1999);
    expect(frozen.now().toISOString()).toBe(NOW.toISOString());
  });
});

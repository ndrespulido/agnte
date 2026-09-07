import { beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@/shared/kernel';
import { register } from '@/modules/identity/application/register';
import type { RegisterDeps } from '@/modules/identity/application/register';
import { IdentityErrorCode } from '@/modules/identity/domain/errors';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import type { Email } from '@/modules/identity/domain/email';
import {
  FakeMailer,
  FakePasswordHasher,
  FakePendingRegistrationRepository,
  FakeTokenGenerator,
  FakeUserRepository,
} from '../../support/identity-fakes';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const PASSWORD = 'a sufficiently long password';

let users: FakeUserRepository;
let pending: FakePendingRegistrationRepository;
let hasher: FakePasswordHasher;
let mailer: FakeMailer;
let deps: RegisterDeps;

beforeEach(() => {
  users = new FakeUserRepository();
  pending = new FakePendingRegistrationRepository();
  hasher = new FakePasswordHasher();
  mailer = new FakeMailer();
  deps = {
    users,
    pending,
    hasher,
    tokens: new FakeTokenGenerator(),
    mailer,
    clock: fixedClock(NOW),
    verificationUrl: (token) => `https://agnte.test/v1/auth/verify-email?token=${token}`,
    signInUrl: 'https://agnte.test/sign-in',
  };
});

const seedVerifiedUser = async (email: string) => {
  await users.create(
    createVerifiedUser({
      email: email as Email,
      passwordHash: 'hashed:whatever the owner chose',
      displayName: null,
      clock: fixedClock(NOW),
    }),
  );
};

describe('register', () => {
  it('starts a pending registration and emails a verification link', async () => {
    const result = await register(
      { email: 'New@Example.com ', password: PASSWORD },
      deps,
    );

    expect(result.ok).toBe(true);
    expect(pending.rows.size).toBe(1);
    expect([...pending.rows.values()][0]?.email).toBe('new@example.com');
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.kind).toBe('verification');
  });

  it('creates no account until the address is verified', async () => {
    await register({ email: 'new@example.com', password: PASSWORD }, deps);
    expect(users.users.size).toBe(0);
  });

  it('rejects a password shorter than the policy', async () => {
    const result = await register({ email: 'new@example.com', password: 'short' }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.PasswordTooShort);
    expect(mailer.sent).toHaveLength(0);
  });

  it('rejects a malformed address', async () => {
    const result = await register({ email: 'not-an-address', password: PASSWORD }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.EmailInvalid);
  });
});

/**
 * The property that matters most here. If any of these three can tell the two
 * cases apart, the endpoint answers "does this person have an account?" for
 * anyone who asks.
 */
describe('register does not reveal whether an address is already registered', () => {
  it('returns an identical result for a free and a taken address', async () => {
    const free = await register({ email: 'free@example.com', password: PASSWORD }, deps);
    await seedVerifiedUser('taken@example.com');
    const taken = await register(
      { email: 'taken@example.com', password: PASSWORD },
      deps,
    );

    expect(free).toEqual(taken);
  });

  it('sends exactly one email either way, so delivery timing tells nothing', async () => {
    await register({ email: 'free@example.com', password: PASSWORD }, deps);
    const afterFree = mailer.sent.length;

    await seedVerifiedUser('taken@example.com');
    await register({ email: 'taken@example.com', password: PASSWORD }, deps);

    expect(mailer.sent.length - afterFree).toBe(1);
  });

  it('hashes the password even when the address is taken', async () => {
    // Argon2id costs tens of milliseconds. Skipping it on the "taken" branch
    // would make that branch measurably faster and hand back the answer the
    // identical responses above exist to withhold.
    await seedVerifiedUser('taken@example.com');

    const before = hasher.hashCalls;
    await register({ email: 'taken@example.com', password: PASSWORD }, deps);

    expect(hasher.hashCalls).toBe(before + 1);
  });

  it('tells the address owner instead of the person registering', async () => {
    await seedVerifiedUser('taken@example.com');
    await register({ email: 'taken@example.com', password: PASSWORD }, deps);

    expect(mailer.sent).toEqual([
      {
        kind: 'duplicate-registration',
        to: 'taken@example.com',
        url: 'https://agnte.test/sign-in',
      },
    ]);
    expect(pending.rows.size).toBe(0);
  });
});

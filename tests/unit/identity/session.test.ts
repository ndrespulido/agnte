import { beforeEach, describe, expect, it } from 'vitest';
import { mutableClock } from '@/shared/kernel';
import { login } from '@/modules/identity/application/login';
import type { LoginDeps } from '@/modules/identity/application/login';
import { logout } from '@/modules/identity/application/logout';
import { refresh } from '@/modules/identity/application/refresh';
import { IdentityErrorCode } from '@/modules/identity/domain/errors';
import { REFRESH_TOKEN_TTL_MS } from '@/modules/identity/domain/session';
import { createVerifiedUser } from '@/modules/identity/domain/user';
import type { Email } from '@/modules/identity/domain/email';
import type { RawPassword } from '@/modules/identity/domain/password';
import {
  FakeAccessTokenIssuer,
  FakePasswordHasher,
  FakeRefreshTokenRepository,
  FakeTokenGenerator,
  FakeUserRepository,
} from '../../support/identity-fakes';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const PASSWORD = 'a sufficiently long password';

let users: FakeUserRepository;
let sessions: FakeRefreshTokenRepository;
let hasher: FakePasswordHasher;
let refreshTokens: FakeTokenGenerator;
let clock: ReturnType<typeof mutableClock>;
let deps: LoginDeps;

beforeEach(async () => {
  users = new FakeUserRepository();
  sessions = new FakeRefreshTokenRepository();
  hasher = new FakePasswordHasher();
  refreshTokens = new FakeTokenGenerator();
  clock = mutableClock(NOW);
  deps = {
    users,
    sessions,
    hasher,
    accessTokens: new FakeAccessTokenIssuer(),
    refreshTokens,
    clock,
  };

  await users.create(
    createVerifiedUser({
      email: 'a@example.com' as Email,
      passwordHash: await hasher.hash(PASSWORD as RawPassword),
      displayName: null,
      clock,
    }),
  );
});

const sessionDeps = () => ({
  sessions,
  accessTokens: deps.accessTokens,
  refreshTokens,
  clock,
});

const signIn = async () => {
  const result = await login({ email: 'a@example.com', password: PASSWORD }, deps);
  if (!result.ok) throw new Error('expected sign-in to succeed');
  return result.value;
};

describe('login', () => {
  it('issues an access token and a refresh token', async () => {
    const pair = await signIn();

    expect(pair.tokenType).toBe('Bearer');
    expect(pair.expiresIn).toBe(900);
    expect(await deps.accessTokens.verify(pair.accessToken)).toBe(
      [...users.users.values()][0]?.id,
    );
    expect(sessions.rows.size).toBe(1);
  });

  it('rejects the wrong password', async () => {
    const result = await login(
      { email: 'a@example.com', password: 'not the password' },
      deps,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.InvalidCredentials);
    expect(sessions.rows.size).toBe(0);
  });

  it('gives an unknown address the same error as a wrong password', async () => {
    const unknown = await login(
      { email: 'nobody@example.com', password: PASSWORD },
      deps,
    );
    const wrong = await login(
      { email: 'a@example.com', password: 'not the password' },
      deps,
    );

    expect(unknown).toEqual(wrong);
  });
});

/**
 * The timing half of the same defence. Identical error bodies are worthless if
 * the "no such user" path returns in microseconds while a real check spends
 * tens of milliseconds in Argon2 — the clock answers the question the response
 * refuses to.
 */
describe('login spends the same work whether or not the address exists', () => {
  it('burns verification time for an unknown address', async () => {
    const before = hasher.burnCalls;
    await login({ email: 'nobody@example.com', password: PASSWORD }, deps);
    expect(hasher.burnCalls).toBe(before + 1);
  });

  it('burns verification time for an address that is not even valid', async () => {
    const before = hasher.burnCalls;
    await login({ email: 'not-an-address', password: PASSWORD }, deps);
    expect(hasher.burnCalls).toBe(before + 1);
  });

  it('does not burn extra time when there is a real hash to check', async () => {
    // The real verify already costs the work; burning again would make a
    // registered address the *slow* one and leak just as much.
    const before = hasher.burnCalls;
    await login({ email: 'a@example.com', password: 'not the password' }, deps);
    expect(hasher.burnCalls).toBe(before);
  });
});

describe('refresh', () => {
  it('exchanges a token for a new pair', async () => {
    const first = await signIn();
    const result = await refresh(first.refreshToken, sessionDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.refreshToken).not.toBe(first.refreshToken);
    expect(result.value.accessToken).not.toBe(first.accessToken);
  });

  it('rejects the old token once it has been rotated', async () => {
    const first = await signIn();
    await refresh(first.refreshToken, sessionDeps());

    const again = await refresh(first.refreshToken, sessionDeps());
    expect(again.ok).toBe(false);
  });

  it('rejects a token that was never issued', async () => {
    const result = await refresh('never-issued', sessionDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.RefreshTokenInvalid);
  });

  it('rejects an expired token', async () => {
    const first = await signIn();
    clock.advance(REFRESH_TOKEN_TTL_MS + 1);

    const result = await refresh(first.refreshToken, sessionDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(IdentityErrorCode.RefreshTokenInvalid);
  });

  it('keeps a long-running session alive by re-dating the expiry', async () => {
    // Inheriting the original expiry would sign out an actively used session
    // thirty days after it began, however recently it was used.
    let pair = await signIn();
    for (let i = 0; i < 3; i += 1) {
      clock.advance(REFRESH_TOKEN_TTL_MS - 1000);
      const result = await refresh(pair.refreshToken, sessionDeps());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      pair = result.value;
    }
  });
});

/**
 * Refresh token reuse detection.
 *
 * Rotation alone limits a stolen token to the window before the real client
 * next refreshes. This is what makes the theft *visible*: a token that has
 * already been exchanged can only be presented again by someone replaying it.
 * There is no way to tell the thief from the victim, so the family goes.
 */
describe('refresh token reuse detection', () => {
  it('revokes the whole session when a spent token is replayed', async () => {
    const stolen = await signIn();

    // The real client refreshes, rotating the token the thief holds.
    const rotated = await refresh(stolen.refreshToken, sessionDeps());
    expect(rotated.ok).toBe(true);

    // The thief now replays the token they captured.
    const replay = await refresh(stolen.refreshToken, sessionDeps());
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error.code).toBe(IdentityErrorCode.SessionRevoked);

    // And the real client is signed out too — which is the point. Leaving it
    // working would leave the thief's next attempt working as well.
    if (!rotated.ok) return;
    const honest = await refresh(rotated.value.refreshToken, sessionDeps());
    expect(honest.ok).toBe(false);
    if (honest.ok) return;
    expect(honest.error.code).toBe(IdentityErrorCode.SessionRevoked);
  });

  it('leaves a different sign-in of the same user untouched', async () => {
    // Families are per sign-in, so a compromised phone must not sign the laptop
    // out — only the session that was actually replayed.
    const compromised = await signIn();
    const other = await signIn();

    await refresh(compromised.refreshToken, sessionDeps());
    await refresh(compromised.refreshToken, sessionDeps());

    const stillFine = await refresh(other.refreshToken, sessionDeps());
    expect(stillFine.ok).toBe(true);
  });
});

describe('logout', () => {
  it('ends the session so the token cannot be refreshed', async () => {
    const pair = await signIn();

    const result = await logout(pair.refreshToken, sessionDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revoked).toBe(1);

    const after = await refresh(pair.refreshToken, sessionDeps());
    expect(after.ok).toBe(false);
  });

  it('succeeds for a token that does not exist', async () => {
    // Reporting failure would make sign-out a way to probe which tokens exist,
    // and the caller is signed out either way.
    const result = await logout('never-issued', sessionDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.revoked).toBe(0);
  });

  it('is idempotent', async () => {
    const pair = await signIn();
    await logout(pair.refreshToken, sessionDeps());

    const second = await logout(pair.refreshToken, sessionDeps());
    expect(second.ok).toBe(true);
  });

  it('leaves other sessions signed in', async () => {
    const phone = await signIn();
    const laptop = await signIn();

    await logout(phone.refreshToken, sessionDeps());

    expect((await refresh(laptop.refreshToken, sessionDeps())).ok).toBe(true);
  });
});

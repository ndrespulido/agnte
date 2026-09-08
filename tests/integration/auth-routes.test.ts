import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import {
  handleForgotPassword,
  handleLogin,
  handleMe,
  handleLogout,
  handleRefresh,
  handleRegister,
  handleResetPassword,
  handleVerifyEmail,
} from '@/modules/identity';

/**
 * The routes end to end, against a real Postgres: validation, rate limiting,
 * idempotency, the console transport, and the verification round trip.
 *
 * Unit tests with fakes prove the rules; this proves the wiring — which is the
 * half that breaks when a header name or a status code is wrong, and the half
 * that would otherwise only be discovered from a phone.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_ENV = { ...process.env };

let emailed: string[] = [];

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://agnte.test/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

/** A fresh IP per test, so the 3/hour register limit does not leak between them. */
let ipCounter = 0;
const freshIp = () => `198.51.100.${(ipCounter += 1) % 250}`;

const register = (body: unknown, headers: Record<string, string> = {}) =>
  handleRegister(post(body, { 'x-forwarded-for': freshIp(), ...headers }));

const tokenFromLastEmail = (): string => {
  const printed = emailed.at(-1) ?? '';
  const match = printed.match(/verify-email\?token=([^\s]+)/);
  if (!match?.[1]) throw new Error(`no verification link in:\n${printed}`);
  return decodeURIComponent(match[1]);
};

const verify = (token: string) =>
  handleVerifyEmail(
    new Request(
      `https://agnte.test/v1/auth/verify-email?token=${encodeURIComponent(token)}`,
    ),
  );

const PASSWORD = 'a sufficiently long password';

describe.skipIf(!DATABASE_URL)('auth routes', () => {
  beforeEach(async () => {
    process.env.APP_ENV = 'local';
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
    delete process.env.APP_BASE_URL;
    resetConfigForTests();
    resetEmailTransportForTests();

    emailed = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      emailed.push(args.join(' '));
    });

    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity.password_reset_token');
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity.refresh_token');
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity.pending_registration');
    await getDatabase()!.$executeRawUnsafe('DELETE FROM identity."user"');
    await getDatabase()!.$executeRawUnsafe('DELETE FROM platform.rate_limit_window');
    await getDatabase()!.$executeRawUnsafe('DELETE FROM platform.idempotency_key');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetEmailTransportForTests();
  });

  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  it('registers, emails a link, and verifies it', async () => {
    const registered = await register({ email: 'a@example.com', password: PASSWORD });
    expect(registered.status).toBe(202);
    expect(await registered.json()).toMatchObject({ status: 'accepted' });

    const verified = await verify(tokenFromLastEmail());
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({
      status: 'verified',
      user: { email: 'a@example.com' },
    });
  });

  it('builds the link from the request origin when APP_BASE_URL is unset', async () => {
    await register({ email: 'a@example.com', password: PASSWORD });
    expect(emailed.at(-1)).toContain('https://agnte.test/v1/auth/verify-email?token=');
  });

  it('prefers a configured APP_BASE_URL over the request Host', async () => {
    // The reason this option exists: a forged Host would otherwise put an
    // attacker's domain into a link carrying the victim's token.
    process.env.APP_BASE_URL = 'https://agnte.example/';
    resetConfigForTests();

    await register({ email: 'a@example.com', password: PASSWORD });
    expect(emailed.at(-1)).toContain('https://agnte.example/v1/auth/verify-email?token=');
  });

  it('answers 202 identically for an address that already has an account', async () => {
    await register({ email: 'taken@example.com', password: PASSWORD });
    const first = await verify(tokenFromLastEmail());
    expect(first.status).toBe(200);

    const again = await register({
      email: 'taken@example.com',
      password: 'another password!!',
    });

    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ status: 'accepted' });
    expect(emailed.at(-1)).toContain('already exists');
  });

  it('rejects a short password with 422 and a machine-readable code', async () => {
    const response = await register({ email: 'a@example.com', password: 'short' });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'identity.password_too_short', details: { minimum: 12 } },
    });
  });

  it('rejects a body that is not JSON with 400', async () => {
    const response = await handleRegister(
      new Request('https://agnte.test/v1/auth/register', {
        method: 'POST',
        headers: { 'x-forwarded-for': freshIp() },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('enforces the 3/hour register limit per IP (§8.6)', async () => {
    const ip = freshIp();
    const attempt = (n: number) =>
      handleRegister(
        post(
          { email: `limit${n}@example.com`, password: PASSWORD },
          { 'x-forwarded-for': ip },
        ),
      );

    expect((await attempt(1)).status).toBe(202);
    expect((await attempt(2)).status).toBe(202);
    expect((await attempt(3)).status).toBe(202);

    const blocked = await attempt(4);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect(blocked.headers.get('ratelimit-limit')).toBe('3');
  });

  it('replays an idempotent retry instead of sending a second email', async () => {
    const ip = freshIp();
    const headers = { 'x-forwarded-for': ip, 'idempotency-key': 'retry-me' };
    const body = { email: 'idem@example.com', password: PASSWORD };

    const first = await handleRegister(post(body, headers));
    const sentAfterFirst = emailed.length;

    const second = await handleRegister(post(body, headers));

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.headers.get('idempotent-replay')).toBe('true');
    expect(emailed.length).toBe(sentAfterFirst);
  });

  it('refuses a reused idempotency key carrying a different request', async () => {
    const headers = { 'x-forwarded-for': freshIp(), 'idempotency-key': 'shared-key' };

    await handleRegister(post({ email: 'one@example.com', password: PASSWORD }, headers));
    const mismatch = await handleRegister(
      post({ email: 'two@example.com', password: PASSWORD }, headers),
    );

    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({
      error: { code: 'idempotency_key_reused' },
    });
  });

  it('rejects a verification link that was never issued', async () => {
    const response = await verify('never-issued-token');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'identity.verification_token_invalid' },
    });
  });

  it('rejects a second use of the same link', async () => {
    await register({ email: 'once@example.com', password: PASSWORD });
    const token = tokenFromLastEmail();

    expect((await verify(token)).status).toBe(200);
    expect((await verify(token)).status).toBe(400);
  });

  it('requires a token', async () => {
    const response = await handleVerifyEmail(
      new Request('https://agnte.test/v1/auth/verify-email'),
    );
    expect(response.status).toBe(400);
  });

  it('answers 503 rather than accepting a registration it cannot email', async () => {
    // A deployed environment with no transport. Accepting the registration
    // would leave someone waiting for a link that was never sent.
    process.env.APP_ENV = 'production';
    resetConfigForTests();
    resetEmailTransportForTests();

    const response = await register({ email: 'a@example.com', password: PASSWORD });
    expect(response.status).toBe(503);
  });

  it('never puts a raw token in the database', async () => {
    await register({ email: 'a@example.com', password: PASSWORD });
    const token = tokenFromLastEmail();

    const rows = await getDatabase()!.$queryRawUnsafe<Record<string, unknown>[]>(
      'SELECT * FROM identity.pending_registration',
    );
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  // ---- sessions (task 1.4) -------------------------------------------------

  const jsonPost = (
    handler: (request: Request) => Promise<Response>,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(`https://agnte.test${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': freshIp(),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );

  /** Register, verify, and sign in — the whole path a real client walks. */
  const signUpAndIn = async (email = 'user@example.com') => {
    await register({ email, password: PASSWORD });
    await verify(tokenFromLastEmail());

    const response = await jsonPost(handleLogin, '/v1/auth/login', {
      email,
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { accessToken: string; refreshToken: string };
  };

  it('signs in after verification and returns a usable token pair', async () => {
    const pair = await signUpAndIn();

    expect(pair.accessToken.split('.')).toHaveLength(3);
    expect(pair.refreshToken).toBeTruthy();
  });

  it('refuses to sign in before the address is verified', async () => {
    // There is no account yet — verification is what creates it — so this is
    // the ordinary invalid-credentials path, not a special case.
    await register({ email: 'unverified@example.com', password: PASSWORD });

    const response = await jsonPost(handleLogin, '/v1/auth/login', {
      email: 'unverified@example.com',
      password: PASSWORD,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'identity.invalid_credentials' },
    });
  });

  it('answers a wrong password and an unknown address identically', async () => {
    await signUpAndIn('real@example.com');

    const wrong = await jsonPost(handleLogin, '/v1/auth/login', {
      email: 'real@example.com',
      password: 'not the right password',
    });
    const unknown = await jsonPost(handleLogin, '/v1/auth/login', {
      email: 'nobody@example.com',
      password: PASSWORD,
    });

    expect(wrong.status).toBe(unknown.status);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it('enforces the 5 per 15 minutes login limit (§8.6)', async () => {
    const ip = freshIp();
    const attempt = () =>
      handleLogin(
        new Request('https://agnte.test/v1/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
          body: JSON.stringify({
            email: 'limited@example.com',
            password: 'wrong password here',
          }),
        }),
      );

    for (let i = 0; i < 5; i += 1) expect((await attempt()).status).toBe(401);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('ratelimit-limit')).toBe('5');
  });

  it('refreshes into a new pair and retires the old refresh token', async () => {
    const pair = await signUpAndIn();

    const refreshed = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
    });
    expect(refreshed.status).toBe(200);

    const next = (await refreshed.json()) as { refreshToken: string };
    expect(next.refreshToken).not.toBe(pair.refreshToken);

    const reused = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
    });
    expect(reused.status).toBe(401);
  });

  it('kills the session when a spent refresh token is replayed', async () => {
    const pair = await signUpAndIn();

    const refreshed = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
    });
    const next = (await refreshed.json()) as { refreshToken: string };

    // The replay.
    const replay = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
    });
    expect(await replay.json()).toMatchObject({
      error: { code: 'identity.session_revoked' },
    });

    // And the honest client is signed out too, which is the point.
    const honest = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: next.refreshToken,
    });
    expect(honest.status).toBe(401);
  });

  it('signs out, and the refresh token stops working', async () => {
    const pair = await signUpAndIn();

    const out = await jsonPost(handleLogout, '/v1/auth/logout', {
      refreshToken: pair.refreshToken,
    });
    expect(out.status).toBe(204);

    const after = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
    });
    expect(after.status).toBe(401);
  });

  it('answers sign-out with 204 for a token that never existed', async () => {
    const out = await jsonPost(handleLogout, '/v1/auth/logout', {
      refreshToken: 'nonsense',
    });
    expect(out.status).toBe(204);
  });

  it('answers 503 rather than signing tokens with a key that will not survive', async () => {
    process.env.APP_ENV = 'production';
    resetConfigForTests();
    resetEmailTransportForTests();

    const response = await jsonPost(handleLogin, '/v1/auth/login', {
      email: 'a@example.com',
      password: PASSWORD,
    });
    expect(response.status).toBe(503);
  });

  // ---- password reset (task 1.5) -------------------------------------------

  const resetLinkToken = (): string => {
    const printed = emailed.at(-1) ?? '';
    const match = printed.match(/reset-password\?token=([^\s]+)/);
    if (!match?.[1]) throw new Error(`no reset link in:\n${printed}`);
    return decodeURIComponent(match[1]);
  };

  const requestReset = async (email: string) => {
    const response = await jsonPost(handleForgotPassword, '/v1/auth/forgot-password', {
      email,
    });
    expect(response.status).toBe(202);
    return resetLinkToken();
  };

  it('resets a password and signs the new one in', async () => {
    await signUpAndIn('reset@example.com');
    const token = await requestReset('reset@example.com');

    const done = await jsonPost(handleResetPassword, '/v1/auth/reset-password', {
      token,
      password: 'a brand new long password',
    });
    expect(done.status).toBe(200);

    const before = await jsonPost(handleLogin, '/v1/auth/login', {
      email: 'reset@example.com',
      password: PASSWORD,
    });
    expect(before.status).toBe(401);

    const after = await jsonPost(handleLogin, '/v1/auth/login', {
      email: 'reset@example.com',
      password: 'a brand new long password',
    });
    expect(after.status).toBe(200);
  });

  it('signs every existing session out and says how many', async () => {
    const pair = await signUpAndIn('kick@example.com');
    const token = await requestReset('kick@example.com');

    const done = await jsonPost(handleResetPassword, '/v1/auth/reset-password', {
      token,
      password: 'a brand new long password',
    });
    expect(await done.json()).toMatchObject({ status: 'reset', sessionsRevoked: 1 });

    const stale = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
    });
    expect(stale.status).toBe(401);
  });

  it('answers 202 identically for an address with no account', async () => {
    await signUpAndIn('known@example.com');

    const known = await jsonPost(handleForgotPassword, '/v1/auth/forgot-password', {
      email: 'known@example.com',
    });
    const unknown = await jsonPost(handleForgotPassword, '/v1/auth/forgot-password', {
      email: 'nobody@example.com',
    });

    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
    // And an email went to both, so silence is not the tell either.
    expect(emailed.at(-1)).toContain('no account here');
  });

  it('refuses a spent reset link with 410', async () => {
    await signUpAndIn('once@example.com');
    const token = await requestReset('once@example.com');

    await jsonPost(handleResetPassword, '/v1/auth/reset-password', {
      token,
      password: 'a brand new long password',
    });

    const again = await jsonPost(handleResetPassword, '/v1/auth/reset-password', {
      token,
      password: 'yet another long password',
    });
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({
      error: { code: 'identity.reset_token_already_used' },
    });
  });

  it('refuses a reset link that never existed with 400', async () => {
    const response = await jsonPost(handleResetPassword, '/v1/auth/reset-password', {
      token: 'never-issued',
      password: 'a brand new long password',
    });
    expect(response.status).toBe(400);
  });

  it('does not burn the link when the new password breaks policy', async () => {
    await signUpAndIn('typo@example.com');
    const token = await requestReset('typo@example.com');

    const rejected = await jsonPost(handleResetPassword, '/v1/auth/reset-password', {
      token,
      password: 'short',
    });
    expect(rejected.status).toBe(422);

    const retried = await jsonPost(handleResetPassword, '/v1/auth/reset-password', {
      token,
      password: 'a brand new long password',
    });
    expect(retried.status).toBe(200);
  });

  it('enforces the 3/hour forgot-password limit per email (§8.6)', async () => {
    const email = 'limited-reset@example.com';
    const attempt = () =>
      jsonPost(handleForgotPassword, '/v1/auth/forgot-password', { email });

    for (let i = 0; i < 3; i += 1) expect((await attempt()).status).toBe(202);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('ratelimit-limit')).toBe('3');
  });

  // ---- /v1/me and the route guard (task 1.7) -------------------------------

  const me = (headers: Record<string, string> = {}) =>
    handleMe(new Request('https://agnte.test/v1/me', { headers }));

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it('returns the signed-in user', async () => {
    const pair = await signUpAndIn('me@example.com');

    const response = await me(bearer(pair.accessToken));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      email: 'me@example.com',
      displayName: null,
    });
  });

  it('returns only the fields it means to', async () => {
    // A response that starts as "the user record" grows into one, and the first
    // field nobody meant to publish arrives without a decision being made.
    const pair = await signUpAndIn('shape@example.com');

    const body = (await (await me(bearer(pair.accessToken))).json()) as Record<
      string,
      unknown
    >;

    expect(Object.keys(body).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'emailVerifiedAt',
      'id',
    ]);
    expect(JSON.stringify(body)).not.toContain('argon2');
  });

  it('refuses a request with no Authorization header', async () => {
    const response = await me();

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it.each([
    ['not a bearer token', { authorization: 'nonsense' }],
    ['a different scheme', { authorization: 'Basic abc' }],
    ['an empty bearer token', { authorization: 'Bearer ' }],
    ['a token that is not a JWT', { authorization: 'Bearer not.a.jwt' }],
  ])('refuses %s', async (_label, headers) => {
    expect((await me(headers)).status).toBe(401);
  });

  it('accepts the scheme case-insensitively, per RFC 7235', async () => {
    const pair = await signUpAndIn('case@example.com');

    expect((await me({ authorization: `bearer ${pair.accessToken}` })).status).toBe(200);
  });

  it('parses the header the way RFC 7235 defines it', async () => {
    // These distinguish a correct parse from a permissive one. Every malformed
    // case below is rejected anyway once the token fails to verify, so only a
    // *valid* token separated the wrong way shows the difference — which is why
    // the accepted case uses two spaces (`1*SP` allows them) and the rejected
    // ones use a tab and an embedded space.
    const pair = await signUpAndIn('rfc@example.com');
    const token = pair.accessToken;

    expect((await me({ authorization: `Bearer  ${token}` })).status).toBe(200);
    expect((await me({ authorization: `Bearer\t${token}` })).status).toBe(401);
    expect((await me({ authorization: `Bearer ${token} extra` })).status).toBe(401);
  });

  it('refuses a refresh token presented as an access token', async () => {
    // Different credentials for different jobs. The `typ` claim is what stops
    // one being accepted for the other, and a refresh token is not a JWT at
    // all — so this also covers the shape check.
    const pair = await signUpAndIn('mixup@example.com');

    expect((await me(bearer(pair.refreshToken))).status).toBe(401);
  });

  it('refuses a valid token whose account has since been deleted', async () => {
    // The reason the guard reads the database rather than trusting the token's
    // subject: a JWT outlives its user, and erasure (§8.7) has to take effect
    // now, not in fifteen minutes.
    const pair = await signUpAndIn('gone@example.com');
    expect((await me(bearer(pair.accessToken))).status).toBe(200);

    await getDatabase()!.$executeRawUnsafe(
      `DELETE FROM identity."user" WHERE email = 'gone@example.com'`,
    );

    expect((await me(bearer(pair.accessToken))).status).toBe(401);
  });

  it('keeps working after the refresh token rotates', async () => {
    const pair = await signUpAndIn('rotate@example.com');

    const refreshed = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
    });
    const next = (await refreshed.json()) as { accessToken: string };

    expect((await me(bearer(next.accessToken))).status).toBe(200);
  });

  it('stops working once the password is reset and sessions are revoked', async () => {
    // Honest about the window: the *access* token stays valid until it expires,
    // which is the trade for not hitting the database on every request. What a
    // reset revokes is the refresh side, so the session cannot be extended.
    const pair = await signUpAndIn('revoked@example.com');
    const token = await requestReset('revoked@example.com');

    await jsonPost(handleResetPassword, '/v1/auth/reset-password', {
      token,
      password: 'a brand new long password',
    });

    // Still valid — it has not expired yet.
    expect((await me(bearer(pair.accessToken))).status).toBe(200);
    // But the session cannot be renewed.
    const renew = await jsonPost(handleRefresh, '/v1/auth/refresh', {
      refreshToken: pair.refreshToken,
    });
    expect(renew.status).toBe(401);
  });

  it('answers 502 and names the failure when the email cannot be sent', async () => {
    // This reached production as a bare 500: indistinguishable from a crash,
    // with the actual reason — Resend refusing a From address on a domain the
    // account cannot send from — only in the container logs. A registering user
    // saw a blank failure and no way to tell a misconfiguration from a bug.
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'nobody@unverified.example';
    resetConfigForTests();
    resetEmailTransportForTests();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"The unverified.example domain is not verified"}', {
        status: 403,
      }),
    );

    const response = await register({ email: 'blocked@example.com', password: PASSWORD });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'email_send_failed' } });
  });

  it('does not leak the provider’s message to the caller', async () => {
    // The provider's text is written for us, not for whoever is signing up, and
    // it can name internal configuration.
    process.env.RESEND_API_KEY = 're_test_key';
    process.env.EMAIL_FROM = 'nobody@unverified.example';
    resetConfigForTests();
    resetEmailTransportForTests();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"The unverified.example domain is not verified"}', {
        status: 403,
      }),
    );

    const body = await (
      await register({ email: 'quiet@example.com', password: PASSWORD })
    ).text();

    expect(body).not.toContain('unverified.example');
    expect(body).not.toContain('not verified');
  });
});

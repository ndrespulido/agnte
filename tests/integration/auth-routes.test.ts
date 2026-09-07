import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabase } from '@/shared/infra/database';
import { resetConfigForTests } from '@/shared/infra/config';
import { resetEmailTransportForTests } from '@/shared/infra/email';
import { handleRegister, handleVerifyEmail } from '@/modules/identity';

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
});

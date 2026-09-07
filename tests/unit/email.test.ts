import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import {
  ConsoleEmailTransport,
  ResendEmailTransport,
  getEmailTransport,
  resetEmailTransportForTests,
} from '@/shared/infra/email';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  resetConfigForTests();
  resetEmailTransportForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetConfigForTests();
  resetEmailTransportForTests();
  vi.restoreAllMocks();
});

const setEnv = (values: Record<string, string | undefined>) => {
  for (const key of ['RESEND_API_KEY', 'EMAIL_FROM', 'APP_ENV']) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
};

describe('transport selection', () => {
  it('uses the console locally with nothing configured', () => {
    setEnv({ APP_ENV: 'local' });
    expect(getEmailTransport()?.description).toBe('console');
  });

  it('uses Resend when configured, even locally', () => {
    setEnv({ APP_ENV: 'local', RESEND_API_KEY: 're_test', EMAIL_FROM: 'a@b.com' });
    expect(getEmailTransport()?.description).toBe('resend');
  });

  it('reports nothing in a deployed environment with no email configured', () => {
    // Falling back to the console here would silently swallow every
    // verification email in production, and the status page would say fine.
    setEnv({ APP_ENV: 'production' });
    expect(getEmailTransport()).toBeUndefined();
  });

  it('rejects half-configured email rather than silently disabling it', () => {
    setEnv({ APP_ENV: 'production', RESEND_API_KEY: 're_test' });
    expect(() => getEmailTransport()).toThrow(/partially configured.*EMAIL_FROM/s);
  });
});

describe('ResendEmailTransport', () => {
  const message = { to: 'a@example.com', subject: 'Hi', text: 'Body' };

  it('posts the message to Resend with the API key', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    await new ResendEmailTransport('re_key', 'Agnte <no-reply@agnte.test>').send(message);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer re_key');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'Agnte <no-reply@agnte.test>',
      to: ['a@example.com'],
      subject: 'Hi',
      text: 'Body',
    });
  });

  it('throws with Resend’s reason when the send is rejected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"message":"domain is not verified"}', { status: 403 }),
    );

    await expect(
      new ResendEmailTransport('re_key', 'a@b.com').send(message),
    ).rejects.toThrow(/403.*domain is not verified/s);
  });

  it('keeps the recipient out of the error, because errors reach logs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500 }),
    );

    // Asserted on the caught message rather than through `rejects.toThrow`:
    // an asymmetric matcher passed to toThrow is ignored, so the negative
    // version of this test passed happily while the address *was* in the
    // message. Catching it makes the assertion real.
    let caught: unknown;
    try {
      await new ResendEmailTransport('re_key', 'a@b.com').send({
        ...message,
        to: 'private-person@example.com',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('500');
    expect((caught as Error).message).not.toContain('private-person');
  });
});

describe('ConsoleEmailTransport', () => {
  it('prints the message so a local verification link can be clicked', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await new ConsoleEmailTransport().send({
      to: 'a@example.com',
      subject: 'Confirm',
      text: 'https://localhost:3000/verify?token=abc',
    });

    const printed = info.mock.calls.flat().join('\n');
    expect(printed).toContain('a@example.com');
    expect(printed).toContain('https://localhost:3000/verify?token=abc');
  });
});

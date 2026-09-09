import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { config, proxy } from '@/proxy';

/**
 * The CSP is the app's defence against session theft, because the refresh token
 * lives in localStorage where any script on the page can read it. A policy that
 * quietly loses its teeth — an `'unsafe-inline'` added to unblock something, a
 * nonce that stops varying — would look identical from the outside.
 *
 * The policy was also driven in a real browser against a production build: the
 * app renders with no violations, and removing the nonce makes it render
 * nothing. These tests are what keep that true without a browser.
 */
const request = (path = '/') => new NextRequest(new URL(path, 'https://agnte.test'));

const policyOf = (path = '/'): string =>
  proxy(request(path)).headers.get('content-security-policy') ?? '';

const directive = (policy: string, name: string): string =>
  policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `)) ?? '';

describe('the content security policy', () => {
  it('is sent on the response', () => {
    expect(policyOf()).toContain("default-src 'self'");
  });

  it('carries a nonce that changes on every request', () => {
    // A fixed nonce is the same as no nonce: an attacker who can read one page
    // can reuse it. This is the property the whole scheme rests on.
    const first = policyOf();
    const second = policyOf();

    expect(first).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    expect(first).not.toBe(second);
  });

  it('never allows inline script', () => {
    // The one directive that matters here. `unsafe-inline` on script-src
    // permits exactly the injected script that would read the refresh token,
    // which would make this header decoration rather than protection.
    expect(directive(policyOf(), 'script-src')).not.toContain('unsafe-inline');
  });

  it('does not allow eval outside development', () => {
    // React uses eval only in its development build.
    expect(directive(policyOf(), 'script-src')).not.toContain('unsafe-eval');
  });

  it('refuses to be framed, and forbids plugins and base tag rewriting', () => {
    const policy = policyOf();
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
  });

  it('restricts where the app may connect to', () => {
    // With no object storage configured — local development — the client
    // talks only to its own API.
    expect(directive(policyOf(), 'connect-src')).toBe("connect-src 'self'");
  });

  it('allows the images the app actually uses and no origin beyond itself', () => {
    const images = directive(policyOf(), 'img-src');
    expect(images).toContain("'self'");
    expect(images).toContain('data:');
    expect(images).toContain('blob:');
    expect(images).not.toMatch(/https?:\/\//);
  });
});

/**
 * Media is the one thing the browser fetches from somewhere other than this
 * app: it PUTs an upload straight to object storage and loads every thumbnail
 * from there (architecture.md §8.3 — bytes never pass through the app
 * server). That makes these two directives load-bearing in exactly one
 * direction: too narrow and the whole media feature breaks in production
 * while working perfectly in development, which is the failure that costs a
 * deploy cycle to notice.
 */
describe('the media origin in the policy', () => {
  const ORIGINAL = process.env.R2_ENDPOINT;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.R2_ENDPOINT;
    else process.env.R2_ENDPOINT = ORIGINAL;
  });

  it('lets the browser reach configured object storage, for uploads and thumbnails', () => {
    process.env.R2_ENDPOINT = 'https://abc123.r2.cloudflarestorage.com';
    const policy = policyOf();

    expect(directive(policy, 'connect-src')).toBe(
      "connect-src 'self' https://abc123.r2.cloudflarestorage.com",
    );
    expect(directive(policy, 'img-src')).toContain(
      'https://abc123.r2.cloudflarestorage.com',
    );
  });

  it('names the origin only, never a path from the endpoint', () => {
    // R2_ENDPOINT can legitimately carry a path; a CSP source is an origin.
    process.env.R2_ENDPOINT = 'https://abc123.r2.cloudflarestorage.com/bucket';
    expect(directive(policyOf(), 'connect-src')).toBe(
      "connect-src 'self' https://abc123.r2.cloudflarestorage.com",
    );
  });

  it('ignores a value that is not a usable http origin rather than splicing it in', () => {
    // A CSP is a string built by concatenation, so anything reaching it from
    // configuration has to be parsed first — otherwise a value containing a
    // semicolon could append directives of its own choosing.
    for (const bad of [
      'not a url',
      'javascript:alert(1)',
      'https://x.test; script-src *',
    ]) {
      process.env.R2_ENDPOINT = bad;
      const policy = policyOf();
      expect(directive(policy, 'connect-src')).toBe("connect-src 'self'");
      expect(directive(policy, 'script-src')).not.toContain('*');
    }
  });
});

describe('the other security headers', () => {
  it('are all set', () => {
    const headers = proxy(request()).headers;
    expect(headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('permissions-policy')).toContain('camera=()');
  });
});

describe('the matcher', () => {
  /**
   * Built from the source the config actually declares, rather than restated —
   * a test that hard-codes its own regex proves the test author's intent, not
   * the shipped behaviour.
   */
  const source = config.matcher[0]?.source ?? '';
  const pattern = new RegExp(`^${source}$`);

  it('covers the pages', () => {
    expect(pattern.test('/')).toBe(true);
    expect(pattern.test('/status')).toBe(true);
  });

  it('skips the API, which serves JSON to fetch and to a future native client', () => {
    expect(pattern.test('/v1/health')).toBe(false);
    expect(pattern.test('/v1/auth/login')).toBe(false);
  });

  it("skips Next's own static output", () => {
    expect(pattern.test('/_next/static/chunk.js')).toBe(false);
  });
});

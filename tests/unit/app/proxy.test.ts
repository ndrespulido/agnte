import { describe, expect, it } from 'vitest';
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
    // The client talks only to its own API. When media lands, R2 has to be
    // added here — and the failure will be a visible broken image rather than
    // a silent exfiltration channel.
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

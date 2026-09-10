import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script, no types
import { createHandler } from '../../infra/domain-proxy/server.mjs';

/**
 * Drives real HTTP requests through the actual proxy handler against a real
 * local origin server — not a mock of `https.request`, which would only
 * prove the right method was called. `protocol: http` (Node's real client,
 * not a stand-in) is what makes this possible without a certificate; see
 * server.mjs's own comment on `createHandler` for why that swap is faithful
 * to the production code path.
 */
const ORIGIN_PORT = 4573;
const PROXY_PORT = 4574;

let origin: http.Server;
let proxy: http.Server;
let received:
  | { headers: http.IncomingHttpHeaders; method: string | undefined; body: string }
  | undefined;

beforeAll(async () => {
  origin = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received = { headers: req.headers, method: req.method, body };
      if (req.url === '/boom') {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-from-origin': 'yes' });
      res.end(`echo:${req.url}`);
    });
  });
  await new Promise<void>((resolve) => origin.listen(ORIGIN_PORT, resolve));

  const handler = createHandler({
    hostname: '127.0.0.1',
    port: ORIGIN_PORT,
    protocol: http,
  });
  proxy = http.createServer(handler);
  await new Promise<void>((resolve) => proxy.listen(PROXY_PORT, resolve));
});

afterAll(async () => {
  await new Promise((resolve) => origin.close(resolve));
  await new Promise((resolve) => proxy.close(resolve));
});

const proxyUrl = (path: string) =>
  `http://127.0.0.1:${(proxy.address() as AddressInfo).port}${path}`;

describe('domain-proxy', () => {
  it('overrides Host to the real origin, so Cloud Run routes the request instead of 404ing', async () => {
    await fetch(proxyUrl('/v1/health'), { headers: { host: 'agnte.app' } });
    // 4573 is not http's default port, so RFC 7230 requires it in the Host
    // header — proving createHandler's port-awareness, not just the override.
    expect(received?.headers.host).toBe('127.0.0.1:4573');
  });

  it('forwards every other header unchanged, x-forwarded-for included', async () => {
    await fetch(proxyUrl('/v1/timeline'), {
      headers: {
        'x-forwarded-for': '203.0.113.7, 198.51.100.1',
        authorization: 'Bearer abc',
      },
    });
    expect(received?.headers['x-forwarded-for']).toBe('203.0.113.7, 198.51.100.1');
    expect(received?.headers.authorization).toBe('Bearer abc');
  });

  it('streams the method, path, and body through to the origin', async () => {
    await fetch(proxyUrl('/v1/verses'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xp: 'a plain verse' }),
    });
    expect(received?.method).toBe('POST');
    expect(received?.body).toBe('{"xp":"a plain verse"}');
  });

  it('streams the response status, headers, and body straight back', async () => {
    const response = await fetch(proxyUrl('/v1/tags'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-from-origin')).toBe('yes');
    expect(await response.text()).toBe('echo:/v1/tags');
  });

  it('answers 502 rather than hanging when the origin drops the connection', async () => {
    const response = await fetch(proxyUrl('/boom'));
    expect(response.status).toBe(502);
  });
});

/**
 * A thin reverse proxy, deployed only to satisfy Cloud Run Domain Mapping's
 * region restriction (docs/operations.md §2k).
 *
 * Domain Mapping only accepts a small, historical list of regions.
 * `europe-west3` — where the real service runs, chosen to sit near the Neon
 * database (architecture.md) — is not one of them, and `gcloud` says so
 * plainly rather than routing around it: creating a mapping against a
 * service outside that list fails with "Route <service> does not exist".
 * Moving the whole app to a supported region would trade database latency on
 * every single request for a one-time domain-setup convenience; this proxy
 * trades one fixed extra hop on every request instead, which is the cheaper
 * side of that trade.
 *
 * It has no logic of its own beyond that hop: forward the method, headers,
 * and body to the real service, correct only the `Host` header, and stream
 * the response straight back. `Host` is the one thing that has to change —
 * it is what Cloud Run's own routing keys on (the same fact that broke the
 * Cloudflare-only approach this replaced: a request arriving with any other
 * Host gets Google's generic 404, not this app's).
 *
 * Every other header passes through untouched, `x-forwarded-for` included —
 * on purpose. `clientIp()` (src/shared/infra/http.ts) reads the *first*
 * entry of that header for rate limiting, and this hop only ever appends
 * (Cloud Run's own ingress does the appending on the way into the real
 * service, the same as it always did for the single-hop setup); the
 * original client's entry, and so the rate-limit bucket a request lands in,
 * survives the extra hop unchanged as long as this proxy does not touch it.
 *
 * Deliberately zero npm dependencies. Node's built-in `http`/`https` already
 * do everything a byte-forwarder needs, and a service whose entire job is to
 * move bytes has no business carrying a dependency tree of its own to keep
 * patched.
 */
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';

/**
 * Builds the request handler. `protocol` is Node's `https` module in
 * production and `http` in tests — the two share an identical `request()`
 * signature, so swapping it is how the real proxying logic gets exercised
 * against a local, TLS-free stand-in origin without faking a certificate.
 */
export function createHandler({ hostname, port = 443, protocol = https }) {
  // A Host header carries the port only when it isn't the scheme's default
  // (RFC 7230) — production is always https on 443, where the bare hostname
  // is correct, but the handler accepts any port (tests use a plain-HTTP
  // stand-in origin on a non-default one), so this has to actually check
  // rather than assume.
  const defaultPort = protocol === https ? 443 : 80;
  const host = port === defaultPort ? hostname : `${hostname}:${port}`;

  return function handleRequest(req, res) {
    const headers = { ...req.headers, host };
    // Hop-by-hop, meaningless (and sometimes rejected) on a fresh outbound
    // connection to a different server than the one the client actually
    // asked to keep alive.
    delete headers.connection;

    const upstream = protocol.request(
      { hostname, port, path: req.url, method: req.method, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on('error', (error) => {
      console.error('upstream request failed:', error.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Bad gateway');
    });

    req.pipe(upstream);
  };
}

function main() {
  const ORIGIN_HOST = process.env.ORIGIN_HOST;
  if (!ORIGIN_HOST) {
    console.error('ORIGIN_HOST is required — the real service this forwards to.');
    process.exit(1);
  }

  const PORT = process.env.PORT ?? 8080;
  const handler = createHandler({ hostname: ORIGIN_HOST });

  http.createServer(handler).listen(PORT, () => {
    console.log(`domain-proxy listening on :${PORT}, forwarding to ${ORIGIN_HOST}`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

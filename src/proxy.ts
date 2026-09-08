import { NextResponse, type NextRequest } from 'next/server';

/**
 * Security headers, and a nonce-based Content-Security-Policy.
 *
 * `proxy.ts`, not `middleware.ts`: the file convention was renamed in Next 16
 * and the old name is deprecated. It defaults to the Node runtime, which is
 * what the standalone server on Cloud Run runs.
 *
 * ---------------------------------------------------------------------------
 * Why a nonce, and not `'unsafe-inline'`.
 *
 * The web client keeps its refresh token in localStorage, which is readable by
 * any script that runs on the page. That was a deliberate choice — the API is
 * bearer-token based because a native app is planned — and what follows from it
 * is that the app's defence against session theft *is* not having XSS. A CSP
 * with `script-src 'unsafe-inline'` allows exactly the injected script that
 * would read the token, so it would be a header that looks like protection
 * and is not.
 *
 * The cost is real and worth stating: nonces force every page to be
 * dynamically rendered, because a nonce has to be minted per request and a
 * statically generated page is built before any request exists. Both pages here
 * are dynamic anyway — the app is a client shell and the status page reports
 * live checks — so this costs nothing today. It does mean a future page cannot
 * be statically cached without revisiting this.
 * ---------------------------------------------------------------------------
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  const policy = [
    "default-src 'self'",

    // `strict-dynamic` is hardening, not a requirement: the app was driven in a
    // browser without it and nothing broke, because Next serves its chunks from
    // 'self' and tags its inline scripts with the nonce. It earns its place
    // anyway — with it, `'self'` stops being a blanket permit, so a script
    // injected as <script src="/uploads/evil.js"> would not run.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,

    // React's dev build uses eval to rebuild server stack traces; production
    // does not, so `unsafe-eval` is strictly a development allowance.
    //
    // Styles get the nonce in production. In development Next injects styles
    // through a path that does not carry one, and refusing them there would
    // mean developing against an unstyled page.
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,

    // data: for the SVG icon and any inlined asset; blob: for images the
    // browser builds locally, which the planned client-side downscale before
    // upload (§8.3) will produce.
    "img-src 'self' blob: data:",

    "font-src 'self'",

    // The app talks only to its own API. When media lands, R2 or the Cloudflare
    // hostname in front of it has to be added here — and the failure will be
    // loud rather than silent, which is the point of listing it.
    "connect-src 'self'",

    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",

    // Clickjacking. `frame-ancestors` is the modern replacement for
    // X-Frame-Options and is not overridden by it.
    "frame-ancestors 'none'",

    // The manifest, so the PWA install works.
    "manifest-src 'self'",

    // No mixed content. Harmless locally, where everything is already http.
    'upgrade-insecure-requests',
  ].join('; ');

  // Next reads the nonce back out of this header during server rendering and
  // attaches it to its own scripts and styles, so nothing here has to be tagged
  // by hand.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  response.headers.set('Content-Security-Policy', policy);

  // The rest of the set, which are one line each and all obviously right.
  //
  // `Referrer-Policy`: a verse id in a path should not travel to another origin
  // in a Referer header.
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('x-content-type-options', 'nosniff');
  // Nothing here uses a camera, a microphone or geolocation. Saying so stops a
  // future dependency from quietly asking.
  response.headers.set(
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next's own static output and the API.
     *
     * `/v1/*` is excluded deliberately: those responses are JSON consumed by
     * fetch and by a future native client, and a document policy has nothing to
     * say about them. Prefetches are excluded because they render no document —
     * they would only mint nonces nobody uses.
     */
    {
      source: '/((?!v1|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

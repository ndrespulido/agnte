import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle under .next/standalone, which keeps the
  // production container small. The image is built only in CI (see docs/operations.md);
  // nothing in local development requires Docker.
  output: 'standalone',

  // Cloud Run terminates TLS and sets X-Forwarded-*; without this Next will not
  // trust those headers when constructing absolute URLs.
  poweredByHeader: false,

  /**
   * `@google-cloud/tasks` is required at runtime rather than bundled.
   *
   * It reaches protobuf definitions through dynamic requires that a bundler
   * cannot follow, and the failure is not subtle: the module throws "Cannot
   * find module as expression is too dynamic" at *import* time, which takes
   * down every route that transitively imports the media module — the whole
   * timeline, not just the deferred-jobs path that actually needs Cloud Tasks.
   *
   * `sharp` needs no entry here: Next already ships it in the default
   * opt-out list (see next/dist/docs .../serverExternalPackages.md). This
   * package is not on that list.
   */
  serverExternalPackages: ['@google-cloud/tasks'],

  /**
   * The app moved from /timeline to the root, and the status page from the root
   * to /status.
   *
   * /timeline is redirected rather than deleted: it is the URL that was handed
   * out while the app lived there, and a permanent redirect costs one line
   * where a 404 costs someone a puzzled minute. Permanent rather than
   * temporary because the move is not going to be reversed — which also means
   * browsers will cache it, so it must not be used for a path that might come
   * back.
   */
  async redirects() {
    return [{ source: '/timeline', destination: '/', permanent: true }];
  },
};

export default nextConfig;

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits a self-contained server bundle under .next/standalone, which keeps the
  // production container small. The image is built only in CI (see docs/operations.md);
  // nothing in local development requires Docker.
  output: 'standalone',

  // Cloud Run terminates TLS and sets X-Forwarded-*; without this Next will not
  // trust those headers when constructing absolute URLs.
  poweredByHeader: false,
};

export default nextConfig;

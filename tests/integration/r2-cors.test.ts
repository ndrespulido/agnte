import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';
import S3rver from 's3rver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain ESM script, no types
import { corsConfiguration, previewOriginPattern } from '../../infra/set-r2-cors.mjs';

/**
 * Reproduces the exact failure a browser hit against a real bucket —
 * "blocked by CORS policy: ... No 'Access-Control-Allow-Origin' header" —
 * against a real S3-compatible server, and proves `set-r2-cors.mjs` fixes it.
 *
 * s3rver implements the same preflight handling S3 and R2 do (see
 * node_modules/s3rver/lib/middleware/cors.js): OPTIONS against a bucket with
 * no CORS rule is rejected outright, and a rule's AllowedOrigins is matched
 * with the same single-wildcard semantics this script relies on for preview
 * URLs. A mocked S3Client would only prove which command was sent — this
 * proves the browser's actual preflight request succeeds or fails, which is
 * the part that broke.
 *
 * `@aws-sdk/client-s3` never issues the OPTIONS itself — only a browser does
 * that, automatically, before a non-simple cross-origin request. So this uses
 * plain `fetch`, standing in for the browser exactly as
 * src/app/_client/api.ts's own upload call does.
 */
const BUCKET = 'agnte-media-cors-test';
const PORT = 4572;
const ORIGIN_URL = `http://127.0.0.1:${PORT}`;

let server: S3rver;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 's3rver-cors-'));
  server = new S3rver({
    port: PORT,
    address: '127.0.0.1',
    silent: true,
    directory,
    configureBuckets: [{ name: BUCKET, configs: [] }],
  });
  await server.run();
}, 30_000);

afterAll(async () => {
  await server.close();
  await rm(directory, { recursive: true, force: true });
});

const client = () =>
  new S3Client({
    region: 'auto',
    endpoint: ORIGIN_URL,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' },
  });

/** What a browser sends before a cross-origin PUT with a `content-type`
 * header — the exact preflight src/app/_client/api.ts's `uploadImage`
 * triggers. */
const preflight = (origin: string) =>
  fetch(`${ORIGIN_URL}/${BUCKET}/media/owner-1/m1/original.jpg`, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'content-type',
    },
  });

describe('corsConfiguration', () => {
  it('rejects an empty origin list rather than silently allowing nothing', () => {
    expect(() => corsConfiguration([])).toThrow();
  });

  it('allows only PUT, and only the header the upload actually sends', () => {
    const [rule] = corsConfiguration(['https://agnte.example']).CORSRules;
    expect(rule.AllowedMethods).toEqual(['PUT']);
    expect(rule.AllowedHeaders).toEqual(['content-type']);
  });
});

describe('previewOriginPattern', () => {
  it('wildcards the tag Cloud Run prepends, matching every pull request', () => {
    expect(previewOriginPattern('https://agnte-preview-lddzhm2pxa-ey.a.run.app')).toBe(
      'https://*---agnte-preview-lddzhm2pxa-ey.a.run.app',
    );
  });
});

describe('a bucket with no CORS rule', () => {
  it('rejects the preflight — this is the bug the user hit', async () => {
    const response = await preflight('https://agnte-lddzhm2pxa-ey.a.run.app');
    expect(response.ok).toBe(false);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('after set-r2-cors applies its rule', () => {
  const PROD = 'https://agnte-lddzhm2pxa-ey.a.run.app';
  const PREVIEW_BASE = 'https://agnte-preview-lddzhm2pxa-ey.a.run.app';
  // Cloud Run's own URL and a custom domain are both real, live origins once
  // one fronts the service (docs/operations.md §2k) — no Domain Mapping, so
  // nothing stops the run.app URL from still being loaded directly.
  const CUSTOM_DOMAIN = 'https://agnte.app';

  beforeAll(async () => {
    await client().send(
      new PutBucketCorsCommand({
        Bucket: BUCKET,
        CORSConfiguration: corsConfiguration([
          PROD,
          previewOriginPattern(PREVIEW_BASE),
          CUSTOM_DOMAIN,
        ]),
      }),
    );
  });

  it('reads back the rule it just set — the same round-trip verify-r2.mjs proves credentials with', async () => {
    const { CORSRules } = await client().send(
      new GetBucketCorsCommand({ Bucket: BUCKET }),
    );
    expect(CORSRules?.[0]?.AllowedOrigins).toEqual([
      PROD,
      previewOriginPattern(PREVIEW_BASE),
      CUSTOM_DOMAIN,
    ]);
  });

  it('lets the production origin through preflight', async () => {
    const response = await preflight(PROD);
    expect(response.ok).toBe(true);
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT');
  });

  it('lets any pull request tag through via the wildcard preview origin', async () => {
    const response = await preflight(
      'https://pr-99---agnte-preview-lddzhm2pxa-ey.a.run.app',
    );
    expect(response.ok).toBe(true);
  });

  it('lets the custom domain through preflight, alongside the run.app URL', async () => {
    const response = await preflight(CUSTOM_DOMAIN);
    expect(response.ok).toBe(true);
  });

  it('still rejects an origin that is neither', async () => {
    const response = await preflight('https://not-this-app.example');
    expect(response.ok).toBe(false);
  });

  it('completes the actual upload a browser performs — preflight, then the signed PUT', async () => {
    const store = client();
    const body = Buffer.from('fake-jpeg-bytes');

    const command = new (await import('@aws-sdk/client-s3')).PutObjectCommand({
      Bucket: BUCKET,
      Key: 'media/owner-1/m2/original.jpg',
      ContentType: 'image/jpeg',
    });
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const url = await getSignedUrl(store, command, { expiresIn: 300 });

    // A presigned PUT built with `requestChecksumCalculation: 'WHEN_REQUIRED'`
    // carries no baked-in checksum of an empty body — see the comment on the
    // S3Client in blob-store.ts for the failure this avoids.
    expect(url).not.toMatch(/checksum/);

    const preflightResponse = await preflight(PROD);
    expect(preflightResponse.ok).toBe(true);

    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg', origin: PROD },
      body,
    });
    expect(put.ok).toBe(true);
  });
});

/**
 * Lets the browser's presigned upload (architecture.md §8.3) actually reach
 * R2.
 *
 * The app runs on one origin (Cloud Run) and uploads image bytes straight to
 * another (Cloudflare R2) — that is the whole point of a presigned URL, so a
 * Cloud Run instance never holds a photo in memory. But a cross-origin PUT
 * with a `content-type` header is not a "simple" request, so the browser
 * preflights it with an OPTIONS request before sending a byte. A bucket with
 * no CORS rule answers that preflight with no `Access-Control-Allow-Origin`
 * header at all, and the browser blocks the PUT before it leaves — the exact
 * "blocked by CORS policy" error this fixes.
 *
 * R2 exposes the same S3 `PutBucketCors` API AWS does, which is why this is a
 * script rather than another manual Cloudflare-dashboard step: an allowed
 * origin has to match byte for byte, the same class of mistake as the Google
 * `redirect_uri` in docs/operations.md §2f, and a script cannot fat-finger a
 * paste the way a dashboard form can.
 *
 * Idempotent — PutBucketCors replaces whatever rule is already there, so
 * re-running after adding a custom domain or a second preview region is the
 * intended way to use this.
 *
 * Reads credentials from the environment, never argv, so nothing lands in
 * shell history or the process table. Run via infra/set-r2-cors.sh.
 */
import { pathToFileURL } from 'node:url';
import { GetBucketCorsCommand, PutBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * The one header the app's upload actually sends
 * (src/app/_client/api.ts:uploadImage). If that ever sends another header,
 * it needs to be added here too, or the next upload preflight fails the same
 * way this one did.
 */
const ALLOWED_HEADERS = ['content-type'];

/** Only PUT: the browser never GETs or DELETEs an object directly — reads go
 * through <img src> (no preflight; see Timeline.tsx) and every other
 * operation is server-to-R2, not browser-to-R2. */
const ALLOWED_METHODS = ['PUT'];

/** How long a browser may cache a preflight response before asking again. */
const MAX_AGE_SECONDS = 3600;

/** Builds the CORS configuration `PutBucketCorsCommand` expects, for a given
 * list of allowed origins. Exported for testing — this is the part with
 * logic worth checking without a real bucket. */
export function corsConfiguration(origins) {
  if (origins.length === 0) {
    throw new Error('At least one origin is required.');
  }
  return {
    CORSRules: [
      {
        AllowedOrigins: origins,
        AllowedMethods: ALLOWED_METHODS,
        AllowedHeaders: ALLOWED_HEADERS,
        MaxAgeSeconds: MAX_AGE_SECONDS,
      },
    ],
  };
}

/**
 * Turns a preview service's own base URL into the pattern that matches every
 * pull request's tagged URL.
 *
 * Cloud Run composes a tagged revision's URL as `<tag>---<service host>`
 * (the same substitution `.github/workflows/deploy-preview.yml` does for one
 * concrete tag) — so `*` in the tag's place matches every pull request
 * without registering one origin per PR. S3-compatible CORS matching allows
 * exactly one `*` per origin, which is exactly what this needs.
 */
export function previewOriginPattern(previewServiceUrl) {
  return previewServiceUrl.replace(/^https:\/\//, 'https://*---');
}

async function main() {
  const {
    R2_ENDPOINT,
    R2_BUCKET,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    PROD_URL,
    PREVIEW_URL,
    CUSTOM_DOMAIN,
  } = process.env;

  if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.error('  All four R2 values must be set in the environment.');
    process.exit(1);
  }

  const origins = [];
  if (PROD_URL) origins.push(PROD_URL.replace(/\/+$/, ''));
  if (PREVIEW_URL) origins.push(previewOriginPattern(PREVIEW_URL.replace(/\/+$/, '')));
  // Cloud Run's own URL stays reachable even once a custom domain is
  // fronting the service (docs/operations.md §2k) — no Domain Mapping is
  // involved, Cloudflare just proxies the domain to it — so this adds the
  // domain rather than replacing PROD_URL with it. Both are real origins a
  // browser might load the app from.
  if (CUSTOM_DOMAIN) origins.push(CUSTOM_DOMAIN.replace(/\/+$/, ''));

  if (origins.length === 0) {
    console.error(
      '  Neither PROD_URL, PREVIEW_URL nor CUSTOM_DOMAIN is set — nothing to allow.',
    );
    console.error('  Deploy at least one of the two services first.');
    process.exit(1);
  }

  const client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  });

  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: R2_BUCKET,
        CORSConfiguration: corsConfiguration(origins),
      }),
    );
  } catch (error) {
    if (error?.name === 'AccessDenied') {
      console.error('  R2 rejected this with AccessDenied.');
      console.error('');
      console.error("  Setting a bucket's CORS policy is a configuration change, which");
      console.error(
        '  needs an Admin-scoped token — Object Read & Write (what production',
      );
      console.error(
        '  runs with) cannot do it. infra/set-r2-cors.sh asks for a separate',
      );
      console.error(
        '  Admin token rather than reading the stored one; if you called this',
      );
      console.error('  script directly, pass an Admin-scoped R2_ACCESS_KEY_ID instead.');
      process.exit(1);
    }
    throw error;
  }

  // Read it back rather than trusting the PUT returned 200 — the same
  // round-trip-not-just-a-status-code discipline verify-r2.mjs uses for the
  // credentials themselves.
  const { CORSRules } = await client.send(
    new GetBucketCorsCommand({ Bucket: R2_BUCKET }),
  );
  console.log(`  CORS set on ${R2_BUCKET}. Allowed origins:`);
  for (const rule of CORSRules ?? []) {
    for (const origin of rule.AllowedOrigins ?? []) console.log(`    ${origin}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

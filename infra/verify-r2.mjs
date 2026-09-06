/**
 * Proves a set of R2 credentials actually work, before they are stored.
 *
 * The failure this exists to catch is a jurisdiction mismatch: an EU-created
 * bucket is only reachable through the ".eu." endpoint, and the default
 * endpoint answers NoSuchBucket — which reads like a mistyped bucket name
 * rather than a wrong endpoint. Finding that out here costs seconds; finding
 * out at deploy time costs a failed release.
 *
 * Reads from the environment, never argv, so nothing lands in shell history or
 * the process table. Run via infra/set-secrets.sh.
 */
import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const { R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;

if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('  All four R2 values must be set in the environment.');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const key = '_healthcheck/setup-probe';
const nonce = randomUUID();

try {
  await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: nonce }));
  const response = await client.send(
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }),
  );
  const roundTripped = await response.Body?.transformToString();

  if (roundTripped !== nonce) {
    console.error('  Wrote an object but read back something different.');
    process.exit(1);
  }
  console.log(
    `    Round-tripped an object through ${new URL(R2_ENDPOINT).host}/${R2_BUCKET}.`,
  );
} catch (error) {
  const name = error?.name ?? 'Error';
  console.error(`  R2 rejected the request: ${name}`);

  if (name === 'NoSuchBucket') {
    console.error('');
    console.error(`  No bucket "${R2_BUCKET}" at ${new URL(R2_ENDPOINT).host}.`);
    console.error(
      '  Most often this is a jurisdiction mismatch rather than a wrong name:',
    );
    console.error(
      '  a bucket created in the EU jurisdiction is only reachable through the',
    );
    console.error(
      '  endpoint containing ".eu.", and the default endpoint reports it missing.',
    );
    console.error("  Check the bucket's settings page for its jurisdiction and use the");
    console.error('  matching endpoint.');
  } else if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    console.error(
      '  The access key or secret is wrong. Note that R2 shows the secret once,',
    );
    console.error('  so a partial copy is easy — create a fresh token if unsure.');
  } else if (name === 'AccessDenied') {
    console.error('  The token authenticated but lacks write access to this bucket.');
    console.error('  It needs Object Read & Write, scoped to this bucket.');
  } else {
    console.error(`  ${error?.message ?? error}`);
  }
  process.exit(1);
}

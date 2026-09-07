/**
 * Nightly database backup (architecture.md §8.8).
 *
 * Neon's free tier gives a short point-in-time window, which §8.8 says to treat
 * as insufficient on its own. This dumps to Cloudflare R2 with 30-day
 * retention.
 *
 * Runs as a Cloud Run Job rather than a route in the web service, for two
 * reasons: a dump can outlive the service's 60s request timeout as the database
 * grows, and pg_dump would otherwise have to live in the web image, where its
 * ~30MB is pulled on every cold start of a scale-to-zero service that never
 * uses it.
 *
 * Environment:
 *   DIRECT_URL              Neon direct connection (not the pooler — see below)
 *   R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   BACKUP_PREFIX           default "backups/"
 *   BACKUP_RETENTION_DAYS   default 30
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Refuse to treat a suspiciously small dump as a success.
 *
 * An empty or truncated file uploads perfectly happily, and the failure is only
 * discovered on the day it matters. Even an empty schema dumps more than this.
 */
const MINIMUM_PLAUSIBLE_BYTES = 2048;

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
  return value;
};

/**
 * The *direct* connection, not the pooler.
 *
 * pg_dump holds one session open across many statements and sets session-level
 * state; PgBouncer's transaction pooling breaks both. This is the same reason
 * migrations use it (docs/operations.md §2).
 */
const databaseUrl = required('DIRECT_URL');
const bucket = required('R2_BUCKET');
const prefix = process.env.BACKUP_PREFIX ?? 'backups/';
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? '30');

if (!Number.isFinite(retentionDays) || retentionDays < 1) {
  console.error(
    `BACKUP_RETENTION_DAYS must be a positive number, got "${retentionDays}".`,
  );
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: required('R2_ENDPOINT'),
  credentials: {
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
  },
  // Upload the dump as plain bytes.
  //
  // By default the SDK adds a trailing checksum, which forces `aws-chunked`
  // transfer encoding and means the object a bucket stores is the dump wrapped
  // in framing rather than the dump. Two reasons not to want that here: the
  // end-to-end digest check below already proves the round trip, more directly
  // than a per-request checksum does; and a backup should be exactly the bytes
  // pg_restore expects, so that fetching one with curl or from the Cloudflare
  // dashboard gives a file that works.
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

/** Sorts lexicographically in time order, which is what makes listing useful. */
const stamp = (at) => at.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'inherit', 'pipe'],
      ...options,
    });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      // pg_dump writes its reason to stderr, and it is always the useful part.
      reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

async function dump(target) {
  await run('pg_dump', [
    databaseUrl,
    // Custom format: compressed, and pg_restore can restore selectively or in
    // parallel from it. Plain SQL is easier to eyeball and much slower to
    // restore, which is the operation that actually matters here.
    '--format=custom',
    '--compress=9',
    // The roles on a restore target will not match Neon's. A dump that fails
    // halfway through because a role does not exist is a backup that does not
    // work, and this is the one place being wrong is unrecoverable.
    '--no-owner',
    '--no-privileges',
    `--file=${target}`,
  ]);
}

/** Streams a readable through SHA-256 without holding it in memory. */
async function digestOf(stream) {
  const hash = createHash('sha256');
  await pipeline(stream, hash);
  return hash.digest('hex');
}

async function pruneOlderThan(cutoff) {
  let continuationToken;
  let deleted = 0;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );

    const stale = (page.Contents ?? []).filter(
      (object) => object.LastModified && object.LastModified.getTime() < cutoff.getTime(),
    );

    if (stale.length > 0) {
      // Batched: one request per thousand rather than one per object. R2 bills
      // per operation.
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: stale.map((object) => ({ Key: object.Key })) },
        }),
      );
      deleted += stale.length;
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
}

async function main() {
  const startedAt = new Date();
  const directory = await mkdtemp(join(tmpdir(), 'agnte-backup-'));
  const file = join(directory, 'agnte.dump');
  const key = `${prefix}${startedAt.getUTCFullYear()}/${String(startedAt.getUTCMonth() + 1).padStart(2, '0')}/agnte-${stamp(startedAt)}.dump`;

  try {
    console.log('Dumping...');
    await dump(file);

    const { size } = await stat(file);
    if (size < MINIMUM_PLAUSIBLE_BYTES) {
      throw new Error(
        `Dump is only ${size} bytes, which is too small to be a real backup. Refusing to upload it.`,
      );
    }
    console.log(`Dumped ${size} bytes.`);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: 'application/octet-stream',
      }),
    );

    // Read it back and compare digests. A PUT that returns 200 having stored
    // nothing — or something subtly different — is exactly the failure this job
    // exists to prevent, and only the bytes coming back prove it did not
    // happen.
    //
    // Compared by hash rather than by Content-Length, for two reasons. The
    // SDK uploads with `aws-chunked` framing, so the length a bucket reports is
    // not always the length that was handed to it, and a check calibrated to
    // one implementation's accounting is a check that breaks on another's. And
    // matching sizes would not notice corruption anyway. Streamed through the
    // hash, so nothing larger than a buffer is ever held in memory; R2 charges
    // no egress, which is one of the reasons it was chosen (§3).
    const uploaded = await digestOf(createReadStream(file));
    const stored = await digestOf(
      (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body,
    );

    if (stored !== uploaded) {
      throw new Error(
        `Read back a different backup than was written (${uploaded.slice(0, 12)} vs ${stored.slice(0, 12)}). Not treating this as a backup.`,
      );
    }

    console.log(
      `Uploaded ${key} (${size} bytes, sha256 ${uploaded.slice(0, 16)}… verified).`,
    );

    const cutoff = new Date(startedAt.getTime() - retentionDays * DAY_MS);
    const deleted = await pruneOlderThan(cutoff);
    console.log(
      `Retention: removed ${deleted} backup(s) older than ${retentionDays} days.`,
    );

    console.log(`Done in ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The reason, not a stack trace.
 *
 * This output is read when something has already gone wrong, often by someone
 * who did not write it. A Node stack tells them where the throw was; the
 * message tells them what to do.
 */
try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

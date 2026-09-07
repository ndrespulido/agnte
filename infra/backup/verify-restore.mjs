/**
 * Restore rehearsal (architecture.md §8.8).
 *
 * "An untested backup is a guess, and this is the one place in the system where
 * being wrong is unrecoverable." So this takes the most recent backup, restores
 * it into a scratch database, and compares row counts table by table against
 * the source.
 *
 * Row counts rather than a checksum, deliberately: a checksum over a live
 * database is always wrong, because the source keeps changing while the dump is
 * being restored. Counts are stable enough to be meaningful and specific enough
 * to catch the failures that matter — a table that restored empty, or did not
 * restore at all.
 *
 * Environment:
 *   DIRECT_URL          the database the backup came from (read-only here)
 *   SCRATCH_URL         an empty database to restore into — this is DROPPED and
 *                       recreated, so it must not be anything you want to keep
 *   R2_*                as for backup.mjs
 *   BACKUP_PREFIX       default "backups/"
 *   BACKUP_KEY          optional: rehearse a specific backup instead of the latest
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}.`);
    process.exit(1);
  }
  return value;
};

const sourceUrl = required('DIRECT_URL');
const scratchUrl = required('SCRATCH_URL');
const bucket = required('R2_BUCKET');
const prefix = process.env.BACKUP_PREFIX ?? 'backups/';

if (sourceUrl === scratchUrl) {
  // The whole rehearsal restores over the scratch database. Pointing both at
  // the same place would destroy the thing being backed up.
  console.error('SCRATCH_URL must not be the same as DIRECT_URL.');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: required('R2_ENDPOINT'),
  credentials: {
    accessKeyId: required('R2_ACCESS_KEY_ID'),
    secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
  },
});

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => (stdout += c.toString()));
    child.stderr?.on('data', (c) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 500)}`)),
    );
  });
}

/** Counts every row in every table of the module schemas, as "schema.table=n". */
const COUNT_QUERY = `
  SELECT table_schema || '.' || table_name AS name,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                             false, true, '')))[1]::text::bigint AS rows
  FROM information_schema.tables
  WHERE table_type = 'BASE TABLE'
    AND table_schema IN ('platform','identity','verse','media','insights','notifications','privacy')
  ORDER BY 1
`;

async function counts(url) {
  const out = await run('psql', [
    url,
    '--no-align',
    '--tuples-only',
    '--field-separator=|',
    '-c',
    COUNT_QUERY,
  ]);
  const result = new Map();
  for (const line of out.split('\n')) {
    const [name, rows] = line.split('|');
    if (name && rows !== undefined) result.set(name.trim(), Number(rows.trim()));
  }
  return result;
}

async function latestBackupKey() {
  if (process.env.BACKUP_KEY) return process.env.BACKUP_KEY;

  let continuationToken;
  let latest;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    for (const object of page.Contents ?? []) {
      if (!latest || (object.LastModified ?? 0) > (latest.LastModified ?? 0))
        latest = object;
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  if (!latest?.Key) {
    console.error(`No backups found under ${prefix}. Nothing to rehearse.`);
    process.exit(1);
  }
  return latest.Key;
}

async function main() {
  const key = await latestBackupKey();
  console.log(`Rehearsing ${key}`);

  const directory = await mkdtemp(join(tmpdir(), 'agnte-restore-'));
  const file = join(directory, 'agnte.dump');

  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    await pipeline(object.Body, createWriteStream(file));
    console.log(`Downloaded ${(await stat(file)).size} bytes.`);

    // Read the source *before* restoring: on a live database the numbers drift,
    // and taking them after would compare the restore against a moment the dump
    // could not have captured.
    const before = await counts(sourceUrl);

    // --clean --if-exists so the rehearsal is repeatable against a scratch
    // database that already holds the last one.
    await run('pg_restore', [
      '--dbname',
      scratchUrl,
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      // Without this pg_restore reports success having skipped failing
      // statements, which is the opposite of what a rehearsal is for.
      '--exit-on-error',
      file,
    ]);

    const after = await counts(scratchUrl);

    let problems = 0;
    console.log('\n  table                                    source   restored');
    for (const [table, sourceRows] of [...before.entries()].sort()) {
      const restoredRows = after.get(table);
      const ok = restoredRows !== undefined && restoredRows >= sourceRows;
      if (!ok) problems += 1;
      console.log(
        `  ${ok ? ' ' : '✗'} ${table.padEnd(38)} ${String(sourceRows).padStart(6)} ${String(restoredRows ?? 'missing').padStart(10)}`,
      );
    }

    // `>=` rather than `===`: rows written between the dump and now appear in
    // the source and legitimately cannot be in the restore. A restored table
    // holding *fewer* rows than the source is the failure worth catching, and
    // this errs towards reporting one.
    const missingTables = [...before.keys()].filter((t) => !after.has(t));
    if (missingTables.length > 0) {
      console.error(`\nTables missing from the restore: ${missingTables.join(', ')}`);
    }

    if (problems > 0) {
      console.error(
        `\nRehearsal FAILED: ${problems} table(s) did not restore completely.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`\nRehearsal passed: ${before.size} table(s) restored.`);
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

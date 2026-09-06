import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from './config';

/**
 * The object storage port (docs/architecture.md §7.1).
 *
 * Two adapters, selected by environment: Cloudflare R2 in production and
 * preview, the filesystem locally. Only the adapter differs — if a code path
 * existed in one and not the other, the pipeline would be testing something
 * that was never run locally.
 *
 * Phase 0 needs put and get only, because its job is to prove the wire. The
 * media module (Phase 4) will define its own domain port for presigned uploads,
 * variants and deletion, with this adapter behind it.
 */
export interface ObjectStorage {
  /** Human-readable description of what this adapter is talking to. */
  readonly description: string;
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
}

/**
 * Keys come from application code rather than user input today, but the
 * filesystem adapter turns a key into a path, so a key containing ".." would
 * escape the storage root. Rejecting it here keeps that true of every adapter
 * rather than only the one that happens to be dangerous.
 */
function assertSafeKey(key: string): void {
  if (
    !key ||
    key.startsWith('/') ||
    normalize(key) !== key ||
    key.split('/').includes('..')
  ) {
    throw new Error(`Unsafe object key: ${JSON.stringify(key)}`);
  }
}

class R2ObjectStorage implements ObjectStorage {
  readonly description: string;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
    endpoint: string,
  ) {
    const host = new URL(endpoint).host;
    this.description = prefix ? `${host}/${bucket}/${prefix}` : `${host}/${bucket}`;
  }

  private path(key: string): string {
    assertSafeKey(key);
    return `${this.prefix}${key}`;
  }

  async put(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.path(key),
        Body: body,
        ContentType: 'text/plain; charset=utf-8',
      }),
    );
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.path(key) }),
      );
      return await response.Body?.transformToString();
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') return undefined;
      throw error;
    }
  }
}

class FilesystemObjectStorage implements ObjectStorage {
  readonly description: string;

  constructor(private readonly root: string) {
    this.description = `${root} (local)`;
  }

  private path(key: string): string {
    assertSafeKey(key);
    return join(this.root, key);
  }

  async put(key: string, body: string): Promise<void> {
    const file = this.path(key);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, 'utf8');
  }

  async get(key: string): Promise<string | undefined> {
    try {
      return await readFile(this.path(key), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

let cached: ObjectStorage | undefined;
let cachedFor: string | undefined;

/**
 * Returns the configured adapter, or undefined when there is none — which in
 * a deployed environment means R2 was not configured, and locally never
 * happens because the filesystem is always available.
 */
export function getObjectStorage(): ObjectStorage | undefined {
  const config = loadConfig();

  // The cache key changes whenever the configuration does, so a test that
  // varies the environment is not served a stale adapter.
  const key = createHash('sha256')
    .update(
      [
        config.APP_ENV,
        config.R2_ENDPOINT ?? '',
        config.R2_BUCKET ?? '',
        config.R2_ACCESS_KEY_ID ?? '',
        config.R2_PREFIX,
      ].join('|'),
    )
    .digest('hex');

  if (cached && cachedFor === key) return cached;

  let storage: ObjectStorage | undefined;

  if (
    config.R2_ENDPOINT &&
    config.R2_BUCKET &&
    config.R2_ACCESS_KEY_ID &&
    config.R2_SECRET_ACCESS_KEY
  ) {
    const client = new S3Client({
      // R2 has no regions; the S3 protocol requires the field regardless.
      region: 'auto',
      endpoint: config.R2_ENDPOINT,
      // Path style keeps the bucket out of the hostname, which R2 supports and
      // which makes the same adapter usable against a local S3 server in tests.
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      },
    });
    storage = new R2ObjectStorage(
      client,
      config.R2_BUCKET,
      config.R2_PREFIX,
      config.R2_ENDPOINT,
    );
  } else if (config.APP_ENV === 'local') {
    storage = new FilesystemObjectStorage('.local-storage');
  }

  cached = storage;
  cachedFor = key;
  return storage;
}

/** Test seam: drop the memoised adapter so a test can vary the environment. */
export function resetObjectStorageForTests(): void {
  cached = undefined;
  cachedFor = undefined;
}

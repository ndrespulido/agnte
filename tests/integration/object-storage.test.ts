import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import {
  getObjectStorage,
  resetObjectStorageForTests,
} from '@/shared/infra/object-storage';
import { runChecks } from '@/shared/infra/checks';

/**
 * The R2 adapter is exercised against a local S3-compatible server rather than
 * mocked. A mock would confirm which methods were called; this confirms the
 * request actually signs, sends and round-trips — which is the part that can be
 * wrong. R2 itself is only reachable from a deployed environment.
 */
const BUCKET = 'agnte-test';
const PORT = 4569;

let server: S3rver;
let directory: string;

const ORIGINAL = { ...process.env };

const useEnv = (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL, ...env };
  resetConfigForTests();
  resetObjectStorageForTests();
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 's3rver-'));
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
  process.env = { ...ORIGINAL };
  resetConfigForTests();
  resetObjectStorageForTests();
});

const s3Env = (extra: Record<string, string> = {}) => ({
  APP_ENV: 'production',
  DATABASE_URL: undefined,
  R2_ENDPOINT: `http://127.0.0.1:${PORT}`,
  R2_BUCKET: BUCKET,
  R2_ACCESS_KEY_ID: 'S3RVER',
  R2_SECRET_ACCESS_KEY: 'S3RVER',
  ...extra,
});

describe('R2 adapter against a real S3 server', () => {
  it('round-trips an object', async () => {
    useEnv(s3Env());
    const storage = getObjectStorage()!;
    await storage.put('probe.txt', 'hello');
    expect(await storage.get('probe.txt')).toBe('hello');
  });

  it('returns undefined for a key that does not exist', async () => {
    useEnv(s3Env());
    expect(await getObjectStorage()!.get('nope.txt')).toBeUndefined();
  });

  it('isolates environments by key prefix', async () => {
    useEnv(s3Env({ R2_PREFIX: 'pr-1/' }));
    await getObjectStorage()!.put('shared.txt', 'from pr-1');

    useEnv(s3Env({ R2_PREFIX: 'pr-2/' }));
    await getObjectStorage()!.put('shared.txt', 'from pr-2');

    useEnv(s3Env({ R2_PREFIX: 'pr-1/' }));
    expect(await getObjectStorage()!.get('shared.txt')).toBe('from pr-1');
  });

  it('reports ok from the health check', async () => {
    useEnv(s3Env());
    const result = (await runChecks()).find((r) => r.name === 'object-storage');
    expect(result?.status).toBe('ok');
  });

  it('reports failed when the bucket does not exist', async () => {
    useEnv(s3Env({ R2_BUCKET: 'no-such-bucket' }));
    const result = (await runChecks()).find((r) => r.name === 'object-storage');
    expect(result?.status).toBe('failed');
  });
});

describe('filesystem adapter', () => {
  it('is selected locally and round-trips', async () => {
    useEnv({
      APP_ENV: 'local',
      DATABASE_URL: undefined,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
    });
    const storage = getObjectStorage()!;
    expect(storage.description).toContain('local');
    await storage.put('probe.txt', 'local value');
    expect(await storage.get('probe.txt')).toBe('local value');
  });

  it('rejects a key that would escape the storage root', async () => {
    useEnv({ APP_ENV: 'local', R2_ENDPOINT: undefined });
    await expect(getObjectStorage()!.put('../escaped.txt', 'x')).rejects.toThrow(
      /Unsafe/,
    );
  });
});

describe('deployed without R2', () => {
  it('reports not-configured rather than falling back to the filesystem', async () => {
    useEnv({
      APP_ENV: 'production',
      DATABASE_URL: undefined,
      R2_ENDPOINT: undefined,
      R2_BUCKET: undefined,
      R2_ACCESS_KEY_ID: undefined,
      R2_SECRET_ACCESS_KEY: undefined,
    });
    expect(getObjectStorage()).toBeUndefined();
    const result = (await runChecks()).find((r) => r.name === 'object-storage');
    expect(result?.status).toBe('not-configured');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '@/shared/infra/config';

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetConfigForTests();
});

describe('loadConfig', () => {
  it('defaults to local development so `npm run dev` needs no cloud accounts', () => {
    delete process.env.APP_ENV;
    delete process.env.GIT_SHA;
    resetConfigForTests();

    const config = loadConfig();

    expect(config.APP_ENV).toBe('local');
    expect(config.GIT_SHA).toBe('unknown');
    expect(config.NEON_BRANCH).toBeUndefined();
  });

  it('reads the values a preview deploy injects', () => {
    process.env.APP_ENV = 'preview';
    process.env.GIT_SHA = 'abc1234';
    process.env.NEON_BRANCH = 'pr-12';
    process.env.PREVIEW_LABEL = 'pr-12';
    resetConfigForTests();

    const config = loadConfig();

    expect(config.APP_ENV).toBe('preview');
    expect(config.GIT_SHA).toBe('abc1234');
    expect(config.NEON_BRANCH).toBe('pr-12');
  });

  it('rejects a partially configured R2, which would silently disable storage', () => {
    process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.R2_BUCKET = 'agnte';
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    resetConfigForTests();

    expect(() => loadConfig()).toThrowError(/R2 is partially configured/);
  });

  it('accepts R2 when all four values are present', () => {
    process.env.R2_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    process.env.R2_BUCKET = 'agnte';
    process.env.R2_ACCESS_KEY_ID = 'key';
    process.env.R2_SECRET_ACCESS_KEY = 'secret';
    resetConfigForTests();

    expect(loadConfig().R2_BUCKET).toBe('agnte');
  });

  it('fails fast and names the offending variable', () => {
    process.env.APP_ENV = 'staging';
    resetConfigForTests();

    expect(() => loadConfig()).toThrowError(/APP_ENV/);
  });
});

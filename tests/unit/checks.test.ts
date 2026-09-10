import { afterEach, describe, expect, it } from 'vitest';
import { isHealthy, runChecks, type CheckResult } from '@/shared/infra/checks';
import { resetConfigForTests } from '@/shared/infra/config';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetConfigForTests();
});

const result = (status: CheckResult['status']): CheckResult => ({
  name: 'x',
  status,
  detail: '',
  durationMs: 0,
});

describe('runChecks', () => {
  it('reports every dependency separately', async () => {
    const results = await runChecks();

    expect(results.map((r) => r.name)).toEqual([
      'runtime',
      'database',
      'object-storage',
      'email',
      'access-tokens',
      'google-sign-in',
      'deferred-jobs',
    ]);
    expect(results.every((r) => typeof r.durationMs === 'number')).toBe(true);
  });

  it('reports the runtime as healthy', async () => {
    const results = await runChecks();
    expect(results.find((r) => r.name === 'runtime')?.status).toBe('ok');
  });

  /**
   * The check that exists because its absence hid a day-long outage: every
   * upload's thumbnail silently never generated while this endpoint reported
   * every other dependency ok. Locally the in-process queue really does run
   * the job, so `ok` here is the truth rather than a pass given for free.
   */
  it('reports the local in-process queue as a working pipeline', async () => {
    const results = await runChecks();
    const jobs = results.find((r) => r.name === 'deferred-jobs');

    expect(jobs?.status).toBe('ok');
    expect(jobs?.detail).toBe('in-process queue');
  });

  /**
   * The branch that matters, and the one the local case above cannot reach:
   * deployed, with the Cloud Tasks configuration absent. This is the exact
   * state production sat in for a day — and it must name what is missing,
   * because "not configured" without the variable's name is another round of
   * the same guessing.
   */
  it('names the missing configuration when deployed without Cloud Tasks', async () => {
    process.env.APP_ENV = 'production';
    process.env.JWT_SECRET = 'a'.repeat(64);
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GCP_REGION;
    delete process.env.INTERNAL_TASKS_SECRET;
    resetConfigForTests();

    const jobs = (await runChecks()).find((r) => r.name === 'deferred-jobs');

    expect(jobs?.status).toBe('not-configured');
    expect(jobs?.detail).toContain('thumbnails will not generate');
    expect(jobs?.detail).toContain('GCP_PROJECT_ID');
    expect(jobs?.detail).toContain('INTERNAL_TASKS_SECRET');
  });
});

describe('isHealthy', () => {
  it('treats a not-yet-wired dependency as healthy', () => {
    expect(isHealthy([result('ok'), result('not-configured')])).toBe(true);
  });

  it('treats a broken dependency as unhealthy', () => {
    expect(isHealthy([result('ok'), result('failed')])).toBe(false);
  });
});

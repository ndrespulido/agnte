import { describe, expect, it } from 'vitest';
import { isHealthy, runChecks, type CheckResult } from '@/shared/infra/checks';

const result = (status: CheckResult['status']): CheckResult => ({
  name: 'x',
  status,
  detail: '',
  durationMs: 0,
});

describe('runChecks', () => {
  it('reports every dependency separately', async () => {
    const results = await runChecks();

    expect(results.map((r) => r.name)).toEqual(['runtime', 'database', 'object-storage']);
    expect(results.every((r) => typeof r.durationMs === 'number')).toBe(true);
  });

  it('reports the runtime as healthy', async () => {
    const results = await runChecks();
    expect(results.find((r) => r.name === 'runtime')?.status).toBe('ok');
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

/**
 * Dependency checks.
 *
 * Phase 0 exists to prove the deployment path, so each external dependency is
 * reported separately: a red status names the broken wire instead of leaving
 * "the app didn't start". Later phases register their own checks here as the
 * dependencies land — Neon in 0.4, R2 in 0.5.
 */

export type CheckStatus = 'ok' | 'failed' | 'not-configured';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  durationMs: number;
}

export interface Check {
  name: string;
  run: () => Promise<{ status: CheckStatus; detail: string }>;
}

const checks: Check[] = [
  {
    name: 'runtime',
    run: async () => ({
      status: 'ok',
      detail: `node ${process.version}, up ${Math.round(process.uptime())}s`,
    }),
  },
  {
    name: 'database',
    run: async () => ({
      status: 'not-configured',
      detail: 'Neon is wired in task 0.4',
    }),
  },
  {
    name: 'object-storage',
    run: async () => ({
      status: 'not-configured',
      detail: 'Cloudflare R2 is wired in task 0.5',
    }),
  },
];

export async function runChecks(): Promise<CheckResult[]> {
  return Promise.all(
    checks.map(async (check) => {
      const started = performance.now();
      try {
        const { status, detail } = await check.run();
        return {
          name: check.name,
          status,
          detail,
          durationMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        return {
          name: check.name,
          status: 'failed' as const,
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Math.round(performance.now() - started),
        };
      }
    }),
  );
}

/**
 * A check that is not configured is not a failure — a preview environment
 * legitimately runs ahead of the dependency it will later use.
 */
export function isHealthy(results: CheckResult[]): boolean {
  return results.every((result) => result.status !== 'failed');
}

import { randomUUID } from 'node:crypto';
import { getDatabase, MIGRATED_SCHEMAS } from './database';
import { getEmailTransport } from './email';
import { getObjectStorage } from './object-storage';

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
    run: async () => {
      const db = getDatabase();
      if (!db) return { status: 'not-configured', detail: 'DATABASE_URL is not set' };

      // Asserts the migrations ran, not merely that a connection opened. A
      // reachable but unmigrated database is the failure this is here to catch.
      //
      // Every migrated schema, not just the module ones: the deploy smoke test
      // gates on this check, so anything it does not look at can ship green.
      const rows = await db.$queryRaw<{ schema_name: string }[]>`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = ANY(${[...MIGRATED_SCHEMAS]})
      `;

      const found = rows.length;
      const total = MIGRATED_SCHEMAS.length;
      if (found < total) {
        const missing = MIGRATED_SCHEMAS.filter(
          (schema) => !rows.some((row) => row.schema_name === schema),
        );
        return {
          status: 'failed' as const,
          detail: `migration incomplete, missing: ${missing.join(', ')}`,
        };
      }

      return { status: 'ok' as const, detail: `${found}/${total} schemas` };
    },
  },
  {
    name: 'object-storage',
    run: async () => {
      const storage = getObjectStorage();
      if (!storage) return { status: 'not-configured', detail: 'R2 is not configured' };

      // A write and a read of two independent objects would both pass against
      // a bucket that silently discards writes. Round-tripping a fresh value
      // and comparing it is what actually proves the wire.
      const nonce = randomUUID();
      await storage.put('_healthcheck/probe', nonce);
      const roundTripped = await storage.get('_healthcheck/probe');

      if (roundTripped !== nonce) {
        return {
          status: 'failed' as const,
          detail: `round-trip mismatch at ${storage.description}`,
        };
      }

      return { status: 'ok' as const, detail: storage.description };
    },
  },
  {
    name: 'email',
    run: async () => {
      const transport = getEmailTransport();

      // Reported, not exercised: a check that actually sent a message would
      // send one on every health poll, and Cloud Run polls.
      //
      // Deliberately 'not-configured' rather than 'failed' when there is no
      // transport in a deployed environment. It *is* broken — registration
      // answers 503 without it — but the deploy smoke test gates promotion on
      // this endpoint, and making it fatal would block deploying the very code
      // that needs the secret set. Visible on the status page is the honest
      // middle: the gap shows up on the phone rather than at registration.
      if (!transport) return { status: 'not-configured', detail: 'no email transport' };

      return { status: 'ok' as const, detail: transport.description };
    },
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

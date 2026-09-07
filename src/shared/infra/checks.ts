import { randomUUID } from 'node:crypto';
import { loadConfig } from './config';
import { getDatabase, MIGRATED_SCHEMAS, shippedMigrations } from './database';
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
          detail: `migration incomplete, missing schemas: ${missing.join(', ')}`,
        };
      }

      // Schemas are not enough, and this is the second time that has bitten.
      // The check was made to track schemas when `platform` was added; every
      // migration since adds *tables* to schemas that already exist, so a
      // database migrated only as far as an older release still reports every
      // schema present. Verified: a database with all seven schemas and none of
      // identity's tables passed this check.
      //
      // So compare what the image ships against what the database says it
      // applied. That answers the question the check is actually for — is this
      // the database this build expects — and it keeps answering it as
      // migrations are added, because the list comes from the directory rather
      // than from a constant someone has to remember to update.
      const shipped = shippedMigrations();
      if (shipped.length === 0) {
        return {
          status: 'failed' as const,
          detail: 'no migrations found on disk, so nothing can be verified',
        };
      }

      // to_regclass returns null rather than raising when the table is absent,
      // which is the difference between "never migrated" — a clear, actionable
      // failure — and a raw 42P01 surfacing as an unhandled error.
      const [bookkeeping] = await db.$queryRaw<{ present: boolean }[]>`
        SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present
      `;

      if (!bookkeeping?.present) {
        return {
          status: 'failed' as const,
          detail: 'no migration history: this database has never been migrated',
        };
      }

      const applied = await db.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM public._prisma_migrations
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
      `;

      const appliedNames = new Set(applied.map((row) => row.migration_name));
      const pending = shipped.filter((name) => !appliedNames.has(name));

      if (pending.length > 0) {
        return {
          status: 'failed' as const,
          // Named, not counted: the first pending migration is what someone
          // debugging this at 3am needs, and a count sends them to the logs.
          detail: `${pending.length} migration(s) not applied: ${pending.slice(0, 3).join(', ')}`,
        };
      }

      return {
        status: 'ok' as const,
        detail: `${found}/${total} schemas, ${shipped.length} migrations applied`,
      };
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
  {
    name: 'access-tokens',
    run: async () => {
      const config = loadConfig();

      // Reported rather than exercised, like email: signing a throwaway token
      // on every health poll proves nothing the presence of a key does not.
      //
      // Local development generates a per-process key, which is why this says
      // "ephemeral" rather than ok there — tokens issued before a restart stop
      // working after it, and that is worth seeing rather than debugging.
      if (config.JWT_SECRET) return { status: 'ok' as const, detail: 'configured' };

      if (config.APP_ENV === 'local') {
        return { status: 'ok' as const, detail: 'ephemeral development key' };
      }

      return { status: 'not-configured' as const, detail: 'JWT_SECRET is not set' };
    },
  },
  {
    name: 'google-sign-in',
    run: async () => {
      const config = loadConfig();

      // Not-configured is the *expected* state in a preview: Google does not
      // accept wildcard redirect URIs, so a per-pull-request URL cannot be
      // registered in advance. Reported rather than treated as a fault, so the
      // status page says why Google sign-in is missing instead of leaving
      // someone to discover it at the button.
      if (!config.GOOGLE_CLIENT_ID) {
        return {
          status: 'not-configured' as const,
          detail:
            config.APP_ENV === 'preview'
              ? 'previews cannot register a redirect URI with Google'
              : 'GOOGLE_CLIENT_ID is not set',
        };
      }

      return { status: 'ok' as const, detail: 'configured' };
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

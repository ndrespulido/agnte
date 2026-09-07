import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runChecks } from '@/shared/infra/checks';
import {
  getDatabase,
  MIGRATED_SCHEMAS,
  shippedMigrations,
} from '@/shared/infra/database';

/**
 * Runs against a real Postgres. Skips when none is configured, so `npm test`
 * still works on a machine with no database — the local-development constraint
 * in architecture.md §7.1 applies to the test suite too.
 *
 * Locally this is the native Postgres from the dev setup; in CI it is a Neon
 * branch, which is what makes adapter-specific bugs surface in the pipeline
 * rather than in production.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('database check against real Postgres', () => {
  afterAll(async () => {
    await getDatabase()?.$disconnect();
  });

  it('reports ok when every schema and every migration is present', async () => {
    const results = await runChecks();
    const database = results.find((r) => r.name === 'database');

    expect(database?.status).toBe('ok');
    expect(database?.detail).toBe(
      `${MIGRATED_SCHEMAS.length}/${MIGRATED_SCHEMAS.length} schemas, ` +
        `${shippedMigrations().length} migrations applied`,
    );
  });

  it('fails when the database is migrated to an older release than this build', async () => {
    // The failure schemas alone cannot see, and the second time it has bitten.
    // The check was made to track schemas when `platform` was added; every
    // migration since adds *tables* to schemas that already exist, so a
    // database stopped at an earlier release still reports all seven schemas.
    //
    // Simulated by removing the newest migration's row rather than by building
    // a second database: it is the same state the check has to notice, and it
    // needs no fixture.
    const newest = shippedMigrations().at(-1)!;
    const db = getDatabase()!;

    const [saved] = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `DELETE FROM public._prisma_migrations WHERE migration_name = '${newest}' RETURNING *`,
    );
    expect(saved).toBeDefined();

    try {
      const database = (await runChecks()).find((r) => r.name === 'database');
      expect(database?.status).toBe('failed');
      expect(database?.detail).toContain(newest);
    } finally {
      // Restored whatever the assertions did, or every later test runs against
      // a database this check now considers broken.
      await db.$executeRawUnsafe(
        `INSERT INTO public._prisma_migrations
           (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        saved!.id,
        saved!.checksum,
        saved!.finished_at,
        saved!.migration_name,
        saved!.logs,
        saved!.rolled_back_at,
        saved!.started_at,
        saved!.applied_steps_count,
      );
    }

    // And back to healthy, so the restore above is proved rather than assumed.
    expect((await runChecks()).find((r) => r.name === 'database')?.status).toBe('ok');
  });

  it('opens a real connection rather than reporting from cache', async () => {
    const rows = await getDatabase()!.$queryRaw<{ one: number }[]>`SELECT 1 AS one`;
    expect(rows[0]?.one).toBe(1);
  });
});

describe('database check without a database', () => {
  it('reports not-configured rather than failing', async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const results = await runChecks();
      const database = results.find((r) => r.name === 'database');
      expect(database?.status).toBe('not-configured');
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });
});

/**
 * The list the health check asserts against has to track the migrations, or the
 * check goes quietly blind. That is not hypothetical: the `platform` schema was
 * added in a migration while this list still named only the six module schemas,
 * and the check reported a green database on a database where that migration had
 * never run — which the deploy smoke test gates on, so it would have shipped.
 *
 * Comparing against the migration SQL rather than a hard-coded number is what
 * makes this catch the *next* schema too. Needs no database, so it guards CI as
 * well as a local run.
 */
describe('schemas the health check knows about', () => {
  const migrationsDir = join(process.cwd(), 'prisma', 'migrations');

  const schemasCreatedByMigrations = (): string[] => {
    const found = new Set<string>();
    for (const entry of readdirSync(migrationsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sql = readFileSync(join(migrationsDir, entry.name, 'migration.sql'), 'utf8');
      for (const match of sql.matchAll(/CREATE SCHEMA (?:IF NOT EXISTS )?"([^"]+)"/gi)) {
        const name = match[1];
        if (name) found.add(name);
      }
    }
    return [...found].sort();
  };

  it('covers every schema the migrations create', () => {
    expect([...MIGRATED_SCHEMAS].sort()).toEqual(schemasCreatedByMigrations());
  });

  it('reads real migrations rather than an empty directory', () => {
    expect(schemasCreatedByMigrations().length).toBeGreaterThan(1);
  });
});

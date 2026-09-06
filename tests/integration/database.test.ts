import { afterAll, describe, expect, it } from 'vitest';
import { runChecks } from '@/shared/infra/checks';
import { getDatabase, MODULE_SCHEMAS } from '@/shared/infra/database';

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

  it('reports ok when every module schema exists', async () => {
    const results = await runChecks();
    const database = results.find((r) => r.name === 'database');

    expect(database?.status).toBe('ok');
    expect(database?.detail).toBe(
      `${MODULE_SCHEMAS.length}/${MODULE_SCHEMAS.length} module schemas`,
    );
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

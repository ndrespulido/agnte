import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * The six module schemas from docs/architecture.md §1.1. Deliberately *not*
 * the full list of schemas: this is the set that maps one-to-one onto modules,
 * which is what the boundary rule and the later per-schema database roles are
 * defined against. `platform` is infrastructure and belongs to no module, so
 * folding it in here would blur exactly the distinction the rule rests on.
 */
export const MODULE_SCHEMAS = [
  'identity',
  'verse',
  'media',
  'insights',
  'notifications',
  'privacy',
] as const;

/**
 * Cross-cutting infrastructure that belongs to no module: idempotency keys and
 * rate-limit windows (architecture.md §1.2, §8.6, §8.7).
 */
export const PLATFORM_SCHEMA = 'platform' as const;

/**
 * Every schema the migrations create. This is what the health check asserts
 * against, rather than MODULE_SCHEMAS: a check that knows only about the
 * module schemas reports a green database when a later migration silently
 * failed to apply, which is precisely the failure it exists to catch.
 */
export const MIGRATED_SCHEMAS = [...MODULE_SCHEMAS, PLATFORM_SCHEMA] as const;

/**
 * The migrations shipped alongside this build, by directory name.
 *
 * Read from disk rather than generated, so there is nothing to keep in sync:
 * adding a migration directory is what adds it here. The Dockerfile copies
 * prisma/migrations into the runtime image for exactly this.
 *
 * Empty when the directory is absent — which the health check reports rather
 * than treating as "nothing to check".
 */
export function shippedMigrations(): string[] {
  try {
    return readdirSync(join(process.cwd(), 'prisma', 'migrations'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Next reloads modules in development, which would otherwise open a new pool on
 * every edit until Postgres refuses connections.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Returns the client, or undefined when no database is configured.
 *
 * Undefined rather than throwing: `npm run dev` has to work with no cloud
 * accounts and no local Postgres (architecture.md §7.1), and a preview
 * legitimately runs ahead of the database it will later use. Callers that
 * genuinely require a database should say so themselves.
 */
export function getDatabase(): PrismaClient | undefined {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return undefined;

  if (!globalForPrisma.prisma) {
    // Prisma 7 connects through a driver adapter rather than a bundled native
    // engine. That also removes the arm64/amd64 engine-binary mismatch between
    // this project's development machine and its container.
    const adapter = new PrismaPg({ connectionString });
    globalForPrisma.prisma = new PrismaClient({ adapter });
  }

  return globalForPrisma.prisma;
}

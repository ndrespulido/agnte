import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * The six module schemas from docs/architecture.md §1.1. Kept here so the
 * health check can assert the migration actually ran, rather than only that a
 * connection can be opened.
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

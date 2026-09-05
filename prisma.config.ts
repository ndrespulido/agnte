import { defineConfig } from 'prisma/config';

/**
 * Migration-time configuration.
 *
 * The migration engine needs a *direct* connection: it takes advisory locks and
 * runs multi-statement DDL in a session, both of which PgBouncer's transaction
 * pooling breaks. The application uses the pooled URL instead — see
 * src/shared/infra/database.ts.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
});

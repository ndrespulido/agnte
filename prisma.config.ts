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
    // `||` rather than `??`: an environment variable set to the empty string is
    // unset in every way that matters, and `??` only falls back on undefined —
    // so an empty DIRECT_URL would defeat the DATABASE_URL fallback and fail
    // with "Connection url is empty" while both variables appear to be present.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || '',

    // Only used when *authoring* migrations locally — `prisma migrate diff`
    // and `migrate dev` replay the migration history into a scratch database
    // to work out the diff. `migrate deploy`, which is all CI and production
    // run, never touches it, so leaving this unset there is correct.
    ...(process.env.SHADOW_DATABASE_URL
      ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL }
      : {}),
  },
});

-- Module schemas (docs/architecture.md §1.1).
--
-- Each module owns one Postgres schema. No cross-schema foreign keys and no
-- cross-schema joins: a module reads another module's data through its public
-- API, never by reaching into its tables. That is what makes a later split into
-- separate services mechanical rather than a rewrite.
--
-- Written by hand rather than generated. Prisma derives migrations from models,
-- and there are none yet — the schemas have to exist before Phase 1 can put
-- tables in them. Hand-authored SQL is also how the per-module DB roles will be
-- added later, since Prisma does not manage roles or grants.

CREATE SCHEMA IF NOT EXISTS "identity";
CREATE SCHEMA IF NOT EXISTS "verse";
CREATE SCHEMA IF NOT EXISTS "media";
CREATE SCHEMA IF NOT EXISTS "insights";
CREATE SCHEMA IF NOT EXISTS "notifications";
CREATE SCHEMA IF NOT EXISTS "privacy";

-- ---------------------------------------------------------------------------
-- The language a person reads the app in.
--
-- Defaulted rather than nullable: every existing account was reading English,
-- so 'en' is the true answer for all of them and a NULL would only push the
-- question to every read site. The application falls back to English for an
-- unrecognised value anyway, so a row written by a future version that offers
-- a language this one does not have degrades to English rather than breaking.
--
-- Deliberately not a Postgres enum. Adding a language should be adding a
-- string table and one line of data (src/shared/i18n/locales.ts); an enum
-- would make it a migration, and a migration is exactly the kind of friction
-- that leaves a translation sitting in a branch.
-- ---------------------------------------------------------------------------
ALTER TABLE "identity"."user"
  ADD COLUMN IF NOT EXISTS "locale" TEXT NOT NULL DEFAULT 'en';

-- CreateTable
CREATE TABLE "identity"."user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "email_verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."pending_registration" (
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pending_registration_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "identity"."user"("email");

-- CreateIndex
CREATE INDEX "pending_registration_email_idx" ON "identity"."pending_registration"("email");

-- CreateIndex
CREATE INDEX "pending_registration_expires_at_idx" ON "identity"."pending_registration"("expires_at");


-- Constraints Prisma cannot express, added by hand.
--
-- Email is normalised (trimmed, lowercased) in the domain before it ever
-- reaches here. This makes the database say so too, so a write path that
-- forgets fails loudly instead of quietly creating "A@b.com" alongside
-- "a@b.com" — two rows the unique index happily accepts and which are the same
-- account to every human involved.
ALTER TABLE "identity"."user" ADD CONSTRAINT "user_email_normalised_check"
  CHECK ("email" = lower(btrim("email")));

ALTER TABLE "identity"."pending_registration"
  ADD CONSTRAINT "pending_registration_email_normalised_check"
  CHECK ("email" = lower(btrim("email")));

-- An address that is neither empty nor missing its shape. Deliberately weak:
-- the real validation lives in the domain, and a database CHECK that tries to
-- be an RFC 5322 parser is a liability, not a safety net.
ALTER TABLE "identity"."user" ADD CONSTRAINT "user_email_shape_check"
  CHECK ("email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');

-- Argon2id and nothing else. If a future change introduces a different hasher,
-- this fails at the write rather than silently storing hashes the verifier
-- cannot read back.
ALTER TABLE "identity"."user" ADD CONSTRAINT "user_password_hash_argon2id_check"
  CHECK ("password_hash" LIKE '$argon2id$%');

ALTER TABLE "identity"."pending_registration"
  ADD CONSTRAINT "pending_registration_password_hash_argon2id_check"
  CHECK ("password_hash" LIKE '$argon2id$%');

-- Version only ever counts up from its default.
ALTER TABLE "identity"."user" ADD CONSTRAINT "user_version_check"
  CHECK ("version" >= 0);

-- A registration that expires before it was created is not a registration, it
-- is a bug.
ALTER TABLE "identity"."pending_registration"
  ADD CONSTRAINT "pending_registration_expiry_after_creation_check"
  CHECK ("expires_at" > "created_at");

-- 64 hex characters: SHA-256, and specifically *not* the raw token. Storing
-- the token itself would be the failure this column exists to prevent, and it
-- would not look wrong in a code review.
ALTER TABLE "identity"."pending_registration"
  ADD CONSTRAINT "pending_registration_token_hash_shape_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

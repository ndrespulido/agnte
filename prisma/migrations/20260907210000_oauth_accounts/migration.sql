-- AlterTable
ALTER TABLE "identity"."user" ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "identity"."oauth_account" (
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_account_pkey" PRIMARY KEY ("provider","provider_account_id")
);

-- CreateIndex
CREATE INDEX "oauth_account_user_id_idx" ON "identity"."oauth_account"("user_id");

-- AddForeignKey
ALTER TABLE "identity"."oauth_account" ADD CONSTRAINT "oauth_account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Constraints Prisma cannot express, added by hand.
--
-- Note the existing argon2id CHECK on "user"."password_hash" needs no change:
-- a CHECK passes when its expression is NULL, so a Google-only account with no
-- password satisfies it while any non-null value is still forced to be an
-- Argon2id PHC string. Verified rather than assumed — see the tests.

-- Known providers only. An unrecognised value here would mean sign-in code
-- that silently matches nothing, and a typo in a future provider name is
-- exactly the kind of thing that is discovered by a user, not a test.
ALTER TABLE "identity"."oauth_account" ADD CONSTRAINT "oauth_account_provider_check"
  CHECK ("provider" IN ('google'));

-- The provider's subject id is the whole identity. An empty one would collide
-- with the next empty one and merge two people's accounts.
ALTER TABLE "identity"."oauth_account"
  ADD CONSTRAINT "oauth_account_provider_account_id_check"
  CHECK (length("provider_account_id") > 0);

-- One account per person per provider. The primary key already stops one Google
-- identity being linked to two users; this stops one user collecting two Google
-- identities, which would make "sign out of Google everywhere" ambiguous and is
-- not a thing anyone asked for.
CREATE UNIQUE INDEX "oauth_account_one_per_provider_idx"
  ON "identity"."oauth_account" ("user_id", "provider");

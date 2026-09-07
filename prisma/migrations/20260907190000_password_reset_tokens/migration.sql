-- CreateTable
CREATE TABLE "identity"."password_reset_token" (
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "invalidated_at" TIMESTAMPTZ(3),

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE INDEX "password_reset_token_user_id_idx" ON "identity"."password_reset_token"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_token_expires_at_idx" ON "identity"."password_reset_token"("expires_at");

-- AddForeignKey
ALTER TABLE "identity"."password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Constraints Prisma cannot express, added by hand.

-- 64 hex characters: SHA-256, and specifically not the raw token.
ALTER TABLE "identity"."password_reset_token"
  ADD CONSTRAINT "password_reset_token_hash_shape_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "identity"."password_reset_token"
  ADD CONSTRAINT "password_reset_token_expiry_after_creation_check"
  CHECK ("expires_at" > "created_at");

-- The only query that runs on a reset: the live tokens for a user, so they can
-- all be invalidated when the password changes. Partial, because spent and
-- invalidated rows accumulate and are never selected by that predicate.
CREATE INDEX "password_reset_token_live_by_user_idx"
  ON "identity"."password_reset_token" ("user_id")
  WHERE "consumed_at" IS NULL AND "invalidated_at" IS NULL;

-- CreateTable
CREATE TABLE "identity"."refresh_token" (
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE INDEX "refresh_token_user_id_idx" ON "identity"."refresh_token"("user_id");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "identity"."refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "refresh_token_expires_at_idx" ON "identity"."refresh_token"("expires_at");

-- AddForeignKey
ALTER TABLE "identity"."refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Constraints Prisma cannot express, added by hand.

-- 64 hex characters: SHA-256, and specifically not the raw token. Storing the
-- token itself would be the failure this column exists to prevent, and it would
-- not look wrong in a code review.
ALTER TABLE "identity"."refresh_token"
  ADD CONSTRAINT "refresh_token_hash_shape_check"
  CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

-- A token that expires before it was created is not a token, it is a bug.
ALTER TABLE "identity"."refresh_token"
  ADD CONSTRAINT "refresh_token_expiry_after_creation_check"
  CHECK ("expires_at" > "created_at");

-- Partial index for the only query that runs on every refresh: find the live
-- tokens in a family so they can be revoked. Partial because a family's spent
-- tokens vastly outnumber its live one — rotation consumes one per refresh —
-- and indexing the dead rows would grow the index for a predicate that never
-- selects them.
CREATE INDEX "refresh_token_live_by_family_idx"
  ON "identity"."refresh_token" ("family_id")
  WHERE "consumed_at" IS NULL AND "revoked_at" IS NULL;

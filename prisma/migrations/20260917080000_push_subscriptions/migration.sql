-- Web Push subscriptions (Phase 7's second half, architecture.md §8.4).
--
-- One row per browser rather than per person: push is a capability of an
-- install, so the same account on a laptop and a phone is two rows and a
-- reminder goes to both.
--
-- No cross-schema foreign key on `user_id`, for the reason every other module's
-- owner column has none (§1.1). Erasure reaches these rows through the
-- notifications module's own purge, not through a cascade.

-- CreateTable
CREATE TABLE "notifications"."push_subscription" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

-- The endpoint is the subscription's real identity: it is the URL the push
-- service minted for this browser. Unique so that re-subscribing updates the
-- row instead of accumulating duplicates that all deliver the same
-- notification to the same device.
-- CreateIndex
CREATE UNIQUE INDEX "push_subscription_endpoint_key" ON "notifications"."push_subscription"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscription_user_id_idx" ON "notifications"."push_subscription"("user_id");

-- The key material is not optional: a row without it cannot be encrypted to,
-- so it would sit in the table failing forever.
ALTER TABLE "notifications"."push_subscription"
  ADD CONSTRAINT "push_subscription_keys_present"
  CHECK (length("p256dh") > 0 AND length("auth") > 0);

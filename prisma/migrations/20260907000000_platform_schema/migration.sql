-- The `platform` schema: cross-cutting infrastructure that belongs to no module
-- (docs/architecture.md §1.1, amended). Idempotency keys (§6) and rate-limit
-- windows (§8.6) are needed by identity, media and privacy alike; putting them
-- in one module's schema would create the cross-module dependency the module
-- boundaries exist to prevent.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateTable
CREATE TABLE "platform"."idempotency_key" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "platform"."rate_limit_window" (
    "bucket" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limit_window_pkey" PRIMARY KEY ("bucket","window_start")
);

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "platform"."idempotency_key"("expires_at");

-- CreateIndex
CREATE INDEX "rate_limit_window_window_start_idx" ON "platform"."rate_limit_window"("window_start");

-- Constraints Prisma's schema language cannot express.
--
-- The first keeps `status` to its two values without a Prisma enum, which in a
-- multi-schema setup costs more than it earns here. The second is the one that
-- matters: a row claiming to be completed must actually carry the response it
-- promises to replay, or a retry would return a 200 with no body and the
-- client would believe the write succeeded with an empty result.

ALTER TABLE "platform"."idempotency_key"
  ADD CONSTRAINT "idempotency_key_status_check"
  CHECK ("status" IN ('in_progress', 'completed'));

ALTER TABLE "platform"."idempotency_key"
  ADD CONSTRAINT "idempotency_key_completed_has_response_check"
  CHECK (
    "status" <> 'completed'
    OR ("response_status" IS NOT NULL AND "completed_at" IS NOT NULL)
  );

-- A count can only ever be incremented, never made negative by a bug in the
-- upsert that maintains it.
ALTER TABLE "platform"."rate_limit_window"
  ADD CONSTRAINT "rate_limit_window_count_check" CHECK ("count" >= 0);


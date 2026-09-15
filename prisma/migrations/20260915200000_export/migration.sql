-- Data export / GDPR portability (architecture.md §8.5, §8.7).
--
-- One row per request, in privacy's own schema. The row is the rate limit as
-- well as the record: §8.5 allows one export per user per 24h, and asking "when
-- did this person last ask" of the table that already has to exist is cheaper
-- and harder to get wrong than a second mechanism.

CREATE TABLE "privacy"."export_request" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,

    -- pending -> ready, or -> failed. A string with a CHECK rather than an
    -- enum, like every other status in this codebase.
    "status" TEXT NOT NULL DEFAULT 'pending',

    -- Where the finished export sits in object storage. Null until it is built;
    -- never returned to a caller, who gets a short-lived signed URL instead.
    "storage_key" TEXT,

    "error" TEXT,

    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "export_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- The rate-limit question — "what did this person ask for most recently" — and
-- the only query the request path makes.
CREATE INDEX "export_request_user_id_requested_at_idx"
    ON "privacy"."export_request"("user_id", "requested_at" DESC);

ALTER TABLE "privacy"."export_request"
    ADD CONSTRAINT "export_request_status_check"
    CHECK ("status" IN ('pending', 'ready', 'failed'));

-- A ready export has somewhere to read it from; a pending one does not yet.
-- Without this a bug could mark a row ready with nothing behind it, and the
-- caller would be handed a signed URL for an object that does not exist.
ALTER TABLE "privacy"."export_request"
    ADD CONSTRAINT "export_request_ready_has_key_check"
    CHECK ("status" <> 'ready' OR "storage_key" IS NOT NULL);

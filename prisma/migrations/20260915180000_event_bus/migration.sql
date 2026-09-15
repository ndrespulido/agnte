-- The event bus's two tables (architecture.md §1.2).
--
-- In `platform` rather than any module's schema: the bus is cross-cutting
-- infrastructure that belongs to no module, which is what §1.1's amendment
-- created that schema for.
--
-- The bus is in-process today. These tables exist anyway, and that is the
-- point: handler-level idempotency and dead-lettering are what make swapping
-- in Pub/Sub later an adapter change rather than a redesign, and a handler
-- written without them is a handler that cannot be re-delivered safely.

-- CreateTable
--
-- One row per (event, handler) pair that has run to completion. A redelivery
-- finds the row and does nothing, which is what "handlers must be idempotent
-- from day one" means in practice — the discipline is enforced here rather
-- than trusted to every handler author.
CREATE TABLE "platform"."event_handled" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "handled_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_handled_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateTable
--
-- Where a handler goes when it has failed its retries. Keeps the whole event,
-- not just the error: the payload is what a retry needs, and an event whose
-- body was discarded can only be investigated, never replayed.
CREATE TABLE "platform"."event_dead_letter" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_name" TEXT NOT NULL,
    "handler" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "event_dead_letter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- One dead letter per (event, handler): a retry that fails again updates the
-- existing row rather than stacking a second copy of the same failure.
CREATE UNIQUE INDEX "event_dead_letter_event_id_handler_key"
    ON "platform"."event_dead_letter"("event_id", "handler");

-- CreateIndex
CREATE INDEX "event_dead_letter_created_at_idx"
    ON "platform"."event_dead_letter"("created_at");

ALTER TABLE "platform"."event_dead_letter"
    ADD CONSTRAINT "event_dead_letter_attempts_check" CHECK ("attempts" >= 0);

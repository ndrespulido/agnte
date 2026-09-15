-- Right to erasure (architecture.md §8.7).
--
-- A soft delete and a grace window rather than an immediate DELETE. §8.7 asks
-- for thirty days, and the reason is not caution about the code: erasure is
-- irreversible and sometimes regretted, and an account recovered on day three
-- is a person helped rather than a support ticket that cannot be answered.

ALTER TABLE "identity"."user"
    ADD COLUMN "erasure_requested_at" TIMESTAMPTZ(3);

-- CreateIndex
--
-- The sweep's only query: accounts whose grace window has closed. Partial, so
-- it stays the size of the accounts actually awaiting erasure rather than the
-- size of the table.
CREATE INDEX "user_erasure_requested_at_idx"
    ON "identity"."user"("erasure_requested_at")
    WHERE "erasure_requested_at" IS NOT NULL;

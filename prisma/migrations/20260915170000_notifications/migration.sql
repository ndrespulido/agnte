-- Scheduled reminders (Phase 7, architecture.md §8.4).
--
-- The tables come from `prisma migrate diff`; the CHECK constraints below are
-- hand-added, following the rule the other modules' migrations follow: the
-- domain is where a rule is *explained* (modules/notifications/domain/), and
-- the constraint is where it cannot be bypassed by a future write path that
-- forgets.
--
-- No cross-schema foreign keys: `user_id` is a plain UUID pointing at
-- identity.user.id and `verse_id` at verse.verse.id, for the same reason every
-- other module's owner column is (§1.1).

-- CreateTable
CREATE TABLE "notifications"."scheduled_notification" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "verse_id" UUID,
    "fire_at" TIMESTAMPTZ(3) NOT NULL,
    "start_at" TIMESTAMPTZ(3) NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 0,
    "recurrence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "scheduled_notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications"."notification_preference" (
    "user_id" UUID NOT NULL,
    "quiet_start_minute" INTEGER,
    "quiet_end_minute" INTEGER,
    "time_zone" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
--
-- The dispatcher's only query: due, pending rows in fire order. Leading with
-- `status` keeps the index small as sent rows accumulate — they stop being
-- scanned rather than being skipped one by one.
CREATE INDEX "scheduled_notification_status_fire_at_idx"
    ON "notifications"."scheduled_notification"("status", "fire_at");

-- CreateIndex
CREATE INDEX "scheduled_notification_user_id_idx"
    ON "notifications"."scheduled_notification"("user_id");

-- The status vocabulary. A reminder is pending until it goes out, and failed
-- only once the dispatcher has given up on it — see the attempt limit there.
ALTER TABLE "notifications"."scheduled_notification"
    ADD CONSTRAINT "scheduled_notification_status_check"
    CHECK ("status" IN ('pending', 'sent', 'failed'));

-- Attempts and occurrences only ever count upwards.
ALTER TABLE "notifications"."scheduled_notification"
    ADD CONSTRAINT "scheduled_notification_counts_check"
    CHECK ("attempts" >= 0 AND "occurrences" >= 0);

-- A title nobody can read is not a reminder.
ALTER TABLE "notifications"."scheduled_notification"
    ADD CONSTRAINT "scheduled_notification_title_check"
    CHECK (length(btrim("title")) > 0);

-- Quiet hours are all-or-nothing.
--
-- Two of the three columns set is always a mistake — a window with no zone
-- would have to be resolved against *something*, and the only candidates are
-- UTC (wrong twice a year) or the server's zone (wrong always). The domain
-- explains why in quiet-hours.ts; this makes the half-configured row
-- unrepresentable rather than merely discouraged.
ALTER TABLE "notifications"."notification_preference"
    ADD CONSTRAINT "notification_preference_quiet_hours_check"
    CHECK (
        (
            "quiet_start_minute" IS NULL
            AND "quiet_end_minute" IS NULL
            AND "time_zone" IS NULL
        )
        OR (
            "quiet_start_minute" IS NOT NULL
            AND "quiet_end_minute" IS NOT NULL
            AND "time_zone" IS NOT NULL
            AND "quiet_start_minute" BETWEEN 0 AND 1439
            AND "quiet_end_minute" BETWEEN 0 AND 1439
            -- Equal ends read either as "never quiet" or "always quiet", and
            -- one of those silences every reminder forever.
            AND "quiet_start_minute" <> "quiet_end_minute"
        )
    );

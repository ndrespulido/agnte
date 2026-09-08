-- One ordering scale for the timeline (Phase 2.5).
--
-- A Verse sits in time in one of three ways: a calendar event, a deep-time
-- offset, or neither (in which case when it was written is the best answer).
-- Ordering across all three needs a single comparable number, because no
-- timestamp column can hold "66 million years ago" and no deep-time float
-- carries a time of day.
--
-- `timeline_years` is that number: years from 2000-01-01, positive into the
-- future. Deep time is nominally "years before present" while this is "years
-- from 2000"; the difference is a couple of decades, which at the magnitudes
-- deep time is used for (-13.8e9 has three significant figures) is far below
-- the precision of the data. Reconciling them exactly would mean a value that
-- changes as time passes, which cannot be indexed.
--
-- Maintained by the repository on every write rather than declared GENERATED:
-- Prisma cannot model a generated column, and a column the Prisma schema does
-- not know about is the same `migrate diff` landmine that nearly dropped
-- oauth_account_one_per_provider_idx.

-- Added nullable, backfilled, then made NOT NULL. Adding it NOT NULL in one
-- step — which is what `prisma migrate diff` generates — fails outright on a
-- table that already has rows.
ALTER TABLE "verse"."verse" ADD COLUMN "timeline_years" DOUBLE PRECISION;

-- 31557600 seconds is a Julian year (365.25 days), the same divisor the domain
-- uses. A constant divisor is what keeps the mapping reversible; calendar-aware
-- year arithmetic would not be.
UPDATE "verse"."verse"
SET "timeline_years" = COALESCE(
  "deep_time_years",
  EXTRACT(
    EPOCH FROM (COALESCE("event_start", "created_at") - TIMESTAMPTZ '2000-01-01 00:00:00+00')
  ) / 31557600.0
)
WHERE "timeline_years" IS NULL;

ALTER TABLE "verse"."verse" ALTER COLUMN "timeline_years" SET NOT NULL;

-- The timeline's index. `id` is the tiebreak that makes keyset pagination
-- stable when two verses land on the same year — without it a page boundary
-- can repeat or skip a row.
CREATE INDEX "verse_owner_id_timeline_years_id_idx"
  ON "verse"."verse" ("owner_id", "timeline_years", "id");

-- Superseded by the index above: both were prefixes of the same question, and
-- neither could order a page that mixes calendar and deep-time rows.
DROP INDEX "verse"."verse_owner_id_deep_time_years_id_idx";
DROP INDEX "verse"."verse_owner_id_event_start_id_idx";

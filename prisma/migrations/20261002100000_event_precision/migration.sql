-- ---------------------------------------------------------------------------
-- A date is not an instant (§2.1).
--
-- The app stored both in one `timestamptz` and rendered it in UTC, which made
-- each of them wrong in a different way. A typed "14:00" was stored as 14:00Z
-- regardless of where the typist was standing, so it is not the moment they
-- meant. And a genuine instant — a reminder's fire time, written through the
-- zone-aware reminder path — was displayed with UTC parts, so a reminder set
-- for 17:00 in Madrid read as 15:00 on the timeline. Same row, two times, one
-- app.
--
-- `event_precision` records which kind of fact the columns hold. At 'date' the
-- instant is exactly midnight UTC and only its UTC date parts carry meaning;
-- at 'minute' it is a real moment to be shown in the reader's own zone.
--
-- THE BACKFILL IS THE WHOLE POINT OF THE MIGRATION, so it is spelled out:
-- midnight UTC becomes 'date', anything else becomes 'minute'. That is not a
-- guess. The old client wrote a `datetime-local` value straight through as UTC,
-- so a date-only entry landed on exactly midnight and a timed one did not.
-- Reading existing rows this way is what makes the change a no-op on screen for
-- everything already written — which was the requirement, because the
-- alternative shifts somebody's record by their UTC offset and, west of
-- Greenwich, onto a different day.
-- ---------------------------------------------------------------------------
ALTER TABLE "verse"."verse" ADD COLUMN IF NOT EXISTS "event_precision" TEXT;

UPDATE "verse"."verse"
SET "event_precision" = CASE
  WHEN ("event_start" AT TIME ZONE 'UTC')::time = '00:00:00'
   AND ("event_end" IS NULL OR ("event_end" AT TIME ZONE 'UTC')::time = '00:00:00')
  THEN 'date'
  ELSE 'minute'
END
WHERE "event_start" IS NOT NULL
  AND "event_precision" IS NULL;

-- Present exactly when there is an event to describe. A precision with no
-- start describes nothing; a start with no precision is the ambiguity this
-- column exists to remove.
ALTER TABLE "verse"."verse"
  ADD CONSTRAINT "verse_event_precision_presence_check"
  CHECK (("event_precision" IS NULL) = ("event_start" IS NULL));

ALTER TABLE "verse"."verse"
  ADD CONSTRAINT "verse_event_precision_value_check"
  CHECK ("event_precision" IS NULL OR "event_precision" IN ('date', 'minute'));

-- The invariant the domain relies on when it renders a date without converting
-- it. Enforced here as well as in `parsePlacement` because a raw write path
-- that forgot would otherwise persist a date carrying a time of day, and the
-- symptom would be a verse that moves day when read from another zone.
ALTER TABLE "verse"."verse"
  ADD CONSTRAINT "verse_event_precision_date_is_midnight_check"
  CHECK (
    "event_precision" <> 'date'
    OR (
      ("event_start" AT TIME ZONE 'UTC')::time = '00:00:00'
      AND ("event_end" IS NULL OR ("event_end" AT TIME ZONE 'UTC')::time = '00:00:00')
    )
  );

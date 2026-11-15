-- The composer text a verse was made from, verbatim (architecture.md §12.3).
--
-- Nullable with no backfill: every existing verse was made through the form,
-- so there is nothing that was typed. The length limit mirrors the domain's
-- MAX_TYPED_TEXT_LENGTH, counted in characters as `char_length` does.
ALTER TABLE "verse"."verse" ADD COLUMN IF NOT EXISTS "typed_text" TEXT;

ALTER TABLE "verse"."verse"
  ADD CONSTRAINT "verse_typed_text_length_check"
  CHECK ("typed_text" IS NULL OR char_length("typed_text") <= 20000);

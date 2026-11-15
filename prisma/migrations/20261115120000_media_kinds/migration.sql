-- Media beyond images: voice notes, video and files (architecture.md §12.4).
--
-- The two CHECKs are widened, not removed. The type list stays closed and
-- mirrors the domain's table in modules/media/domain/media.ts; the size cap
-- becomes per kind — 15MB for everything except video, which gets 50MB.
ALTER TABLE "media"."media" DROP CONSTRAINT IF EXISTS "media_content_type_check";
ALTER TABLE "media"."media" ADD CONSTRAINT "media_content_type_check"
  CHECK ("content_type" IN (
    'image/jpeg',
    'image/png',
    'image/webp',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'application/pdf',
    'text/plain',
    'text/csv',
    'text/calendar',
    'text/vcard',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ));

ALTER TABLE "media"."media" DROP CONSTRAINT IF EXISTS "media_declared_size_check";
ALTER TABLE "media"."media" ADD CONSTRAINT "media_declared_size_check"
  CHECK (
    "declared_size_bytes" > 0
    AND "declared_size_bytes" <= CASE
      WHEN "content_type" LIKE 'video/%' THEN 50000000
      ELSE 15000000
    END
  );

-- Display only; never part of a storage key.
ALTER TABLE "media"."media" ADD COLUMN IF NOT EXISTS "file_name" TEXT;
ALTER TABLE "media"."media" ADD CONSTRAINT "media_file_name_length_check"
  CHECK ("file_name" IS NULL OR char_length("file_name") <= 200);

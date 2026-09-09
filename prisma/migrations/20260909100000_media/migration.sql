-- Media and its variants (Phase 4.2, architecture.md §8.3).
--
-- The tables come from `prisma migrate diff`; the CHECK constraints below are
-- hand-added, following the same rule verse's migrations do: the domain is
-- where a rule is *explained* (modules/media/domain/media.ts,
-- modules/media/domain/variant.ts), and the constraint is where it cannot be
-- bypassed by a future write path that forgets.
--
-- No cross-schema foreign keys: `owner_id` is a plain UUID pointing at
-- identity.user.id, for the same reason `Tag.ownerId` and `Verse.ownerId` are
-- (architecture.md §1.1).

-- CreateTable
CREATE TABLE "media"."media" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "content_type" TEXT NOT NULL,
    "declared_size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media"."media_variant" (
    "media_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_variant_pkey" PRIMARY KEY ("media_id","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_storage_key_key" ON "media"."media"("storage_key");

-- CreateIndex
CREATE INDEX "media_owner_id_idx" ON "media"."media"("owner_id");

-- AddForeignKey
ALTER TABLE "media"."media_variant" ADD CONSTRAINT "media_variant_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"."media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints the domain also enforces.
-- ---------------------------------------------------------------------------

-- The status is a closed set. A typo storing 'redy' would otherwise be a
-- value the state machine has never seen, and confirm/process handlers would
-- have to treat "any string that isn't one of the four" as a fifth case.
ALTER TABLE "media"."media" ADD CONSTRAINT "media_status_check"
  CHECK ("status" IN ('pending', 'processing', 'ready', 'failed'));

-- Only what the domain's ALLOWED_CONTENT_TYPES accepts.
ALTER TABLE "media"."media" ADD CONSTRAINT "media_content_type_check"
  CHECK ("content_type" IN ('image/jpeg', 'image/png', 'image/webp'));

-- Matches MAX_DECLARED_BYTES. A declared size of zero or less is nonsense; a
-- declared size above the cap is the thing the constant exists to refuse.
ALTER TABLE "media"."media" ADD CONSTRAINT "media_declared_size_check"
  CHECK ("declared_size_bytes" > 0 AND "declared_size_bytes" <= 15000000);

ALTER TABLE "media"."media" ADD CONSTRAINT "media_version_check"
  CHECK ("version" >= 0);

-- Exactly the two §8.3 names.
ALTER TABLE "media"."media_variant" ADD CONSTRAINT "media_variant_kind_check"
  CHECK ("kind" IN ('thumb', 'medium'));

ALTER TABLE "media"."media_variant" ADD CONSTRAINT "media_variant_dimensions_check"
  CHECK ("width" > 0 AND "height" > 0 AND "size_bytes" > 0);

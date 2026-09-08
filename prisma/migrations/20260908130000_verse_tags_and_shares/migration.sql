-- Verses, tags, and the two share tables (Phase 2.2).
--
-- The tables come from `prisma migrate diff`; the CHECK constraints below are
-- hand-added. They restate rules the domain already enforces, deliberately: the
-- domain is the place the rule is *explained*, and the constraint is the place
-- it cannot be bypassed by a future write path that forgets. Where the two
-- could drift, tests pin them together.
--
-- Note what has no foreign key: `owner_id` and `grantee_id` point at
-- identity.user.id and are plain UUIDs. Cross-schema foreign keys are exactly
-- what a later split into services would have to unpick (architecture.md §1.1).

-- CreateTable
CREATE TABLE "verse"."tag" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "display_name" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "shortcut" TEXT,
    "vertical" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verse"."verse" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "event_start" TIMESTAMPTZ(3),
    "event_end" TIMESTAMPTZ(3),
    "deep_time_years" DOUBLE PRECISION,
    "location" TEXT,
    "rating" DOUBLE PRECISION,
    "xp" TEXT,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "visibility" TEXT,
    "media_ids" UUID[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "verse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verse"."verse_tag" (
    "verse_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "verse_tag_pkey" PRIMARY KEY ("verse_id","tag_id")
);

-- CreateTable
CREATE TABLE "verse"."tag_share" (
    "tag_id" UUID NOT NULL,
    "grantee_id" UUID NOT NULL,
    "permission" TEXT NOT NULL DEFAULT 'read',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tag_share_pkey" PRIMARY KEY ("tag_id","grantee_id")
);

-- CreateTable
CREATE TABLE "verse"."verse_share" (
    "verse_id" UUID NOT NULL,
    "grantee_id" UUID NOT NULL,
    "permission" TEXT NOT NULL DEFAULT 'read',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verse_share_pkey" PRIMARY KEY ("verse_id","grantee_id")
);

-- CreateIndex
CREATE INDEX "tag_owner_id_idx" ON "verse"."tag"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "tag_owner_id_name_key" ON "verse"."tag"("owner_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "tag_owner_id_shortcut_key" ON "verse"."tag"("owner_id", "shortcut");

-- CreateIndex
CREATE INDEX "verse_owner_id_event_start_id_idx" ON "verse"."verse"("owner_id", "event_start", "id");

-- CreateIndex
CREATE INDEX "verse_owner_id_deep_time_years_id_idx" ON "verse"."verse"("owner_id", "deep_time_years", "id");

-- CreateIndex
CREATE INDEX "verse_owner_id_created_at_id_idx" ON "verse"."verse"("owner_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "verse_tag_tag_id_idx" ON "verse"."verse_tag"("tag_id");

-- CreateIndex
CREATE INDEX "tag_share_grantee_id_idx" ON "verse"."tag_share"("grantee_id");

-- CreateIndex
CREATE INDEX "verse_share_grantee_id_idx" ON "verse"."verse_share"("grantee_id");

-- AddForeignKey
ALTER TABLE "verse"."verse_tag" ADD CONSTRAINT "verse_tag_verse_id_fkey" FOREIGN KEY ("verse_id") REFERENCES "verse"."verse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verse"."verse_tag" ADD CONSTRAINT "verse_tag_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "verse"."tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verse"."tag_share" ADD CONSTRAINT "tag_share_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "verse"."tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verse"."verse_share" ADD CONSTRAINT "verse_share_verse_id_fkey" FOREIGN KEY ("verse_id") REFERENCES "verse"."verse"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints the domain also enforces.
-- ---------------------------------------------------------------------------

-- Visibility is a closed set. A typo storing 'pubic' would otherwise be a value
-- the resolver has never seen, and an unrecognised value in a security decision
-- is the worst kind of unknown.
ALTER TABLE "verse"."tag" ADD CONSTRAINT "tag_visibility_check"
  CHECK ("visibility" IN ('private', 'shared', 'public'));

-- Nullable on a verse: NULL means "inherit from my tags". The constraint has to
-- allow it while still closing the set of non-null values.
ALTER TABLE "verse"."verse" ADD CONSTRAINT "verse_visibility_check"
  CHECK ("visibility" IS NULL OR "visibility" IN ('private', 'shared', 'public'));

ALTER TABLE "verse"."tag_share" ADD CONSTRAINT "tag_share_permission_check"
  CHECK ("permission" IN ('read', 'contribute'));

ALTER TABLE "verse"."verse_share" ADD CONSTRAINT "verse_share_permission_check"
  CHECK ("permission" IN ('read', 'contribute'));

-- Tag names are stored normalised and without the leading dot. A write path
-- that forgets to normalise fails loudly here rather than creating a second
-- `.Barcelona` sitting alongside `.barcelona` — which the unique index on
-- (owner_id, name) would happily allow, since they differ as strings.
ALTER TABLE "verse"."tag" ADD CONSTRAINT "tag_name_shape_check"
  CHECK ("name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "verse"."tag" ADD CONSTRAINT "tag_shortcut_shape_check"
  CHECK ("shortcut" IS NULL OR "shortcut" ~ '^[a-z0-9]{1,8}$');

ALTER TABLE "verse"."tag" ADD CONSTRAINT "tag_vertical_check"
  CHECK ("vertical" IS NULL OR
         "vertical" IN ('flight', 'hotel', 'restaurant', 'concert', 'movie'));

-- Calendar or deep time, never both (CLAUDE.md). The domain makes this
-- unrepresentable via a union; here it is a constraint, so a row written by any
-- other route still cannot hold both.
ALTER TABLE "verse"."verse" ADD CONSTRAINT "verse_time_exclusive_check"
  CHECK ("deep_time_years" IS NULL
         OR ("event_start" IS NULL AND "event_end" IS NULL));

-- An end with no start is a missing start, not a range.
ALTER TABLE "verse"."verse" ADD CONSTRAINT "verse_event_end_needs_start_check"
  CHECK ("event_end" IS NULL OR "event_start" IS NOT NULL);

ALTER TABLE "verse"."verse" ADD CONSTRAINT "verse_event_order_check"
  CHECK ("event_end" IS NULL OR "event_end" >= "event_start");

ALTER TABLE "verse"."verse" ADD CONSTRAINT "verse_deep_time_range_check"
  CHECK ("deep_time_years" IS NULL
         OR ("deep_time_years" >= -14000000000 AND "deep_time_years" <= 10000000000));

ALTER TABLE "verse"."verse" ADD CONSTRAINT "verse_rating_range_check"
  CHECK ("rating" IS NULL OR ("rating" >= 0 AND "rating" <= 10));

-- Properties are a flat object of scalars. The domain refuses arrays and nested
-- objects so search never indexes a blob of braces; this stops a top-level
-- array or string being stored as the whole bag.
ALTER TABLE "verse"."verse" ADD CONSTRAINT "verse_properties_object_check"
  CHECK (jsonb_typeof("properties") = 'object');

ALTER TABLE "verse"."verse" ADD CONSTRAINT "verse_version_check"
  CHECK ("version" >= 0);

ALTER TABLE "verse"."tag" ADD CONSTRAINT "tag_version_check"
  CHECK ("version" >= 0);

-- A verse must carry at least one tag (CLAUDE.md). That cannot be a CHECK — it
-- is a statement about another table — and a trigger enforcing it would fire
-- during the window between inserting a verse and inserting its first tag row.
-- So it is enforced in the domain and in the repository's transaction, and this
-- comment is here so the next reader does not go looking for the constraint.

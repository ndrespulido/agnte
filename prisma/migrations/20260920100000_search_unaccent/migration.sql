-- ---------------------------------------------------------------------------
-- Accent-insensitive search (architecture.md §8.2).
--
-- `to_tsvector('simple', ...)` keeps accents, so "café" is stored as 'café'
-- and a search for "cafe" matches nothing. On a timeline written partly in
-- Spanish that is not an edge case: "mañana", "León", "años" are ordinary
-- words, and typing them without the accent is how most people type them on
-- a keyboard that does not have one to hand.
--
-- `unaccent()` folds them on both sides — stored and searched — so the two
-- always meet in the middle. Applied here rather than in the application
-- because the vector is built in SQL and the two halves have to agree; a
-- fold done in TypeScript on the way in would leave the stored side accented.
--
-- Note this is *not* stemming. "olives" still will not find "olive": that
-- needs a per-language configuration, which §8.2 calls for and nothing has
-- built yet.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS unaccent;

-- Every existing row, because a vector built the old way and a query folded
-- the new way would stop matching what it used to. The whole column is
-- rewritten; there is no partial state where half the table is folded.
UPDATE "verse"."verse" v
SET "search_vector" =
  setweight(to_tsvector('simple', unaccent(coalesce(v."xp", ''))), 'A') ||
  setweight(
    to_tsvector(
      'simple',
      unaccent(
        coalesce((SELECT string_agg(value, ' ') FROM jsonb_each_text(v."properties")), '')
      )
    ),
    'B'
  ) ||
  setweight(
    to_tsvector(
      'simple',
      unaccent(
        coalesce(
          (
            SELECT string_agg(replace(t."name", '-', ' '), ' ')
            FROM "verse"."verse_tag" vt
            JOIN "verse"."tag" t ON t."id" = vt."tag_id"
            WHERE vt."verse_id" = v."id"
          ),
          ''
        )
      )
    ),
    'C'
  );

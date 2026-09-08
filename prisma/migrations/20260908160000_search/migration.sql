-- Full-text search (Phase 2.7, architecture.md §8.2).
--
-- The vector holds `xp` (weight A), the values of the free-form properties
-- (B), and the names of the tags the verse carries (C). Weighting is what makes
-- a note *about* Barcelona rank above one merely tagged `.barcelona-trip`.
--
-- ---------------------------------------------------------------------------
-- Why 'simple' and not 'english'.
--
-- §8.2 asks for a text-search configuration per user locale. A single stored
-- vector cannot serve three languages: indexing Spanish prose with the English
-- stemmer produces wrong stems, and the failure is silent — the word is simply
-- never found. 'simple' does no stemming at all, so it is correct in every
-- language and merely less powerful in each: "films" will not match "film".
--
-- That is the safe half of the trade. Getting stemming back means either a
-- per-verse language column with one vector per language, or deciding the app
-- is monolingual. Neither belongs in this task, and choosing 'english' now
-- would look like it worked while quietly failing on half the user's own data.
--
-- The trigram index below softens it: a fuzzy tag match catches much of what
-- stemming would have.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "verse"."verse" ADD COLUMN "search_vector" tsvector;

-- Maintained by the repository on every write, not GENERATED: a generated
-- column cannot reference another table, and the tag names live in one. That is
-- also why renaming a tag has to rewrite its verses' vectors — see
-- `refreshSearchForTag`.
UPDATE "verse"."verse" v
SET "search_vector" =
  setweight(to_tsvector('simple', coalesce(v."xp", '')), 'A') ||
  setweight(
    to_tsvector(
      'simple',
      coalesce((SELECT string_agg(value, ' ') FROM jsonb_each_text(v."properties")), '')
    ),
    'B'
  ) ||
  setweight(
    to_tsvector(
      'simple',
      coalesce(
        (
          SELECT string_agg(replace(t."name", '-', ' '), ' ')
          FROM "verse"."verse_tag" vt
          JOIN "verse"."tag" t ON t."id" = vt."tag_id"
          WHERE vt."verse_id" = v."id"
        ),
        ''
      )
    ),
    'C'
  );

CREATE INDEX "verse_search_vector_idx" ON "verse"."verse" USING GIN ("search_vector");

-- Fuzzy tag and shortcut matching (§8.2): typing "barclona" should still find
-- `.barcelona-trip`.
CREATE INDEX "tag_name_idx" ON "verse"."tag" USING GIN ("name" gin_trgm_ops);

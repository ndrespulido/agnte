-- ---------------------------------------------------------------------------
-- Substring search, replacing full text (architecture.md §8.2).
--
-- Postgres tokenises on whitespace and Chinese has none, so
-- `to_tsvector('simple', '我今天去了巴塞罗那吃饭')` is one lexeme — the whole
-- sentence — and searching for 巴塞罗那 inside it matches nothing. Neither
-- `zhparser` nor `pg_jieba` is available here, so there is no configuration
-- that fixes it: full-text search cannot see inside Chinese text on this
-- database.
--
-- A substring match treats text as text and behaves identically in every
-- script. It gives up stemming and ranking, neither of which worked for
-- Chinese in the first place.
--
-- So the denormalised vector goes. It was a copy of xp, the property values
-- and the tag names, maintained on every verse write and on every tag rename;
-- nothing reads it now, and a denormalisation nobody reads is one that drifts
-- silently.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "verse"."verse_search_vector_idx";
ALTER TABLE "verse"."verse" DROP COLUMN IF EXISTS "search_vector";

-- No trigram index yet, deliberately.
--
-- `unaccent()` is STABLE rather than IMMUTABLE, so indexing an expression that
-- uses it needs an IMMUTABLE wrapper function — machinery this does not yet
-- need. A personal timeline is thousands of rows, where a sequential scan is
-- faster than the planner's estimate of an index, and the search is capped at
-- 20 rows. Adding it later is one migration; adding it now is a function to
-- maintain for a scale that does not exist.

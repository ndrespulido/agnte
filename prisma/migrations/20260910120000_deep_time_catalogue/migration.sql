-- The shared deep-time catalogue (Phase 6, CLAUDE.md).
--
-- Every user's past scroll eventually runs out of their own life. What it runs
-- into is this: one ownerless table, identical for everybody, so there is no
-- owner_id, no visibility to resolve, and nothing per-user to invalidate.
--
-- `timeline_years` is deliberately the same axis verse.timeline_years uses —
-- years from 2000-01-01, negative into the past — so a catalogue entry and a
-- Verse are directly comparable. They are still never joined: insights owns
-- this table and verse owns its own, and the merge happens in the client from
-- two API calls (§1.1: no cross-schema joins).

CREATE TABLE "insights"."deep_time_event" (
  "id" UUID NOT NULL,
  "slug" TEXT NOT NULL,
  "timeline_years" DOUBLE PRECISION NOT NULL,
  "title" TEXT NOT NULL,
  "detail" TEXT,
  "category" TEXT NOT NULL,

  CONSTRAINT "deep_time_event_pkey" PRIMARY KEY ("id"),
  -- Four buckets, checked here for the same reason media.status is: the
  -- constraint belongs next to the table, and a typo in a later seed migration
  -- should fail loudly rather than produce a category nothing renders.
  CONSTRAINT "deep_time_event_category_check"
    CHECK ("category" IN ('cosmic', 'geological', 'life', 'human'))
);

-- The natural key. Adding events in a later migration is then an
-- ON CONFLICT DO NOTHING away, with no dependency on generated ids.
CREATE UNIQUE INDEX "deep_time_event_slug_key"
  ON "insights"."deep_time_event" ("slug");

-- Reads walk backwards from a cutoff, so this matches the query exactly. `id`
-- is the tiebreak that keeps keyset pagination stable when two events share a
-- year — which, at these magnitudes, several do.
CREATE INDEX "deep_time_event_timeline_years_id_idx"
  ON "insights"."deep_time_event" ("timeline_years", "id");

-- ---------------------------------------------------------------------------
-- The catalogue.
--
-- Seeded here rather than by an operator step, because a catalogue present in
-- one environment and absent in another shows up only as a timeline that
-- mysteriously stops early — and every environment, preview branches included,
-- should show the same history.
--
-- Years are from 2000, so 1969 is -31. At the magnitudes above a million the
-- difference between "before present" and "before 2000" is far below the
-- precision of the figure itself (-13.8e9 has three significant figures), which
-- is the same reasoning the timeline_years migration sets out.
--
-- Deliberately short. This is context for the end of a scroll, not an
-- encyclopedia: enough that each order of magnitude has something in it, chosen
-- so the gaps are legible rather than exhaustive.
-- ---------------------------------------------------------------------------
INSERT INTO "insights"."deep_time_event"
  ("id", "slug", "timeline_years", "title", "detail", "category")
VALUES
  ('018f0000-0000-7000-8000-000000000001', 'big-bang', -13800000000,
   'The Big Bang', 'Space, time and matter begin.', 'cosmic'),
  ('018f0000-0000-7000-8000-000000000002', 'first-stars', -13600000000,
   'The first stars', 'Hydrogen collapses and begins to burn.', 'cosmic'),
  ('018f0000-0000-7000-8000-000000000003', 'milky-way', -13600000000,
   'The Milky Way forms', NULL, 'cosmic'),
  ('018f0000-0000-7000-8000-000000000004', 'sun-forms', -4600000000,
   'The Sun ignites', NULL, 'cosmic'),
  ('018f0000-0000-7000-8000-000000000005', 'earth-forms', -4540000000,
   'Earth forms', 'Accreted from the debris left over around the young Sun.', 'geological'),
  ('018f0000-0000-7000-8000-000000000006', 'moon-forms', -4510000000,
   'The Moon forms', 'A Mars-sized body strikes Earth; the debris coalesces.', 'geological'),
  ('018f0000-0000-7000-8000-000000000007', 'oceans', -4400000000,
   'Liquid water oceans', NULL, 'geological'),
  ('018f0000-0000-7000-8000-000000000008', 'first-life', -3700000000,
   'The first life', 'Single cells, and every living thing descends from them.', 'life'),
  ('018f0000-0000-7000-8000-000000000009', 'photosynthesis', -3400000000,
   'Photosynthesis', NULL, 'life'),
  ('018f0000-0000-7000-8000-00000000000a', 'great-oxidation', -2400000000,
   'The Great Oxidation', 'Free oxygen fills the air and poisons most of what made it.', 'life'),
  ('018f0000-0000-7000-8000-00000000000b', 'eukaryotes', -1800000000,
   'Complex cells', 'One cell swallows another and keeps it — mitochondria.', 'life'),
  ('018f0000-0000-7000-8000-00000000000c', 'multicellular', -600000000,
   'Multicellular life', NULL, 'life'),
  ('018f0000-0000-7000-8000-00000000000d', 'cambrian', -538800000,
   'The Cambrian explosion', 'Most major animal groups appear in a geological instant.', 'life'),
  ('018f0000-0000-7000-8000-00000000000e', 'land-plants', -470000000,
   'Plants reach land', NULL, 'life'),
  ('018f0000-0000-7000-8000-00000000000f', 'permian-extinction', -251900000,
   'The Great Dying', 'The largest extinction: around nine in ten marine species end.', 'life'),
  ('018f0000-0000-7000-8000-000000000010', 'first-dinosaurs', -233000000,
   'The first dinosaurs', NULL, 'life'),
  ('018f0000-0000-7000-8000-000000000011', 'first-mammals', -225000000,
   'The first mammals', NULL, 'life'),
  ('018f0000-0000-7000-8000-000000000012', 'flowering-plants', -140000000,
   'Flowers', NULL, 'life'),
  ('018f0000-0000-7000-8000-000000000013', 'chicxulub', -66000000,
   'The asteroid', 'Chicxulub ends the non-avian dinosaurs and opens the way for mammals.', 'life'),
  ('018f0000-0000-7000-8000-000000000014', 'primates', -55000000,
   'The first primates', NULL, 'life'),
  ('018f0000-0000-7000-8000-000000000015', 'hominins', -7000000,
   'The human and chimpanzee lines part', NULL, 'life'),
  ('018f0000-0000-7000-8000-000000000016', 'stone-tools', -3300000,
   'The first stone tools', NULL, 'human'),
  ('018f0000-0000-7000-8000-000000000017', 'fire', -1000000,
   'The control of fire', NULL, 'human'),
  ('018f0000-0000-7000-8000-000000000018', 'homo-sapiens', -300000,
   'Homo sapiens', 'Anatomically modern humans, in Africa.', 'human'),
  ('018f0000-0000-7000-8000-000000000019', 'cave-painting', -45000,
   'The first cave paintings', NULL, 'human'),
  ('018f0000-0000-7000-8000-00000000001a', 'agriculture', -12000,
   'Agriculture', 'Planting rather than following: the beginning of staying put.', 'human'),
  ('018f0000-0000-7000-8000-00000000001b', 'writing', -5200,
   'Writing', 'Cuneiform in Sumer — the first time a record outlives the rememberer.', 'human'),
  ('018f0000-0000-7000-8000-00000000001c', 'great-pyramid', -4560,
   'The Great Pyramid', NULL, 'human'),
  ('018f0000-0000-7000-8000-00000000001d', 'printing-press', -550,
   'The printing press', NULL, 'human'),
  ('018f0000-0000-7000-8000-00000000001e', 'photograph', -174,
   'The first photograph', 'A view from a window, an eight-hour exposure.', 'human'),
  ('018f0000-0000-7000-8000-00000000001f', 'powered-flight', -97,
   'Powered flight', NULL, 'human'),
  ('018f0000-0000-7000-8000-000000000020', 'moon-landing', -31,
   'The Moon landing', NULL, 'human')
ON CONFLICT ("slug") DO NOTHING;

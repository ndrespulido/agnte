-- ============================================================
-- Agnte — v1 Database Schema (PostgreSQL)
-- ============================================================
-- Chosen because the Verse model is inherently semi-structured
-- (dynamic properties per Verse) while still needing real
-- relational joins for Tags and range queries for the timeline
-- and location inheritance. Postgres' JSONB + GIN indexing covers
-- the dynamic-properties need without giving up SQL joins/ranges.
-- ============================================================

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ----------------------------------------------------------
-- USERS
-- v1 is single-user in practice, but every row is owned by a
-- user from day one so multi-user / sharing (v2+) is not a
-- schema migration later, just an unlocked feature.
-- ----------------------------------------------------------
create table users (
    id            uuid primary key default gen_random_uuid(),
    email         text not null unique,
    display_name  text,
    created_at    timestamptz not null default now()
);

-- ----------------------------------------------------------
-- LOCATIONS
-- Normalized so many Verses can point at "Barcelona, Spain"
-- without repeating lat/lng text everywhere, and so location
-- inheritance (below) has a stable id to compare.
-- ----------------------------------------------------------
create table locations (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid not null references users(id) on delete cascade,
    name        text not null,               -- "Barcelona, Spain"
    lat         numeric(9,6),
    lng         numeric(9,6),
    place_ref   text,                        -- optional external place id (e.g. Google Places)
    created_at  timestamptz not null default now(),
    unique (user_id, name) -- Phase 5: reuse the same Location row when the same place name is logged again, rather than creating duplicates
);

create index idx_locations_user on locations(user_id);

-- ----------------------------------------------------------
-- TAGS
-- Stored without the leading dot; the UI renders ".barcelona-trip".
-- is_vertical + default_properties marks the 5 v1 verticals
-- (flight/hotel/restaurant/concert/movie) so the create-Verse
-- form knows which fields to suggest — this is UI convenience
-- metadata only, never enforced at the database level.
-- ----------------------------------------------------------
create table tags (
    id                    uuid primary key default gen_random_uuid(),
    user_id               uuid not null references users(id) on delete cascade,
    name                  text not null,              -- 'barcelona-trip', 'flight', 'option', 'decision'
    is_vertical           boolean not null default false,
    default_properties    jsonb,                       -- e.g. [{"key":"airline","label":"Airline","type":"text"}, ...]
    created_at            timestamptz not null default now(),
    unique (user_id, name)
);

create index idx_tags_user on tags(user_id);

-- ----------------------------------------------------------
-- VERSES
-- The atomic unit. properties is a free-form JSONB bag — no
-- fixed schema per vertical, per §2.1/§3.1 of the requirements
-- doc. event_start/event_end can be past, present, or future.
-- location_id is only set when THIS Verse explicitly establishes
-- or overrides a location; inherited location is resolved at
-- query time (see resolve_verse_location() below), not stored.
-- ----------------------------------------------------------
create table verses (
    id                uuid primary key default gen_random_uuid(),
    user_id           uuid not null references users(id) on delete cascade,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    event_start       timestamptz,
    event_end         timestamptz,
    -- Phase 9: for events outside calendar range (timestamptz caps out
    -- around 4713 BC / 294276 AD -- nowhere near deep time). Negative =
    -- years before present. Mutually exclusive with event_start/
    -- event_end -- enforced at the API layer, not here, since it's a
    -- multi-column business rule rather than a simple column check.
    deep_time_years   double precision,
    location_id       uuid references locations(id) on delete set null,
    rating            smallint check (rating between 0 and 10),
    xp                text,
    properties        jsonb not null default '{}'::jsonb,
    check (event_end is null or event_start is null or event_end >= event_start)
);

create index idx_verses_user on verses(user_id);
create index idx_verses_event_range on verses using gist (
    tstzrange(coalesce(event_start, created_at), coalesce(event_end, event_start, created_at), '[]')
);
create index idx_verses_properties on verses using gin (properties);

-- keep updated_at current on every edit
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_verses_updated_at
before update on verses
for each row execute function set_updated_at();

-- ----------------------------------------------------------
-- VERSE_TAGS (many-to-many)
-- This join table IS the "link" mechanism discussed in the
-- requirements doc — an options-stage and decision-stage Verse
-- are connected only by sharing rows here, nothing more.
-- ----------------------------------------------------------
create table verse_tags (
    verse_id  uuid not null references verses(id) on delete cascade,
    tag_id    uuid not null references tags(id) on delete cascade,
    primary key (verse_id, tag_id)
);

create index idx_verse_tags_tag on verse_tags(tag_id);

-- ----------------------------------------------------------
-- MEDIA
-- A Verse can be nothing but a set of these (per the
-- "minimal Verse" rule) — photos, a voice note, a document.
-- position lets a multi-photo Verse keep a stable order.
-- ----------------------------------------------------------
create table media (
    id          uuid primary key default gen_random_uuid(),
    verse_id    uuid not null references verses(id) on delete cascade,
    type        text not null check (type in ('image', 'voice_note', 'document', 'video')),
    storage_url text not null,
    position    integer not null default 0,
    created_at  timestamptz not null default now()
);

create index idx_media_verse on media(verse_id);

-- ============================================================
-- HISTORICAL_EVENTS (Phase 9)
-- ============================================================
-- The shared reference layer: generic historical/prehistoric
-- milestones visible to every user for context, once their own
-- timeline's past scroll runs past their own Verses. Global, not
-- scoped to a user_id. Seeded by prisma/seed.mjs in the app scaffold.
-- ============================================================

create table historical_events (
    id                 uuid primary key default gen_random_uuid(),
    title              text not null unique,
    description        text,
    years_from_present double precision not null, -- negative = years before present, at seed time
    category           text not null, -- 'cosmology' | 'geology' | 'biology' | 'human-prehistory' | 'history'
    created_at         timestamptz not null default now()
);

create index idx_historical_events_years on historical_events(years_from_present);

-- ============================================================
-- LOCATION INHERITANCE
-- ============================================================
-- A Verse's *resolved* location is:
--   1. its own location_id, if set — explicit always wins;
--   2. otherwise, the location of whichever OTHER Verse
--      establishes a date range (has both event_start and
--      event_end AND a location_id) that contains this Verse's
--      own event_start (or created_at, if it has no event_start);
--   3. if more than one range-establishing Verse overlaps,
--      the narrowest range wins; ties broken by most recently
--      created. (This tie-break is the open item flagged in
--      §7 of the requirements doc — revisit once real trip data
--      shows whether that rule actually matches intuition.)
-- Split into two functions (Phase 5) so the *source* Verse
-- (needed for "inherited from X" in the UI, see lib/location.ts
-- in the app scaffold) and the *resolved location* share one
-- narrowing rule instead of two copies of the same WHERE clause.
-- resolve_verse_location_source() is the single source of truth
-- for the rule; resolve_verse_location() is a thin wrapper kept
-- for any consumer that only needs the location.
-- ============================================================

create or replace function resolve_verse_location_source(p_verse_id uuid)
returns uuid as $$
declare
    v_user_id uuid;
    v_own_location uuid;
    v_anchor timestamptz;
    v_source uuid;
begin
    select user_id, location_id, coalesce(event_start, created_at)
      into v_user_id, v_own_location, v_anchor
      from verses where id = p_verse_id;

    if v_own_location is not null then
        return null; -- this Verse has an explicit location; nothing to inherit
    end if;

    select v.id into v_source
      from verses v
     where v.user_id = v_user_id
       and v.id <> p_verse_id
       and v.location_id is not null
       and v.event_start is not null
       and v.event_end is not null
       and v_anchor between v.event_start and v.event_end
     order by (v.event_end - v.event_start) asc, v.created_at desc
     limit 1;

    return v_source; -- null if nothing establishes a location for this window
end;
$$ language plpgsql stable;

create or replace function resolve_verse_location(p_verse_id uuid)
returns uuid as $$
declare
    v_own_location uuid;
    v_source uuid;
begin
    select location_id into v_own_location from verses where id = p_verse_id;
    if v_own_location is not null then
        return v_own_location;
    end if;

    v_source := resolve_verse_location_source(p_verse_id);
    if v_source is null then
        return null;
    end if;

    return (select location_id from verses where id = v_source);
end;
$$ language plpgsql stable;

-- ============================================================
-- EXAMPLE QUERIES
-- ============================================================

-- Timeline centered on today (paginate outward from now in the app layer)
-- select * from verses where user_id = :uid order by coalesce(event_start, created_at);

-- Filter by tags, AND (intersection) — Verses carrying ALL given tags:
-- select v.* from verses v
-- where v.id in (
--   select verse_id from verse_tags vt
--   join tags t on t.id = vt.tag_id
--   where t.user_id = :uid and t.name = any(:tag_names)
--   group by verse_id
--   having count(distinct t.name) = array_length(:tag_names, 1)
-- );

-- Filter by tags, OR (union) — Verses carrying ANY given tag:
-- select distinct v.* from verses v
-- join verse_tags vt on vt.verse_id = v.id
-- join tags t on t.id = vt.tag_id
-- where t.user_id = :uid and t.name = any(:tag_names);

-- Resolved location for a given Verse:
-- select resolve_verse_location(:verse_id);

# Agnte — Requirements Document v2 (Version 1 scope, ready to build against)

> This version replaces the broad v1 draft's scope section. Everything in the original doc (`agnte-requirements-v1.md`) about later use cases — medication chains, pets, tattoo portfolios, confidential mode, multi-cloud infra — is still a valid idea bank for v2+, but is **not** part of this build. This document defines only what we're building first.

---

## 1. V1 Vision

> **"A timeline for your life — write to it like a journal, query it like a database."**

A journal-and-timeline hybrid. The main screen is a **timeline centered on today**, scrollable into the past and future. You capture experiences as **Verses**. Every Verse belongs to one or more **Tags**, and a Tag is itself both a classification and a filterable sub-timeline with its own dashboard.

**V1's proving ground is travel and event planning** — flights, hotels, restaurants, concerts, movies — because it's the use case that exercises every core mechanic at once: open-ended date planning, decision-making between options, location context, multi-item classification, and logging both forward (a planned trip) and backward (something already lived).

---

## 2. Core Concepts (v1 definitions — supersedes v1 draft's "template" language)

### 2.1 Verse
The atomic unit. Every Verse has:

| Field | Description |
|---|---|
| `id` | Unique identifier |
| `created_at` | Set automatically, not editable — when the Verse was actually logged |
| `updated_at` | Set automatically on every edit |
| `event_start` / `event_end` | Optional. The time the Verse *refers to* — a single instant, or a range (e.g. a flight's departure→arrival, a hotel stay's check-in→check-out). If unset, the Verse simply lives at its creation date. **Can be set freely in the future (a planned trip) or the past (logging something that already happened)** — the timeline isn't restricted to "now forward." |
| `location` | Optional. Can be explicit, or **inherited** (see §2.3). |
| `rating` | 0–10, optional |
| `xp` | Free-text "experience" note, optional |
| `tags[]` | One or more Tags this Verse belongs to (see §2.2) — required, at least one |
| `properties{}` | **Dynamic, user-defined key/value pairs** — not a fixed schema per category. You can add whatever properties make sense for that Verse (e.g. `airline`, `seat`, `confirmation_code`) as you go. |
| `media[]` | Attached photos, voice notes, documents |

Note the change from the v1 draft: there is **no fixed "template" object** gating what fields exist. A Verse's shape is whatever properties you add to it. Tags are what give a *family* of Verses a consistent look on their dashboard (see §2.4 and §3.1), not a rigid schema.

**A Verse can be minimal.** Nothing beyond a Tag is actually required — going to a restaurant, you can create a Verse that's just a set of photos (or a voice note, or a plain text note) plus a location and a Tag, with no other properties filled in at all. The vertical form in §3.1 is a convenience, never a requirement.

### 2.2 Tags
- Written with a leading dot: `.expenses`, `.restaurant`, `.beach`, `.barcelona-trip`.
- **A Verse can belong to many Tags simultaneously** — think of Tags as the tables a Verse's row is stored in, not folders it sits inside. A restaurant bill in Barcelona might carry `.barcelona-trip`, `.restaurant`, and `.expenses` all at once.
- Tags are themselves navigable as sub-timelines: opening `.barcelona-trip` shows only Verses carrying that tag, in date order, centered on today the same way the general timeline is.

### 2.3 Location inheritance
If a Verse establishes a location for a date range (e.g., a confirmed flight/hotel puts you "in Barcelona" from `event_start` to `event_end`), any other Verse whose `event_start`/`created_at` falls inside that range **inherits that location by default**, unless it's explicitly overridden on that Verse. This is what lets you log a restaurant visit without manually re-typing "Barcelona" every time.

### 2.4 Timeline & filtering
- **General timeline** = every Verse across every Tag, centered on today.
- **Filtered timeline** = the general timeline narrowed to Verses carrying a chosen combination of 1–N Tags.
- Every Tag has its own **dashboard** — an insights view scoped to just that Tag's Verses (e.g. `.barcelona-trip`'s dashboard totals spend, lists cities/venues, shows average ratings).

### 2.5 Verse lifecycle: `.option` and `.decision` as ordinary tags
No special lifecycle field, no separate Verse type. **`.option` and `.decision` are just Tags, like any other Tag.**

1. **An options-stage Verse** — created today, tagged `.barcelona-trip` + `.flight` + `.option`, holding screenshots of several candidate flights. No firm `event_start` yet.
2. **A decision-stage Verse** — created later, once you've booked, tagged `.barcelona-trip` + `.flight` + `.decision`, holding the real reservation, confirmation code, and `event_start`/`event_end`. This is what establishes the location-inheritance window from §2.3.

There is no formal link between the two (per §6.2) — **the connection between an option and its eventual decision is entirely implicit, made by the tags they share** (`.barcelona-trip` + `.flight`), the same mechanism that connects any other family of related Verses. `.option`/`.decision` just add a filterable status dimension on top of that — e.g. you can filter to "everything still in `.option` state" across all trips to see open decisions, or filter a single trip down to only its `.decision` Verses to see what's actually booked.

---

## 3. V1 Verticals

Five Tag-driven "kinds" of Verse ship in v1:

| Vertical | Typical properties | Typical event range |
|---|---|---|
| **Flight** | airline, flight number, seat, confirmation code, baggage, price | departure datetime → arrival datetime |
| **Hotel** | property name, room type, confirmation code, price/night, address | check-in datetime → check-out datetime |
| **Restaurant** | venue name, dish(es), price, split-with (people) | single datetime (or a short range) |
| **Concert** | artist/event, venue, seat/section, price | single datetime (or a short range) |
| **Movie** | title, venue/platform (cinema vs. streaming), format (e.g. 3D/IMAX) | single datetime |

### 3.1 Vertical tags trigger a suggested form
Adding one of these five Tags to a new Verse (e.g. `.flight`) **pre-fills the property form** with that vertical's typical fields (§3 table) as a convenience — but every field is optional and editable, and you're never blocked from saving a Verse with only some of them filled in, or none at all (see the minimal-Verse note in §2.1). The vertical Tag drives *what the form suggests*, not *what the Verse requires*. Nothing about this is a hard schema — you can still add your own ad-hoc properties on top of, or instead of, the suggested ones.

Each Verse still uses the same generic shape (§2.1) regardless of vertical.

---

## 4. UI/UX for V1

- **Home screen**: timeline centered on today, scrollable past/future, Verses as date-ordered cards with a thumbnail.
- **Quick-add**: a chat-style input box that creates a Verse from natural language or the CLI-style shorthand (`d:`, `xp:`, tags, etc. — carried over from the original notes). Also supports a **media-first path** — attach photos/a voice note/a text note directly with just a location and a Tag, no form required.
- **Tag bar / tree view**: selected Tags are visualized as a **tree**, showing how each additional Tag narrows the intersection (AND) as you add it; a toggle switches the same selection to union (OR) mode instead of intersection — see §6.1.
- **Tag dashboard**: opened from a Tag, shows aggregate stats for that Tag's Verses.
- **Verse detail/edit view**: shows all fields from §2.1, lets you add properties freely, attach media, and set/override location.

---

## 5. What Changed From the v1 Draft

- "Templates" are gone as a rigid concept — replaced by **dynamic properties + Tags**, which is a simpler and more flexible mechanic and matches what you described.
- The huge v1 use-case list (medication, pets, family calendars, tattoo portfolio, confidential mode, multi-cloud infra) is **deferred in full** — none of it is in scope for this build. It stays in the original document as a backlog/vision reference.
- The flagship scenario is unchanged in spirit (trip planning) but now scoped tightly to **flights, hotels, restaurants, concerts** rather than the full trip-expense-splitting/car-rental/Airbnb version described earlier — those are natural v1.1 additions once the core mechanic (Verse + Tag + inheritance) is proven.

---

## 6. Decisions Locked

1. **Tag filtering logic**: the filter bar supports **both** modes — a toggle between AND (intersection) and OR (union) when 1–N Tags are selected. Default proposed: AND, since that's the more common "narrow down" intent; OR is an explicit switch. Visualized as a **tree view**: each selected Tag branches narrower into the intersection, with the toggle collapsing that back into a flat union view.
2. **Options → Decision linking**: **no formal link.** `.option` and `.decision` are ordinary Tags (§2.5) — a Verse in its decision stage simply carries `.decision` alongside the same descriptive Tags (`.barcelona-trip`, `.flight`) that its options-stage sibling carried. Nothing in the schema needs a `resulted_from` reference; the shared descriptive Tags *are* the link.
3. **Platform for v1**: **responsive web app only.** No native mobile app in this phase.

## 7. Still Open

- **Location inheritance edge cases**: if two location-establishing Verses overlap in time (e.g., a day-trip to Sitges logged during the Barcelona stay), does the more specific/recent one win, or do we need explicit precedence rules? Worth deciding once we design the location-resolution logic, not blocking for the initial schema.

---

## 8. Database Schema (v1)

Full DDL lives in `agnte-schema-v1.sql`. Summary of the key design choices:

- **PostgreSQL**, chosen because the Verse model needs real relational joins (Tags, ranges) *and* a schema-free bag of properties per Verse — Postgres' `jsonb` column with a GIN index covers the dynamic-properties need without giving up SQL joins or range queries.
- **`verses`** — one row per Verse, with `properties` as `jsonb` (no fixed schema), `event_start`/`event_end` nullable and unconstrained toward past or future, and `location_id` set only when *this* Verse explicitly establishes/overrides a location.
- **`tags`** — stored without the leading dot (rendered with one in the UI); `is_vertical` + `default_properties` flags the five v1 verticals so the create-Verse form knows which fields to suggest — this is UI metadata only, never enforced by the database.
- **`verse_tags`** — the many-to-many join table. This *is* the entire linking mechanism between an `.option` Verse and its `.decision` sibling (§2.5/§6.2) — no foreign key between Verses is needed anywhere.
- **`media`** — one row per attachment (image/voice note/document/video), so a Verse can be nothing but a handful of these rows plus a location and a tag.
- **Location inheritance is computed, not stored.** A `resolve_verse_location()` function looks up the narrowest overlapping date-range Verse with a location, rather than caching a resolved value on every row — so it never goes stale if an earlier Verse's dates or location get edited later. The narrowest-range/most-recent tie-break rule is a first guess, flagged for revisiting once there's real trip data to test it against.
- **AND vs. OR tag filtering** (§6.1) are two different, straightforward queries against `verse_tags` — both included as examples in the schema file.

---

## 9. Tech Stack (v1 — locked)

| Layer | Choice |
|---|---|
| Database | PostgreSQL (per §8 schema) |
| Backend/API | Node.js + TypeScript, custom API (Fastify/Express) with Prisma or Drizzle as the ORM against the `jsonb`-based schema |
| Frontend | Next.js (React + TypeScript), responsive web only per §6.3 |
| Media storage | S3-compatible object storage (AWS S3 or Cloudflare R2) — `media.storage_url` just needs a stable URL |
| Auth | A library (e.g. Auth.js/NextAuth) rather than hand-rolled — `users` table is already in the schema even though v1 is effectively single-user |
| Hosting | Vercel (frontend + custom API) + a managed Postgres provider (Supabase, Neon, or Railway) for the database only |

---

## 10. Screen Specs (v1)

Four screens cover the whole v1 loop. Each lists layout, key states, and the API calls it needs against the schema in §8.

### 10.1 Home / Timeline
- **Layout**: single scrollable column, **centered on today** — today's date is the initial scroll position, with Verse cards extending upward into the future and downward into the past (or the reverse; pick one convention and keep it consistent — flag as a UI decision, not a data one). Date dividers separate days/weeks as you scroll.
- **Verse card**: thumbnail (first `media` row if any), a one-line summary (vertical name + key property, e.g. "Flight — BCN→MAD", or the first words of `xp` if there's no vertical), event date/time (or "logged today" if no `event_start`), tag pills, rating badge if set.
- **Top bar**: a quick-add entry point (opens §10.2) and a filter icon (opens §10.3).
- **Empty state**: first-run message inviting a first Verse.
- **API**: `GET /verses?anchor=<date>&limit=N` paginated in both directions from the anchor; `GET /verses?tags=...&mode=and|or` when a filter is active (§6.1 queries).

### 10.2 Quick-add
- **Entry point**: a chat-style input, opened as a modal/bottom sheet from the home screen.
- **Minimal path**: type free text (supports the CLI shorthand — `d:`, `xp:`, `.tagname`) and/or attach media (photo, voice note, document) directly, pick 1+ tags, optionally set a location. Save. This alone satisfies the "minimal Verse" case from §2.1 — no other fields required.
- **Vertical-assist path**: as soon as a tag flagged `is_vertical` (flight/hotel/restaurant/concert/movie) is added, the sheet expands with a **suggested-fields section** pulled from that tag's `default_properties` (§3.1) — e.g. airline/seat/confirmation code for `.flight`. Every suggested field stays optional; the user can ignore, fill some, or add their own ad-hoc properties instead.
- **Date fields**: `event_start`/`event_end` default to "now," but are freely editable to any past or future date/time — this is how a planned trip (future) or a retroactively logged one (past) both get created the same way.
- **Location field**: free-text/autocomplete. If left blank, the UI can show a subtle "will inherit from [X]" hint once the backend resolves it (calls `resolve_verse_location` after save, or optimistically previews it client-side against the currently visible date range).
- **Tag picker**: autocomplete against existing tags, or create a new one inline (typing `.newtag` and confirming creates a `tags` row).
- **API**: `POST /verses` (with nested `tags[]` and `media[]` in the same call, or a two-step create-then-attach — implementation detail for the API layer); `GET /tags?search=` for autocomplete.

### 10.3 Tag filter (tree view)
- **Layout**: a searchable list of all tags (with vertical tags visually distinguished, e.g. an icon), each showing its Verse count.
- **Selection**: tapping a tag adds it to the active filter and renders it as a **tree**, each additional tag branching narrower to represent the AND/intersection result. A toggle switches the same selection to flat OR/union mode (§6.1).
- **Apply**: returns to the Home timeline (§10.1) filtered accordingly; the active filter persists as a visible chip row until cleared.
- **Tag row action**: tapping a tag's name (rather than its checkbox) opens its **Dashboard** (§10.4) instead of just filtering.
- **API**: `GET /tags` (with counts), then the same `GET /verses?tags=...&mode=...` as §10.1 once applied.

### 10.4 Tag dashboard
- **Layout**: opened from a single tag (or a tag combination). Shows aggregate stats scoped to that tag's Verses: total count, date range covered, average rating, a simple map/list of distinct locations, and a mini version of the timeline (same card style as §10.1, scoped).
- **Numeric roll-ups**: if Verses under this tag commonly carry a `price` property (common on flight/hotel/restaurant/concert verticals), sum it as a basic "total spend" figure — a light version of the insights concept from the original doc, without needing a fixed schema to do it (just scan the `properties` jsonb for a `price` key).
- **API**: `GET /tags/:id/dashboard` — a dedicated aggregate endpoint rather than doing this client-side, since it's a straightforward `GROUP BY`/`SUM` over `verses.properties->>'price'` joined through `verse_tags`.

### 10.5 Verse detail / edit
- **Layout**: full media gallery at top (swipeable if multiple), then editable fields: `xp`, `rating`, `properties` (as an editable key/value list — add/remove rows freely), `tags` (add/remove), `location` (shows whether it's explicit or inherited, e.g. "Barcelona (inherited from Hotel Verse)" vs. a plain "Barcelona" if set directly — with an option to override), `event_start`/`event_end`. `created_at`/`updated_at` shown read-only.
- **Actions**: edit, delete, duplicate (useful for logging a recurring thing like another restaurant visit with similar tags).
- **API**: `GET /verses/:id` (resolves location server-side via `resolve_verse_location`), `PATCH /verses/:id`, `DELETE /verses/:id`.

---

## 11. Build-Order Plan (v1)

Smallest working slice first, each phase demoable end-to-end before the next one starts.

**Phase 0 — Scaffold**
Repo, Next.js + Node/TypeScript API, provision managed Postgres, run `agnte-schema-v1.sql`, wire up auth (single real user account, library-based per §9). *Done when*: an empty app deploys and a logged-in session works.

**Phase 1 — Core loop: create → see on timeline**
`POST /verses` (xp + dates only, no tags/media/properties yet), `GET /verses` paginated around an anchor date, the bare-bones Home timeline (§10.1) rendering cards. *Done when*: you can type a note dated in the past or future and see it appear in the right place on the timeline.

**Phase 2 — Tags**
`tags` + `verse_tags` tables wired up, tag creation/autocomplete in quick-add, tag pills on cards, a single-tag filter (no tree/AND-OR yet). *Done when*: you can tag a Verse and filter the timeline down to one tag.

**Phase 3 — Media & the minimal Verse**
`media` table, storage integration (S3/R2), photo/voice-note/document attach in quick-add. *Done when*: you can create a Verse that's just photos + a tag + a location, per §2.1's minimal-Verse rule.

**Phase 4 — Multi-tag filter tree**
Full §10.3 tree UI, both AND (intersection) and OR (union) query modes wired to the two example queries in the schema file. *Done when*: selecting `.barcelona-trip` + `.restaurant` narrows correctly in both modes.

**Phase 5 — Locations & inheritance**
`locations` table, location field on the Verse form, `resolve_verse_location()` wired into the API and shown on the detail view as explicit vs. "inherited from X." *Done when*: logging a restaurant Verse during a Barcelona hotel-stay Verse's date range shows Barcelona automatically.

**Phase 6 — Vertical tags & suggested forms**
Seed the five v1 vertical tags (flight/hotel/restaurant/concert/movie) with their `default_properties`; quick-add expands the suggested-fields section (§3.1); Verse detail view gets the editable properties key/value list. *Done when*: tagging a new Verse `.flight` pre-fills the flight-shaped form, still fully optional/editable.

**Phase 7 — Tag dashboard**
`GET /tags/:id/dashboard` aggregate endpoint (count, date range, avg rating, distinct locations, `price` roll-up), dashboard screen (§10.4). *Done when*: opening `.barcelona-trip` shows a real summary, not just a filtered list.

**Phase 8 — Polish**
CLI shorthand parsing in quick-add (`d:`, `xp:`, inline tags), duplicate action on Verse detail, responsive pass across breakpoints, empty/error states. *Done when*: the whole v1 loop feels usable day-to-day, not just functionally complete.

Each phase after 0 is independently shippable/testable — you could genuinely start using Agnte for real logging as early as Phase 3.

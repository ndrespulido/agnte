# Agnte — project context for Claude Code

Drop this at the repo root as `CLAUDE.md`. Claude Code reads it automatically
at the start of every session, so the context below carries across
conversations without re-explaining.

---

## What this is

**Agnte** — a personal life-timeline app. The pitch:

> *"A timeline for your life — write to it like a journal, query it like a
> database."*

The user logs fragments of lived experience as **Verses**, placed on a timeline
centred on today and scrollable into both past and future. Verses carry media,
free-form properties, tags, ratings, and a free-text note called **xp**.

Origin: the habit of messaging important things to yourself on WhatsApp
(tickets, links, films to watch) and then losing the history — plus a school
stairwell mural of world history, divided by continent, with prehistory
compressed relative to recent time.

---

## Status

**v1 exists and works** (Next.js monolith, Prisma, Postgres, Google sign-in,
deployed nowhere yet). It is being **rebuilt as v2** with a different
architecture. Read `agnte-v2-architecture.md` in this repo for the full
decision record — it contains the reasoning behind everything below and a list
of open decisions.

v1 is a reference implementation, not a starting point to preserve. Reuse ideas
and domain logic; don't feel bound to its structure.

---

## Core domain concepts

**Verse** — the atomic unit. Fields: `createdAt`, `updatedAt`, optional
`eventStart`/`eventEnd` (a moment or a range, freely in the past or future),
`deepTimeYears` (for prehistoric/historical entries outside calendar range —
see below), optional `location`, `rating` 0–10, `xp` free text, dynamic
`properties` (schema-free key/value), media attachments, and one or more tags.

A Verse can be **minimal**: media + a tag + a location, with nothing else. This
is a deliberate design rule, not an edge case.

**Tag** — the single grouping primitive, written with a leading dot:
`.barcelona-trip`, `.restaurant`, `.expenses`. A Verse belongs to many tags
simultaneously — think "tables this row is stored in," not "folder it sits in."
Each tag is also a filterable sub-timeline with its own dashboard.

**There is no separate Timeline entity.** A timeline is a filtered view over
tags. This was explicitly considered and rejected — see the architecture doc.

**Verticals** — five tags with suggested (never required) property sets:
`.flight`, `.hotel`, `.restaurant`, `.concert`, `.movie`. Tagging a Verse with
one pre-fills a form; every field stays optional.

**`.option` / `.decision`** — ordinary tags, not a special lifecycle. An
options-stage Verse (screenshots of candidate flights) and the eventual booking
are two independent Verses connected only by the descriptive tags they share.

**Deep time** — for events outside calendar range. Both JS `Date` and Postgres
`timestamptz` cap out around ±270,000 years, which doesn't reach "66 million
years ago." So `deepTimeYears` is a plain float (negative = years before
present) used *instead of* `eventStart`/`eventEnd`, mutually exclusive with
them. There is a shared, global catalogue of historical/prehistoric events (Big
Bang → moon landing) that every user sees for context once their own past
scroll runs out, merged with any personal deep-time Verses.

**Visibility** — `private | shared | public` on **both** Verse and Tag.
Resolution: an explicit Verse-level setting wins; otherwise the Verse inherits
the **most restrictive** visibility among its tags; default `private`.
**Fail closed — never resolve to the most permissive.** This app holds medical
notes and financial screenshots; a single mis-tag must not leak. Implement this
in exactly one place in the domain layer, and test it thoroughly.

**Shortcuts** — `Tag.shortcut`, unique per user. `.m` expands to `.movies`.
Verticals default to their first letter; collisions leave the second tag
without a default rather than reassigning.

---

## Architecture

**Locked:** Node/TypeScript · GCP · **modular monolith** (not microservices).

Full reasoning in `agnte-v2-architecture.md`. Summary:

- **One deployable**, internally split into modules with hard boundaries:
  `identity`, `verse`, `media`, `insights`, `notifications`, `privacy`.
- Each module: `domain/` (no framework or ORM imports) · `application/` ·
  `infrastructure/` · `api/` · `index.ts` (the only importable surface).
- **Boundaries are enforced, not just agreed**: ESLint `no-restricted-imports`
  blocks deep imports between modules, and each module gets its own Postgres
  schema with a DB role granted only on that schema. No cross-schema joins or
  foreign keys. This is what makes a later split into services mechanical.
- **In-process event bus** with the same interface a real broker would have
  (publish/subscribe, idempotency keys, retry, dead-letter). Handlers are
  idempotent from day one so swapping to Pub/Sub is an adapter change.
- **Deferred work** goes through Cloud Tasks (async jobs) and Cloud Scheduler
  (cron), both calling back into `/internal/*` routes — Cloud Run kills
  containers after the response, so nothing may be fire-and-forget.
- **Auth**: JWT access (~15 min) + revocable refresh tokens. Not cookie
  sessions — a native app is a planned client. Argon2id for passwords.
- **IDs are client-generated UUIDv7** (offline-created rows get their final ID
  immediately; also time-sortable for cursor pagination).
- **Every mutable row has `version` + `updatedAt`** for optimistic concurrency;
  stale writes get `409` with server state.

### Platform
Cloud Run · Neon Postgres (branch per PR) · Cloudflare R2 (no egress fees) ·
Cloudflare CDN/WAF · Cloud Tasks · Cloud Scheduler · Resend (email) ·
GitHub Actions.

### Cost discipline — non-negotiable
No cloud has a true hard spending cap; budgets are only notifications. So:
`--max-instances=3` on Cloud Run, **never create a NAT Gateway or load
balancer**, an Artifact Registry cleanup policy, Cloudflare in front, and a
Budget → Pub/Sub → Cloud Function kill switch that disables project billing.
Target: €0 idle, under €5/month in use.

### Patterns to hold to
Clean code is an explicit goal of this project — favour the instructive choice
and explain the pattern when introducing it.

- Hexagonal: domain imports no framework, no ORM.
- One aggregate per transaction.
- Idempotency keys on every write endpoint (24h retention).
- Correlation IDs through requests, logs and events.
- No shared domain-model library between modules — shared *infrastructure* is
  fine, shared *domain types* re-couple them.

## UI direction

Sober, minimalist, iOS-glass, with the feel of a 1990s paper agenda.

- **Sticky date header**: translucent bar pinned to the top showing the date of
  wherever you're scrolled to, updating live as you scroll — a paper planner's
  tab. Use `IntersectionObserver` against date sections.
- **Glass**: `backdrop-filter: blur(20px)` over a translucent base. Watch
  contrast — glass fails WCAG easily; text must stay 4.5:1 against whatever
  scrolls beneath.
- **Palette**: paper-warm neutrals, not pure white. Bone base (`#FAF9F6`), ink
  not black (`#1C1C1E`), one restrained accent. Hairline (0.5px) rules rather
  than boxes.
- **Type**: humanist sans for body; the date display carries the character —
  condensed grotesque or typewriter, set larger than feels comfortable.
  Tabular figures so dates don't shift while scrolling.
- **Add button**: bottom-right, thumb-reachable, "metallic paper" — soft
  vertical silver-to-pewter gradient, 1px lighter top edge and darker bottom
  edge, very soft shadow. No gloss, no bevel.
- **Motion**: 150–200ms, ease-out, honour `prefers-reduced-motion`.
- **Dark mode from the start.**
- **Design tokens as data** in a shared file, so a future React Native client
  can consume the same values.

---

## Constraints that shape everything

- **The user develops via pipeline and tests from a phone browser.** Every PR
  must produce a deployable preview environment with its own URL. Automated
  tests are load-bearing, not optional — they're the only safety net.
- **Cost must stay near zero.** Scale-to-zero services, `max-instances` caps on
  everything, no NAT gateway, no always-on load balancer. Cloudflare R2 for
  object storage specifically because it has no egress fees.
- **Mobile-first, and a native app is planned.** Business logic stays
  server-side; the web frontend is a client, not the application. Version the
  API (`/v1/...`) from the start. Design tokens live in a shared data file so a
  React Native client can consume the same values.
- **EU/GDPR applies.** Right to erasure and data portability are designed in,
  not bolted on. Erasure is an event each module reacts to by purging its own
  data — one of the concrete payoffs of the module boundaries.

---

## Working agreements

- **Verify before claiming.** Run typecheck, lint, and tests; don't report
  something works because it looks right. The user cannot easily check locally,
  so an unverified claim costs them a full deploy cycle to discover.
- **Flag gaps out loud.** If something is stubbed, partially implemented, or
  deliberately simplified, say so plainly rather than letting it read as
  finished. Past sessions caught real bugs this way (a regex anchored wrongly,
  TypeScript annotations in a `.mjs` file, a `.gitignore` that would have
  excluded Prisma migrations from the repo).
- **Push back on scope.** The v1 build repeatedly expanded mid-phase. If a
  request implies more than it appears to, say so before building.
- **Small, reviewable commits** with messages explaining *why*, not just what.

---

## Open decisions

Language, cloud and architecture are now settled. Still open:

1. **Erasure of contributed Verses** — if the user contributed Verses to
   someone else's shared tag, does erasure anonymize them (proposed, so one
   person can't destroy another's trip record) or delete them?
2. **`contribute` sharing permission** — can a collaborator add Verses to a
   shared tag in v2, or is sharing read-only first?
3. **Shortcut scope** — global per user (recommended) or per-tag context?
4. **Local dev alongside the pipeline** — the user has a Surface Pro 11
   (Snapdragon/ARM64) with WSL2 + Postgres working. Pipeline-only iteration is
   ~8 minutes per change versus seconds locally.

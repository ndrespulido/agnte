# Agnte v2 — Architecture

**Decisions locked:** Node/TypeScript · GCP · modular monolith (no microservices).

This supersedes the previous draft. Everything from the "what you left out"
list is now designed in rather than deferred — each has an §8.x section.

---

## 1. Shape of the system

A **modular monolith**: one deployable, internally partitioned into modules with
hard boundaries. Each module owns its tables, exposes a narrow public API, and
never reaches into another module's internals.

```
src/
  modules/
    identity/          users, credentials, tokens, email verification, reset
    verse/             verses, tags, visibility, sharing, shortcuts, search
    media/             media metadata, presigned URLs, image variants
    insights/          dashboards, aggregations, deep-time catalogue
    notifications/     scheduled reminders, web push, email dispatch
    privacy/           export + erasure (coordinator — see §8.7)
  shared/
    kernel/            Result, DomainError, ids, Clock (no dependencies)
    infra/             db client, logger, event bus, correlation IDs
  app/                 Next.js routes — thin; call module APIs only
```

Inside each module:

```
modules/verse/
  domain/          entities, value objects, policies — NO framework, NO ORM imports
  application/     use cases; orchestrates domain + ports
  infrastructure/  Prisma repositories, adapters implementing ports
  api/             HTTP handlers
  events.ts        events this module publishes
  index.ts         ← the ONLY thing other modules may import
```

### 1.1 Enforcing the boundaries mechanically

Convention alone always erodes. Two enforcement layers, both checkable in CI:

**ESLint `no-restricted-imports`** — a module may import from
`modules/*/index.ts` and from `shared/*`, and nothing else. A deep import like
`modules/verse/infrastructure/prisma-repo` fails the build.

**One Postgres schema per module**, with a distinct DB role per module granted
only on its own schema. No cross-schema foreign keys, no cross-schema joins.
Cross-module reads go through the owning module's public API.

This is what makes "split into services later" a mechanical exercise rather
than a rewrite — the seams are real even though the deployment is single.

### 1.2 Events

An **in-process event bus** whose interface matches what a real broker would
give you: publish/subscribe, handler-level idempotency keys, retry with
backoff, dead-letter table. Modules communicate across boundaries by publishing
events, not by calling each other's write paths.

```
verse.created / verse.updated / verse.deleted
media.uploaded          → thumbnail generation
user.erasure_requested  → each module purges its own data
```

Swapping this for Pub/Sub later is an adapter change behind the same interface.
Handlers must be idempotent from day one — that discipline is what makes the
swap safe, and it costs nothing to adopt now.

### 1.3 Background work on a scale-to-zero platform

Cloud Run can kill a container as soon as it returns a response, so
fire-and-forget work started during a request will silently die. Anything
deferred goes through:

- **Cloud Tasks** for one-off async work (thumbnails, export builds, erasure
  purges). Tasks call back into an authenticated `/internal/*` endpoint, which
  keeps everything inside the one deployable. 1M free operations/month.
- **Cloud Scheduler** for cron (reminder dispatch, nightly backup). Free tier
  covers 3 jobs.

Both are HTTP-based, so the "worker" is just another route in the same app — no
second service to deploy or pay for.

---

## 2. Data model additions

Beyond the v1 domain (Verse, Tag, verticals, deep time — see `CLAUDE.md`):

**IDs are UUIDv7, generated client-side.** Two reasons, both load-bearing: a
Verse created offline gets its final ID immediately (no temporary-ID remapping
on sync), and UUIDv7 sorts by creation time, which makes cursor pagination on
the timeline cheap.

**Every mutable row carries `version` (int) and `updatedAt`.** Writes send the
version they read; a mismatch returns `409 Conflict` with current server state
so the client can merge. This is the concurrency primitive that makes offline
sync tractable.

**Visibility** — `private | shared | public` on both Verse and Tag, plus
`TagShare` / `VerseShare` join tables. Resolution: an explicit Verse setting
wins; otherwise the **most restrictive** among its tags; default `private`.

> This rule lives in exactly one function in `modules/verse/domain/`, and every
> read path — timeline, tag filter, search, dashboard, export — goes through it.
> No query builds its own visibility predicate. This app stores medical notes
> and bank screenshots; the failure mode of getting it wrong is disclosure, so
> it fails closed and it gets tested directly.

---

## 3. Platform

| Concern | Choice | Notes |
|---|---|---|
| Compute | **Cloud Run** | Scales to zero; per-100ms billing; 2M requests/month free |
| Database | **Neon** Postgres | Free tier fits; **branching per PR** — see §7 |
| Object storage | **Cloudflare R2** | S3-compatible; **no egress fees** |
| CDN / WAF | **Cloudflare** | Free tier; absorbs abuse before billable compute |
| Async jobs | **Cloud Tasks** | 1M ops/month free |
| Cron | **Cloud Scheduler** | 3 jobs free |
| Email | **Resend** | No sandbox-approval wait, unlike SES |
| CI/CD | **GitHub Actions** | Preview env per PR |

Neon's database branching is the specific reason it beats Cloud SQL here: each
PR gets a real database copy, which is what makes preview environments genuinely
useful for someone testing from a phone.

### 3.1 Cost controls — concrete

**No cloud offers a true hard spending cap.** Budgets are notifications. Real
protection is architectural:

1. **`--max-instances=3`** on Cloud Run. A capped service cannot produce a
   runaway bill regardless of traffic. Also set `--concurrency=80` and
   `--timeout=60s`.
2. **No NAT Gateway, no load balancer.** Cloud Run gives you an HTTPS endpoint
   free. A NAT Gateway is ~$32/month doing nothing and is the classic surprise
   charge — Cloud Run doesn't need one.
3. **Budget → Pub/Sub → Cloud Function that disables project billing.** As close
   to a hard stop as exists on any cloud, and a real GCP advantage. It's
   destructive (everything stops) — correct for a last resort. Set it at a
   number you'd genuinely be unhappy to pay.
4. **Budget alerts** at €5 / €20 / €50 by email, well below the kill switch.
5. **Artifact Registry cleanup policy** — container images accumulate silently
   and are one of the few things that cost money while idle. Keep the last 10.
6. **Cloudflare in front** of everything.

Realistic idle cost: **€0/month.** With you as sole active user: **under
€5/month.**

---

## 4. Auth

JWT access tokens (~15 min) + revocable refresh tokens in the database. Not
cookie sessions — a native app is a planned client, and cookies don't translate.

- Register → email verification token (single-use, 24h) → activate
- Login → token pair
- Forgot password → reset token (single-use, 1h, invalidated on use *and* on
  password change)
- Google OAuth → same token pair, so there's one auth model downstream
- Logout → refresh token revoked

**Argon2id** for password hashing. Rate limits on all auth endpoints (§8.6).
Verification and reset tokens are stored **hashed** — a database leak shouldn't
hand over working account-takeover links.

---

## 5. UI

Sober minimalist, iOS glass, 1990s paper agenda. Full direction in `CLAUDE.md`.
The architecturally relevant parts:

- **Design tokens as data** (`tokens.ts`) — colours, spacing, type scale — so a
  future React Native client consumes the same values.
- **Sticky date header** driven by `IntersectionObserver` over date sections,
  pairing with the existing infinite scroll.
- **Glass needs a contrast check.** `backdrop-filter` over scrolling content
  fails WCAG easily; the translucent base must keep text at 4.5:1.
- **PWA** (manifest + service worker) — this is also the offline mechanism
  (§8.1) and the Web Push transport (§8.4), so it earns its place three times
  over.

---

## 6. API

Versioned `/v1/` from the start, since you can't force a native app to update.
The web frontend is a client, not the application — all business logic stays
server-side.

Every write endpoint accepts an **`Idempotency-Key` header** and stores
processed keys for 24h. Non-negotiable for mobile, where the network retries
under you.

Every request carries a **correlation ID** (generated at the edge if absent),
propagated into logs and events. This is how you debug something you can't
reproduce locally — which, given your setup, is everything.

---

## 7. Pipeline — built for testing from a phone

```
PR opened
  → typecheck + lint + unit tests            (~2 min, fails fast)
  → integration tests against a Neon branch
  → build container
  → deploy Cloud Run revision with a unique preview URL
  → seed demo data into the branch
  → Playwright smoke test against the preview URL
  → bot comments the URL on the PR
        ↳ you open it on your phone
PR merged
  → deploy to production, smoke test, auto-rollback on failure
PR closed
  → delete preview revision + Neon branch
```

Preview-per-PR with a seeded database is what makes phone-only testing workable.
Automated tests aren't optional here — they're the safety net that replaces your
ability to check things locally.

### 7.1 Local development

**Decided: local dev stays alive alongside the pipeline.** Fast iteration
locally; the pipeline is what proves it actually works. The existing setup —
WSL2 on the Surface (Snapdragon/ARM64) with native Postgres — is the target
environment.

The constraint that shapes this: **`npm run dev` must work with no GCP account,
no Cloudflare account, and no Docker.** Docker Desktop wasn't installable on
that machine, so anything requiring a container locally is out.

This is where ports & adapters stops being theoretical. Each external
dependency gets two adapters, selected by environment:

| Port | Production | Local |
|---|---|---|
| Object storage | Cloudflare R2 (presigned PUT) | Filesystem under `.local-storage/`, served by a dev-only route |
| Deferred jobs | Cloud Tasks → `/internal/*` | In-process queue calling the same handler directly |
| Cron | Cloud Scheduler | `setInterval` in dev, or a manual trigger route |
| Email | Resend | Console transport — prints the verification/reset link to the terminal |
| Database | Neon | Local Postgres |

Rules that keep this honest:

- **The adapter is the only thing that differs.** Handlers, use cases and domain
  logic are identical in both environments — if a code path only exists in one,
  the pipeline is testing something you never ran.
- **The console email transport prints the real token URL**, so registration and
  password reset are fully testable offline. This matters: email is otherwise
  the most annoying flow to test.
- **Seed script** (`npm run seed`) populates a realistic dataset — verses across
  past and future, shared and private tags, deep-time entries — so local state
  resembles the preview environments.
- **CI runs against the production adapters** (a Neon branch, a scratch R2
  bucket) so adapter-specific bugs surface in the pipeline rather than in
  production.

---

## 8. The previously-missing pieces, designed in

### 8.1 Offline support

**Scope for v2: reliable offline *writes*, plus cached recent reads.** Full
local-first sync with CRDTs is out of scope; this covers the actual failure case
(composing a Verse in a basement with no signal).

- **Outbox in IndexedDB.** Every mutation is written locally first with its
  client-generated UUIDv7 and an idempotency key, then queued.
- **Replay on reconnect**, in order, with exponential backoff.
- **Server dedupes** on the idempotency key, so a retry after a lost response is
  harmless.
- **Conflicts** surface as `409` with server state; resolution is last-write-wins
  on scalar fields, union on tags, with the losing version retained 30 days so
  nothing is silently destroyed.
- **Read cache**: service worker caches the current timeline window and its
  thumbnails. Deep time and dashboards stay online-only.
- **Media offline**: files held in IndexedDB, uploaded when connectivity
  returns; the Verse is created immediately and media attaches on completion.

The UI must show pending state honestly — a Verse that hasn't synced should look
different from one that has. Silent queuing is how people lose trust in an app
that holds their memories.

### 8.2 Search

Postgres full-text, no external search service.

- Generated `tsvector` column on Verse: `xp` + text values from `properties` +
  denormalized tag names, weighted (xp highest).
- **GIN index**; `pg_trgm` additionally for fuzzy tag/shortcut matching.
- **Search runs through the same visibility resolver as every other read path**
  (§2). Search is the single most likely place for a disclosure bug, because
  it's tempting to write a fast bespoke query — don't.
- Filters compose with search: tags (AND/OR), date range, rating, has-media.
- Language config per user locale (`spanish`, `french`, `english`) — relevant
  given the app is multilingual.

### 8.3 Image handling

- **Downscale in the browser before upload** (canvas, max ~2560px). A 4MB phone
  photo becomes ~400KB — the single biggest win for mobile upload time and
  storage cost, and it happens before a byte hits the network.
- Upload direct to R2 via presigned PUT (never through the app server).
- On completion → `media.uploaded` event → Cloud Task → **sharp** generates
  `thumb` (256px) and `medium` (1024px) variants → `MediaVariant` rows.
- **Strip EXIF, including GPS**, on derivatives. Keep original EXIF only if the
  user opts in — location data in shared photos is a real privacy leak.
- Serve through Cloudflare in front of R2: cached, and no egress cost.
- Originals stay private; all access via short-lived signed URLs (as v1 does).

### 8.4 Reminders and notifications

This is what makes the original medication/prescription/task use cases possible.

```
ScheduledNotification { id, userId, verseId?, fireAt, kind, payload, status, attempts }
```

- Cloud Scheduler → `/internal/notifications/tick` every 5 minutes.
- Claims due rows with `SELECT ... FOR UPDATE SKIP LOCKED` — safe if two
  instances tick concurrently.
- **Web Push** primary (free; works on Android Chrome and iOS 16.4+ when
  installed as a PWA), **email fallback** via Resend.
- Recurrence stored as RRULE; next occurrence computed on dispatch rather than
  materializing a year of rows.
- Quiet hours per user — never dispatch a medication reminder at 03:00 because
  of a timezone bug.

### 8.5 Data export

- `POST /v1/privacy/export` → Cloud Task → worker assembles JSON (all verses,
  tags, properties, shares) + original media into a ZIP in R2 → emails a signed
  URL valid 24h.
- Async because media can run to gigabytes.
- Rate-limited to one export per user per 24h.
- Doubles as GDPR portability (§8.7) — one implementation, two requirements.

### 8.6 Rate limiting

Two layers:

- **Cloudflare rules** at the edge — free, and stops abuse before it reaches
  billable compute. This is also a cost control (§3.1).
- **Application-level**, DB-backed fixed-window (no Redis — it would cost more
  than everything else combined at this scale):

| Endpoint | Limit |
|---|---|
| `POST /v1/auth/login` | 5 / 15 min per IP+email, exponential backoff |
| `POST /v1/auth/register` | 3 / hour per IP |
| `POST /v1/auth/forgot-password` | 3 / hour per email |
| `POST /v1/media/upload-url` | 100 / hour per user |
| `POST /v1/privacy/export` | 1 / 24h per user |
| general authenticated | 1000 / hour per user |

Password reset returns the same response whether or not the account exists —
otherwise the endpoint is an account-enumeration oracle.

### 8.7 GDPR

You're EU-based, this is multi-user, and it stores health notes, financial
screenshots, and other people's data via shared trips. These are real
obligations, and erasure in particular is far cheaper to design in now.

**Right to erasure** — `DELETE /v1/me` → soft-delete → `user.erasure_requested`
event → each module purges its own data (exactly what module boundaries buy you)
→ media purged from R2 → hard delete after a 30-day grace window.

> **Decided:** if you contributed Verses to someone else's shared trip tag,
> erasure **anonymizes** them rather than deleting them — the Verse keeps its
> content and loses all attribution. Deleting would let one person destroy
> another's trip record. Implementation note: anonymization must also strip
> authorship from any media EXIF and from the event log, not just null the
> `userId` column.

**Portability** — the export in §8.5.

**Data minimization** — structured logging with a redaction allowlist. Request
bodies are never logged; `xp` text and property values never reach logs.

**Retention** — refresh tokens 30d after expiry; verification/reset tokens
purged on use; soft-deleted rows 30d; logs 30d; idempotency keys 24h.

**Processors** — Neon, Cloudflare, Resend and Google Cloud all process personal
data on your behalf; each needs a DPA on file. All four offer standard ones.

**Consent & basis** — a privacy policy, and an explicit consent record for
anything beyond core function. Not a formality once you have users who aren't
you.

**Encryption** — provider-level at rest, TLS in transit. **Decided:** no
application-level media encryption. It would break server-side thumbnailing, and
the added protection over R2's at-rest encryption is small relative to that
cost.

### 8.8 Backups

Neon's free tier gives a limited point-in-time window — **treat it as
insufficient on its own.**

- Nightly `pg_dump` via Cloud Scheduler → Cloud Run job → R2, 30-day retention.
- Monthly **restore rehearsal into a scratch Neon branch**, verified by row
  counts. An untested backup is a guess, and this is the one place in the system
  where being wrong is unrecoverable.
- Media in R2: enable versioning plus a lifecycle rule.

### 8.9 Migrating v1 data

One-off script: read the existing local Postgres → map to the v2 schema →
default all visibility to `private` (never infer permissively) → generate
UUIDv7s while keeping a mapping table → backfill search vectors → verify row
counts. Runs once against production after first deploy.

### 8.10 Testing

Load-bearing, given phone-only testing.

| Layer | What | Where |
|---|---|---|
| Domain unit | Visibility resolution, shortcut collisions, deep-time formatting, recurrence math | No I/O; milliseconds |
| Module integration | Repositories + use cases against real Postgres | Neon branch in CI |
| API contract | Request/response shapes per `/v1` endpoint | Guards the future mobile client |
| E2E smoke | Sign in, create a verse, tag it, filter, search | Playwright against the preview URL |

**Non-negotiable coverage**, because these are where a bug is expensive rather
than annoying: the visibility resolver, idempotency handling, and the offline
replay path.

---

## 9. Build order

Each phase ends deployable and checkable from your phone.

0. **Repo, CI, preview environments, Cloud Run + Neon + Cloudflare wired, cost
   controls and kill switch in place.** Prove the path before building on it.
1. **`shared/kernel` + `identity`** — register, verify, login, refresh, reset,
   Google. Rate limits from the start.
2. **`verse`** — verses, tags, visibility, sharing, shortcuts, search.
3. **UI shell** — glass, sticky date header, timeline, quick-add, PWA manifest.
4. **`media`** — presigned upload, browser downscale, thumbnails via Tasks.
5. **Offline write queue.**
6. **`insights`** — dashboards, deep-time catalogue.
7. **`notifications`** — scheduler, Web Push, recurrence.
8. **`privacy`** — export + erasure. Backups + restore rehearsal.
9. **v1 data migration.**

---

## 10. Still needing your input

Settled: language, cloud, architecture, erasure behaviour, media encryption,
local dev.

1. **`contribute` sharing permission** — can a collaborator add Verses to a
   shared tag in v2, or is sharing read-only first? (Read-only is less work and
   less to get wrong; `contribute` is what makes a shared trip genuinely
   collaborative.)
2. **Shortcut scope** — global per user (recommended), or per-tag context?

Neither blocks Phase 0.

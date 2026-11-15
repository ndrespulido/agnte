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

> **Decided in Phase 1: schemas now, roles later.** The six schemas exist and
> the ESLint boundary rule is enforced in CI, but every module shares one
> database role. Prisma has a single connection string, so a role per module
> means a connection pool per module — multiplying Neon connections against a
> free-tier cap, for a single deployable where the boundary is already enforced
> at build time. Schemas are the half that is expensive to retrofit and they
> are in place; roles become worth their cost when the monolith actually
> splits, and adding them then is a grant and a connection string per module,
> not a redesign. The cost accepted meanwhile: a compromised module could read
> another's tables at runtime.

> **Added in Phase 1: a `platform` schema.** Idempotency keys (§6), rate-limit
> windows (§8.6) and later the event bus dead-letter table are infrastructure,
> not domain, and belong to no module — `media` and `privacy` need rate
> limiting as much as `identity` does. Putting them in a module's schema would
> create exactly the cross-module dependency this section exists to prevent.
> They live in a seventh schema owned by `shared/infra`.

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

> **Deferred to Phase 2.** In Phase 1 nothing subscribes: `identity` would
> publish into a void. Building publish/subscribe, idempotency, retry and
> dead-lettering with no consumer means designing against imagined
> requirements, and the first real subscriber is what will show whether the
> interface is right. `verse` in Phase 2 provides one. The discipline above
> still holds from the moment the bus exists.

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

### 2.1 How the database works

The rules above are what the data *means*. This is the machinery under them —
written down because it was spread across `prisma/schema.prisma`,
`prisma.config.ts`, `shared/infra/database.ts` and a dozen migration comments,
and three of the decisions here have already been rediscovered the hard way.

**Seven schemas: six modules plus `platform`.** No cross-schema foreign keys
and no cross-schema joins (§1.1). A module reaches another's data through its
`index.ts`, never its tables — `notifications` asking identity for an address
and a language goes through `contactFor(userId)`, not a join. The consequence
worth naming: some invariants cannot be database constraints. "A verse has at
least one tag" is one, which is why `countVersesOnlyTaggedWith` exists and the
application asks before deleting a tag.

**One Prisma client, through a driver adapter.** Prisma 7 connects via
`PrismaPg` rather than a bundled native engine, which also removed the
arm64/amd64 engine-binary mismatch between a Snapdragon dev machine and an
amd64 container. The client is cached on `globalThis` because Next reloads
modules on every edit in development and would otherwise open a pool per edit
until Postgres refused connections.

**`getDatabase()` returns `undefined`, not a throw, when `DATABASE_URL` is
unset.** `npm run dev` has to work with no database at all (§7.1), and a
preview legitimately runs ahead of the database it will later use. Callers that
genuinely require one say so themselves — `requireDatabase()` in each
repository — so the failure names the module rather than surfacing from inside
the driver.

**Two connection URLs, and they are not interchangeable.** The application uses
the pooled URL; migrations use `DIRECT_URL`. The migration engine takes
advisory locks and runs multi-statement DDL in a session, both of which
PgBouncer's transaction pooling breaks. `prisma.config.ts` falls back with `||`
rather than `??` deliberately: an empty-string `DIRECT_URL` is unset in every
way that matters, and `??` would only catch `undefined`.

**Repositories write raw SQL, not the typed client.** Every query in
`modules/*/infrastructure/` is `$queryRaw` or `$executeRaw`. That is a choice,
not an omission: the queries here are keyset pagination, conditional updates
and visibility predicates, all of which read more clearly as SQL than as a
query-builder expression, and the domain ports already define the shape the
application wants back. The cost is that nothing type-checks the column list
against the table, which leads directly to the next rule.

> **Columns are always listed explicitly. Never `SELECT *`.** Paid for once:
> adding a `tsvector` column broke every read in the verse module at once,
> because the driver cannot deserialize a tsvector and `SELECT *` had been
> quietly promising to return whatever the table happened to hold. A column
> list is a contract between the query and its row interface, and adding a
> column should change nothing that does not name it.

**CHECK constraints are a backstop, not the validation.** There are 44 of them.
The real rules live in the domain constructors; the constraints exist so a
write path that forgets to call one fails loudly instead of persisting
something the domain would have refused. Several integration tests assert
exactly that — "the database refuses what the domain refuses" — by inserting
bad rows directly and expecting a rejection. Where a CHECK would have to
re-implement real logic it is deliberately loose: the email constraint enforces
normalisation and a crude shape, not RFC 5322.

**Optimistic concurrency is a conditional UPDATE.** Writes carry the version
they read, the UPDATE ends `AND version = $expected`, and zero rows affected
means the row moved — which the application turns into `409` with the server's
current state rather than a silent overwrite. One exception, argued where it
lives: `updateLocale` is unconditional, because two devices disagreeing about
an interface language is one person changing their mind, not a conflict.

**A date is not an instant, and the column says which.** `event_precision` is
`'date'` or `'minute'`, non-null exactly when `event_start` is. At `'date'` the
stored instant is exactly midnight UTC and only its UTC date parts carry
meaning; at `'minute'` it is a real moment, rendered in the reader's own zone.

> **Why this was worth a migration rather than a display fix.** Both kinds of
> fact were stored in one `timestamptz` and rendered with UTC parts, which made
> each of them wrong in a different way. A typed "14:00" was stored as 14:00Z
> regardless of where the typist was standing — so it is not the moment they
> meant, and the export says so. And a genuine instant, a reminder's fire time
> written through the already zone-aware reminder path, was displayed with UTC
> parts: a reminder set for 17:00 in Madrid read as **15:00 on the timeline**.
> Same row, two times, one app. That one is demonstrable and was the trigger.
>
> Fixing only the display would have been smaller and worse. Rendering
> everything local moves every existing entry by the reader's offset, and a
> date-only verse — `2026-03-01T00:00:00Z` — gains a time it never had and, west
> of Greenwich, lands on **28 February**. The data was ambiguous, so no
> rendering rule could be right for both kinds of row; the ambiguity had to go.
>
> **The backfill is the point of the migration**, not an afterthought: midnight
> UTC becomes `'date'`, anything else `'minute'`. That is not a guess — the old
> client wrote a `datetime-local` value straight through as UTC, so a date-only
> entry landed on exactly midnight and a timed one did not. Reading existing
> rows that way is what makes the change a no-op on screen for everything
> already written, which was the requirement.
>
> **How the client reads it.** A day is read with UTC parts, so it is the same
> date for every reader; a moment is read in the reader's zone. The form is a
> date field plus an optional time — the empty time *is* `'date'` — and both
> ends of a range share the start's precision. One deliberate disagreement
> with the server: the client sorts a day at **local** midnight, because the
> stored instant (midnight UTC) is the evening before for anyone west of
> Greenwich and would split that day's section. Pages are still fetched in the
> server's order; the "today" mark is placed by the same local reading.
>
> Two costs, both accepted. Times typed *before* this change were stored as
> UTC wall-clock, so they now display shifted by the reader's offset (14:00
> typed in Madrid in summer reads 16:00); nothing can tell those rows from
> correct ones. And the tag dashboard's first/last span still formats in UTC —
> its summary carries no precision yet.
>
> The same rule runs at the edges as an **inference, not a default**: a write
> queued offline by an older build, or an export written before the field
> existed, carries no precision and must still mean what it meant when it was
> written. An *unrecognised* precision is refused rather than falling back,
> because falling back to `'minute'` would render somebody's bare date in their
> own zone and move the day. A `'date'` carrying a time of day is refused too,
> rather than truncated: truncating hides the caller's bug while changing what
> the verse says.
>
> Three CHECKs police it — presence (`precision IS NULL` iff `event_start IS
> NULL`), the value set, and midnight-at-`'date'` — because the symptom of a
> raw write path getting it wrong is a verse that silently moves day when read
> from another zone.

**Conventions worth knowing before writing a migration:**

- Primary keys are client-generated UUIDv7 (§2), so `gen_random_uuid()` appears
  only in tests and fixtures.
- Timestamps are `timestamptz(3)`. Millisecond precision, always with a zone.
- `version Int @default(0)` and `updatedAt` on every mutable row.
- Indexes follow the read paths, not the columns: `(owner_id, timeline_years,
  id)` is the timeline's keyset index and the `id` tiebreak is what makes
  pagination stable when two verses share a position. Search deliberately has
  **no** index right now — see §8.2 for why, and what it would cost to add one.

**Migrations ship inside the image.** `prisma migrate deploy` runs in CI and in
the production deploy; `migrate dev` is for authoring locally and needs a
shadow database. The Dockerfile copies `prisma/migrations` into the runtime
image so `shippedMigrations()` can read them at runtime, which is what makes
the health check meaningful.

> **The health check compares shipped migrations against applied ones**, and
> that is the second version of it. The first asserted that the seven schemas
> existed — and every migration after `platform` adds *tables* to schemas that
> already exist, so a database migrated only as far as an older release still
> reported every schema present. Verified at the time: a database with all
> seven schemas and none of identity's tables passed. The deploy smoke test
> gates on this check, so anything it does not look at can ship green.

**Four environments, three kinds of Postgres.** Local is a native Postgres
(no Docker on the dev machine); CI runs a `postgres:16` service container;
previews get a Neon branch per PR; production is Neon. The database-backed
suites skip silently when `DATABASE_URL` is missing or wrong — which looks
exactly like a green run — so CI has an explicit step that **fails if any test
was skipped**. Backups are §8.8.

> **The local database can drift from the branch you are on**, and it has
> twice. Migrations are per-branch, so switching between a branch that drops a
> column and one that expects it leaves the database matching neither; the
> symptom is a wall of failures in tests that have nothing to do with the
> change. `prisma migrate status` against the branch is the first thing to
> check when a suite fails on code that passed an hour ago.

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

> **Confirmed in Phase 1: previews cannot offer Google sign-in.** Google rejects
> wildcard redirect URIs, and a preview URL is per pull request, so it cannot be
> registered in advance. Previews use email and password; the status page
> reports `google-sign-in: not-configured` with that reason. An account created
> through Google carries no password hash — a placeholder would be a credential
> nobody chose — so `User.passwordHash` is nullable, and password sign-in
> refuses such an account with the same error and the same timing as a wrong
> password.
- Logout → refresh token revoked

> **Added in Phase 1: refresh token rotation with reuse detection.** A thirty-day
> bearer credential is a long time to trust a string, so a refresh token is
> exchanged — not reused — and every sign-in starts a *family* that rotation
> extends. Rotation alone only limits a stolen token to the window before the
> real client next refreshes. What makes theft visible is that a token which has
> already been exchanged can only be presented again by someone replaying it;
> since there is no way to tell the thief from the victim, the family is revoked
> and both sign in again. Consume-and-replace runs in one transaction, so a
> half-done rotation can neither strand the client without a token nor leave two
> live tokens in one family — the second of which would make the next honest
> refresh look like an attack.

**Argon2id** for password hashing. Rate limits on all auth endpoints (§8.6).
Verification and reset tokens are stored **hashed** — a database leak shouldn't
hand over working account-takeover links.

> **Amended in Phase 1: no account exists until the address is proven.** The
> flow above says register → token → *activate*, which means a user row created
> at registration and switched on later. That row is shared mutable state keyed
> by an address nobody has proven yet, and it opens account pre-hijacking:
> someone registers your address before you do, you register too, and whichever
> single password ends up on that row can be theirs when you click the link in
> your own inbox. Every variant — last registration wins, first wins, revoke the
> old token — leaves a takeover path.
>
> So registration writes a `pending_registration` row instead: the token hash,
> the address, and the Argon2id hash of *that attempt's* password. The account
> is created when a link is redeemed, already verified, and redemption deletes
> the row (`DELETE ... RETURNING`, so exactly one of two concurrent clicks
> wins). Attempts are never revoked by later ones, which is what makes clicking
> *your own* email always give you *your own* password.
>
> Registration answers identically whether the address was free or taken, the
> way §8.6 already requires of password reset — and hashes the password on both
> paths, since skipping ~40ms of Argon2 on the "taken" branch would leak by
> timing what the identical bodies withhold. The address owner is told by email
> instead, which reaches the one person entitled to know.
>
> Consequence for §4's list: there is no "activate" step on a User, and no
> unverified users for login (1.4) to reason about.

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
  over. All three are now built.

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

> **Built in Phase 5: the outbox, the replay and the pending state.** The read
> cache, offline media and conflict retention are not built — see below.
>
> **Every write goes through the outbox, not only the ones made offline.** The
> obvious design is "try the network, fall back to a queue", and it has two code
> paths per mutation where the rare one is the one nobody exercises. Worse,
> "offline" is not a state a browser reliably knows: `navigator.onLine` is true
> on a train with a captive portal, and the request simply hangs. One path
> instead — store, answer, drain — makes being offline an ordinary slow send.
>
> **Ordering is the id.** Entries are UUIDv7 and replay in id order, and the
> drain stops at the first entry it cannot send rather than skipping past it: a
> verse's edit is queued behind its creation, so sending out of order would
> PATCH a row that does not exist. The cost is that one stuck entry holds up the
> ones behind it, which is why "blocked" is reserved for failures a person has
> to resolve.
>
> **A 4xx that is not 408, 409 or 429 is never retried.** The server is saying
> the request is wrong, and sending it again produces the same answer — in a
> strictly ordered queue that is an infinite loop that also holds up every good
> write behind it. Those, and a spent backoff, mark the entry blocked, which the
> row shows with the server's own words and the choice to retry or discard.
>
> **Tags now accept a client-minted id** (`POST /v1/tags`), as verse creation
> already did, because a verse queued behind a new tag has to name it before
> either has been sent. An id already taken answers 409 rather than the 500 a
> raw primary-key violation would produce — a queue replays a rejected write
> until something tells it to stop, and a 500 reads as "try again".
>
> **Not built, and each is a real gap rather than a detail:**
>
> - ~~**No service worker.**~~ Built next — see below.
> - **Media is still online-only.** A photo added with no signal fails its
>   upload and the verse saves without it, rather than the file being held in
>   IndexedDB and attached on reconnect.
> - **No 30-day retention of a losing version.** A conflict blocks the entry and
>   shows what the server said; resolving it is retry or discard, and nothing is
>   kept behind.
>
> **The service worker, built after the outbox.** `public/sw.js`, hand-written,
> no build plugin. The app now opens and shows a recent timeline with no signal
> at all; previously a cold start offline was the browser's own error page.
>
> - **Runtime caching, not a build-time precache manifest.** The usual setup
>   generates a list of every built asset and installs it on first run, which
>   needs a plugin, a manifest to keep in step with Turbopack's output, and a
>   download of the whole app before anyone asked for any of it. This caches
>   what was actually fetched, as it is fetched. The cost, stated rather than
>   hidden: a browser that has never loaded the app online cannot open it
>   offline, because there is nothing to serve.
> - **Four strategies.** `/_next/static/*` cache-first (content-hashed, so a hit
>   is always correct); the document network-first; `/v1/timeline` network-first;
>   everything else untouched. Writes are never intercepted — the outbox owns
>   those, and a worker replaying them too would be a second queue with its own
>   idea of the order.
> - **The timeline's cache key drops `anchor`.** The app anchors on `new Date()`
>   every time it opens, so keyed on the URL as sent every request would be a new
>   key: entries written and never read, a cache that fills up and answers
>   nothing. `direction` and `cursor` still separate the pages.
> - **Only `ok` responses are stored.** A cached 401 would be served for as long
>   as the entry lived, so an expired token would keep signing someone out with
>   no network involved and no way to recover.
> - **Signing out deletes every cache.** Not housekeeping: the caches hold pages
>   of a timeline in plaintext on disk, keyed only by URL and readable from a
>   devtools panel. This app holds medical notes and financial screenshots, so
>   leaving them for whoever opens the browser next is not an option. Both routes
>   are taken — a message to the worker, and `caches.delete` from the page for
>   when no worker is controlling the document yet.
> - **`worker-src 'self'` had to be added to the CSP.** `worker-src` falls back
>   to `script-src`, which carries `strict-dynamic`, which tells the browser to
>   ignore host allowlists — `'self'` included. Without the explicit directive
>   the registration fails silently and takes the whole offline app with it.
>
> **Web Push is built** — the worker's `push` and `notificationclick` handlers,
and the server half in `modules/notifications/infrastructure/`. See §8.4.

Still not built, in the worker: **thumbnails are not cached**. They are signed
> R2 URLs, so cross-origin and opaque, and an opaque response is padded against
> the storage quota (~7MB each in some browsers) — enough of a reason to do it
> deliberately rather than in passing. A photo verse read offline shows its text
> and an empty tile. (The `push` handler that was missing here is now built —
> see §8.4.)
> - **A conflict no longer lands in the editor.** It used to be thrown while the
>   sheet was open, which put the message where the change had been typed. It now
>   surfaces on the row, because the sheet no longer waits for the network — the
>   deliberate cost of not blocking a person composing a verse underground.

### 8.2 Search

**Substring matching over the columns**, no external search service and no
full-text index. Postgres full-text was built here first and then removed; the
reason is below.

- `ILIKE '%term%'` against `xp`, the text values of `properties`, and the names
  of the tags the verse carries (hyphens read as spaces, so `.barcelona-trip`
  is findable by either half).
- **Whitespace splits terms, and every term must appear.** `-word` excludes. A
  wrapping quote is dropped rather than searched for. Nothing else is syntax.
- **Accents are folded on both sides** by `unaccent` (migration
  `search_unaccent`), so `cafe` finds `Café` and `manana` finds `mañana`. On a
  timeline written partly in Spanish that is not an edge case.
- **Search runs through the same visibility resolver as every other read path**
  (§2). Search is the single most likely place for a disclosure bug, because
  it's tempting to write a fast bespoke query — don't.
- Filters compose with search: tags (AND/OR), date range, rating, has-media.
- **Newest first.** There is no relevance score to order by, and none was
  wanted: searching your own life is not searching a corpus.

> **Why full text was removed: it cannot see inside Chinese.**
>
> Postgres tokenises on whitespace, and Chinese is written without it. Verified
> directly against this database: `to_tsvector('simple', '我今天去了巴塞罗那吃饭')`
> yields exactly **one lexeme** — the entire sentence — and a tsquery for
> 巴塞罗那 does not match it. `ILIKE '%巴塞罗那%'` does. This is not a tuning
> problem; it needs a segmenting extension (`zhparser`, `pg_jieba`), and
> neither is available on Neon. With Mandarin a supported interface language,
> a search that silently fails in it is not a search.
>
> Substring matching has no such blind spot, because it never tokenises. It
> also fixed a second complaint in passing: a whole-word matcher answers
> "nothing" to every keystroke before the last, so a field that filters as you
> type reads as broken when it is merely strict. `to_tsquery` could do prefixes
> (`oliv:*`) but only at the front of a word.
>
> **What was given up, plainly:** stemming (`olives` does not find `olive`, in
> any language — it never worked for Chinese either), ranking, and phrase
> search. Also gone with them: the `search_vector` column, its GIN index, the
> vector rebuild on every verse write, and `refreshSearchForTag` — a
> denormalised copy of each tag's name in every verse carrying it, which a
> rename had to chase down. Reading the tag names through a join at query time
> makes a rename correct because nothing was duplicated, rather than because
> something remembered to fix it.
>
> **Escaping is real here in a way it was not before.** `%` and `_` are `LIKE`
> wildcards, so a person typing `100%` must not get "100 followed by anything".
> `domain/search-query.ts` escapes `\`, `%` and `_`, backslash first, and every
> pattern reaches SQL as a bound parameter.
>
> **No trigram index yet.** `pg_trgm` is installed and a GIN index on
> `xp` would speed these scans up, but it needs an IMMUTABLE wrapper around
> `unaccent()` (which is STABLE) to be usable. At one person's timeline the
> sequential scan is not worth the extra surface — revisit if it shows up in
> the logs.
>
> **The timeline takes `q` too**, sharing this one predicate, so the two
> surfaces cannot disagree about what a word matches — see §8.2's UI note.

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

- ~~Cloud Scheduler → `/internal/notifications/tick` every 5 minutes.~~
  Replaced: a wake-up at each reminder's own time. See the note below.
- Claims due rows with `SELECT ... FOR UPDATE SKIP LOCKED` — safe if two
  instances tick concurrently.
- **Web Push** primary (free; works on Android Chrome and iOS 16.4+ when
  installed as a PWA), **email fallback** via Resend.
- Recurrence stored as RRULE; next occurrence computed on dispatch rather than
  materializing a year of rows.
- Quiet hours per user — never dispatch a medication reminder at 03:00 because
  of a timezone bug.

> **The dispatcher is woken, not polled.** The five-minute cron shipped and
> worked — a reminder was delivered end to end on it — and it was still the
> wrong shape for this platform. Its deploy script accounted for what 288
> wake-ups a day cost Cloud Run (nothing) and not for what they cost the
> database: Neon suspends after five idle minutes, so a five-minute poll means
> it never does, and the free plan's monthly compute allowance covers a little
> over half a month of that. A feature that quietly spends the whole database
> budget on asking "anything due?" is the opposite of §3.1.
>
> So each reminder asks for one callback at its own fire time, through the
> deferred-jobs queue that already exists for thumbnails (§1.3), and the
> service and database sleep until it arrives. Three rules hold it together:
>
> - **A wake-up is a hint, never the truth.** It names no reminder and carries
>   no payload; it says "run a tick", and the tick claims whatever is actually
>   due. A duplicate claims nothing, a late one claims what is overdue.
> - **Every tick leaves the next wake-up behind.** One query for the earliest
>   pending reminder covers a recurrence's next occurrence, a quiet-hours
>   deferral, a retry's backoff and a backlog in the same line. Wake-ups are
>   deduplicated by the second, or each duplicate would schedule its own
>   successor and the callbacks per reminder would only grow.
> - **The daily sweep runs a tick too.** A callback can be lost, and a reminder
>   set weeks ahead is beyond the two-day horizon when it is created; the
>   sweep's tick is what catches the first and schedules the second. Worst
>   case for a lost wake-up is a day late, not never.
>
> Creating a reminder asks for the wake-up *before* writing the row. Asking and
> then failing to store costs one empty tick; the other order stores a reminder
> with nothing to fire it and answers 201. Wake-ups are asked for two seconds
> after the fire time, because the queue's clock and the service's are two
> clocks and an early callback finds nothing due.
>
> Reminders are also now accurate to seconds rather than to five minutes.
> Locally there is no scheduler and no timer standing in for one: the tick
> route is called by hand, like the retention sweep (§7.1). **Not proven in
> production** — the scheduled-delivery half of Cloud Tasks cannot be reached
> from the development sandbox, so the first real reminder after this deploys
> is the test.
>
> **Built in two halves.** Email first and Web Push second, deliberately: Resend
> was already wired and proven, while push needs VAPID keys, a service worker
> and — on iOS — the PWA installed to the home screen before it delivers
> anything. Shipping the fallback first meant reminders worked for everyone on
> day one.
>
> **The encryption is hand-written** (`infrastructure/web-push.ts`), which is a
> thing this project otherwise avoids. RFC 8291 payload encryption and RFC 8292
> VAPID, with `node:crypto` and no dependency. What makes that defensible rather
> than brave is the test: it checks the output **byte for byte against
> `http_ece`**, an independent implementation, rather than round-tripping
> against itself. A round trip passes just as happily when the spec has been
> misread, because both halves misread it identically — and three deliberate
> mutations (swapped key order in the info string, swapped HKDF salt and IKM, a
> wrong padding delimiter) all round-trip fine and are all caught by the vector.
>
> **Push is preferred, email is the fallback, and the difference between "gone"
> and "failed" matters.** Every browser a person subscribed is tried. A 404 or
> 410 means that endpoint no longer exists, so the row is deleted and email
> takes over; any other failure is *thrown*, so the dispatcher retries rather
> than quietly downgrading and hiding that push is broken.
>
> **One row per browser, not per person.** Push is a capability of an install,
> so a laptop and a phone are two rows and a reminder goes to both. The endpoint
> is the unique key, so re-subscribing updates in place instead of accumulating
> duplicates that all buzz one device. Subscriptions are purged with the account
> (§8.7): a subscription is an address for reaching someone.
>
> **`POST /v1/push/test` exists so this can be answered at all.** Turning
> notifications on used to produce no visible result: the subscription was
> stored, and the next thing that would ever arrive was a reminder, at its own
> fire time, dispatched by a five-minute cron. Nothing on screen distinguished a
> working subscription from a dead one. The first report from a phone was "I
> tried push but didn't understand how it works", which is what a feature with
> no feedback feels like from outside.
>
> The endpoint is **push only — never the email fallback**. `PushWithEmailFallback`
> is right for a reminder and exactly wrong here: an email arriving would let the
> test answer "sent" while push itself was dead, retiring the one question the
> button exists to settle. It reports per-subscription counts (`delivered`,
> `removed`, `failures`) rather than a boolean, because the four answers need
> four different pieces of advice. `pushToAll` is shared with the reminder path,
> so the test runs the real encryption, the real VAPID signature and the real
> dead-endpoint cleanup; a test that shortcut any of those would prove the
> shortcut.
>
> **"Not configured" is not "unsupported".** Those shared one state until a
> local run rendered "add Agnte to your home screen" on a desktop browser that
> was perfectly capable — the actual cause was a server with no VAPID keys. The
> advice is opposite in the two cases (install the PWA; nothing you can do,
> reminders are arriving by email), so they are now separate states.
>
> **Still not proven end to end.** The encryption is checked against an
> independent implementation, the fallback logic and the worker's handlers are
> unit-tested, and the subscription and test endpoints are integration-tested —
> but no real push has been delivered to a real device. Headless Chromium
> refuses to register with a push service (`AbortError: Registration failed -
> permission denied`) and the sandbox cannot reach FCM, so the last link can
> only be closed on a phone: open the app, Menu → Reminders → Turn on, then
> **Send a test notification**. That last step is the part this endpoint added;
> before it, the only way to try was to schedule a reminder and wait.
>
> **A reminder is a Verse.** Scheduling one writes two rows: a Verse carrying
> what it says, when it is for and whatever tags it was given, and a
> `ScheduledNotification` carrying only the schedule and pointing at that Verse
> through the `verse_id` it already had.
>
> Three alternatives were considered and rejected. A second kind of row the
> timeline fetches separately and interleaves by date works, and then has to be
> taught about tags, media, visibility and editing one feature at a time —
> every one of which a Verse already has. A reminder carrying its own parallel
> tag list duplicates the tag table in another schema and drifts from it. And
> the timeline merging two sources server-side would be the cross-schema join
> §1.1 forbids outright.
>
> The orchestration is in the client, not in either module: it creates the
> Verse (through the outbox, §8.1) and then the reminder naming it. That keeps
> `notifications` from importing `verse` to do its work, which is the coupling
> the boundaries exist to prevent — and it costs nothing, because IDs are
> client-generated (§2), so the id is known before either write leaves the
> device.
>
> Two consequences worth stating plainly rather than discovering:
>
> - **The text is copied, not shared.** The notification keeps its own `title`,
>   taken when the reminder was made. Reading the verse at fire time would be a
>   cross-schema read. So editing the verse's note later does not change what
>   the notification will say.
> - **The verse is written first.** The reverse order fails worse: a reminder
>   pointing at a verse that was never queued fires a notification that opens
>   nothing. This way a failure between the two leaves a verse on the timeline
>   with no reminder behind it — visible, editable and obviously incomplete.
>
> Tapping the notification lands on `/?verse=<id>`, which the app reads once on
> load and then clears from the address bar (`_client/deep-link.ts`). The id is
> shape-checked before it is used: `?verse=` is reachable by anyone who can put
> a link in front of someone, and the value goes straight into a fetch path.

### 8.5 Data export

- `POST /v1/privacy/export` → Cloud Task → worker assembles JSON (all verses,
  tags, properties, shares) + original media into a ZIP in R2 → emails a signed
  URL valid 24h.

> **Built differently, deliberately (Phase 8).** Two deviations, both recorded
> here because the reasoning is the useful part.
>
> **Media travels as signed links, not bytes in a ZIP.** Assembling a
> multi-gigabyte archive inside a Cloud Run request means streaming a ZIP into a
> multipart upload with bounded memory, and realistically a Cloud Run Job rather
> than a request, since a large export outlives a request deadline. A manifest of
> 24-hour signed URLs hands over the same files with none of that machinery. The
> cost, stated plainly: the links expire, so this is an export someone must act
> on within the window rather than an archive they can file away.
>
> **The email carries a link to the app, not a signed URL.** A signed link in an
> email is a capability held by anyone who reads that mailbox or any system that
> scans it, and this file is the whole of someone's timeline — medical notes and
> financial screenshots included. `GET /v1/privacy/export/download` authenticates
> instead, looks the row up by the authenticated user, and never accepts or
> returns a storage key. One sign-in, one fewer class of exposure.
**Reachable from the app (built after the service worker).** Export, import and
erasure were API-only until a "Your data" sheet in the menu gave them a way in.
For the first two that was an inconvenience; for erasure it was closer to a
defect, since a right you can only exercise with `curl` and a bearer token is
not one most people hold. The sheet asks for a copy, downloads it (fetched with
the token and handed over as a blob — the endpoint authenticates, so an `<a
href>` would 401), reads a document back in and lists every refused row with its
reason, and deletes the account behind a two-step confirmation that says what
actually happens. Signing out from it clears the service worker's caches, so an
erased account leaves no cached timeline on the device.

- Async because media can run to gigabytes.
- Rate-limited to one export per user per 24h.
- Doubles as GDPR portability (§8.7) — one implementation, two requirements.

**The other direction (Phase 9).** `POST /v1/privacy/import` reads an
`agnte.export.v1` document back in. It is the foundation Phase 9's v1 migration
stands on: rather than a bespoke pipeline from v1's database, the migration is a
converter script that emits this format, and anything else that can emit it can
become a timeline too.

- **Every row goes through the domain's constructors** — `parseTagName`,
  `parsePlacement`, `parseProperties`, `createVerse` — never a direct insert. An
  import is the one write path whose data did not come from the app, so it is
  the last one that should be exempt from the rules.
- **Refused rows are reported, not dropped.** The response lists what was
  refused and why. A visibility the document names but this version does not
  know is refused rather than defaulted: the two plausible defaults are
  "private" (silently changing what someone exported) and "inherit" (silently
  widening it), and the second is a disclosure.
- **A document is not trusted about whose tags it names.** Tag ids are checked
  against the importing account; since tag visibility drives verse visibility
  (§2), a hand-edited file filing a verse into a stranger's tag would be a
  disclosure route rather than untidy data.
- **Idempotent by content, not by an idempotency key**, so "run it, fix the
  file, run it again" is the natural way to use it. Tags match on name, which is
  their natural key. Verses have none, so they match on id: a file's id is kept
  when it is free, and when it is already held — importing a friend's export, or
  a v1 id that is not a UUID at all — the row is written under an id *derived*
  from the owner and that id (`derivedUuidv7`). A random replacement would be a
  different id on every run and would duplicate the whole timeline on the
  second.
- **Media is not imported**, and cannot be by this route: the export carries
  photos as expiring links rather than bytes. The response says so rather than
  leaving it to be discovered from a timeline of empty tiles.

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

### 8.6.1 Languages

The interface is offered in **English, Spanish, French and Mandarin**, and the
set is meant to grow by adding a file.

- **String tables in TypeScript**, one per language, under `src/shared/i18n`.
  `Strings` is derived from the English table (`type Strings = typeof en`), so
  a missing key, a misspelled one, or a function whose arguments moved are all
  compile errors. A JSON catalogue would defer every one of those to the moment
  someone opens that screen, in a language nobody here reads.
- **Anything carrying a value is a function**, not a template with holes:
  `nothingMatches(text)` rather than `"Nothing matches {text}"`. No format
  parser, no runtime key errors, and word order is the table's to decide —
  which matters more than the words. `dates.dayMonth(day, date, month)` is how
  Spanish gets "lunes, 3 de marzo" and Chinese gets 3月1日 星期日 out of the
  same three parts.
- **Counting is per noun.** English and Spanish need two forms, French agrees
  except at zero, Chinese has one and a measure word instead. One `{n, plural}`
  syntax would encode English's rules in the key.
- **Deep time regroups rather than translates.** Chinese counts in 万 (10⁴) and
  亿 (10⁸), so 13.8 billion years is 138亿年 — the number changes, not just the
  unit after it. `deepTime` hands over a magnitude and lets each table say what
  it wants. A shared "{n} {unit}" template would have been wrong in a way no
  English reader would notice.
- **The preference is a column on the user** (`identity.user.locale`), not only
  browser state. The writer that most needs it has no request to read a header
  from: the nightly reminder tick composes an email from a Cloud Scheduler
  callback. `contactFor(userId)` carries the address and the language together
  across the module boundary — the same narrow surface `contactEmailFor`
  already used, rather than exporting the user repository.
- **The browser does not wait for the server.** `app/_client/locale.ts` is an
  external store read through `useSyncExternalStore`, the same shape as the
  session and for the same reason: state set in an effect renders one frame in
  the wrong language on every open. Resolution is an explicit choice, then
  `navigator.languages` with the region dropped, then English. Signing in
  adopts the account's language only when this browser has no explicit choice
  of its own.
- **Formatters take the table as an argument.** `headerLabel(placement, now, s)`
  — no hook, no ambient "current locale". A formatter that reads ambient state
  renders differently depending on when it is called, which is the property the
  "clock passed in" rule already exists to prevent.

> **Server errors are translated on the client, by code.** Every error body is
> `{ error: { code, message } }`; the message stays English and the client
> picks its own sentence from `errors` in the string table (`serverSaid`). The
> server stays language-free, and a native client reuses the same codes. A
> code with no entry falls back to the server's English. The translated
> sentences are deliberately number-free ("that password is too short", not
> "at least 12 characters"), which loses a detail the English message had.
>
> **The Mandarin table has not been reviewed by a native speaker.** The
> structure is compiler-checked and the number regrouping is tested, but
> fluency is not something a type can assert. It ships as a first draft because
> the alternative was offering the language in the picker and rendering
> English.

### 8.7 GDPR

You're EU-based, this is multi-user, and it stores health notes, financial
screenshots, and other people's data via shared trips. These are real
obligations, and erasure in particular is far cheaper to design in now.

**Right to erasure** — `DELETE /v1/me` → soft-delete → `user.erasure_requested`
event → each module purges its own data (exactly what module boundaries buy you)
→ media purged from R2 → hard delete after a 30-day grace window.

> **Implementation note, added when erasure was built (Phase 8).** Anonymization
> is not implemented, because it currently has nothing to act on: `contribute`
> is an open decision, the application layer refuses contribute writes, and so
> no Verse can exist that one person wrote onto another person's tag. Erasure
> deletes what you own.
>
> Whoever lands `contribute` must land anonymization with it, and should know
> about a gap that implementing it surfaced: `canRead` grants access by
> ownership, by `public`, or by an explicit share row — and a tag's *owner* is
> not a grantee of their own tag. Anonymizing a Verse's `ownerId` would
> therefore make it readable by **nobody**, which is functionally the deletion
> the rule exists to prevent. The options are a share row granted at
> anonymization, a transfer of ownership to the tag owner, or a change to the
> visibility rule itself — the last being the most safety-critical function in
> this system, and the last resort.

> **Correction, found while building the erasure UI.** This section and the
> build order both describe the thirty days as a grace window — "the window in
> which they can still change their mind". That is not what the code does, and
> the code is right: `requestErasure` marks the account *and publishes the
> event*, so every module purges its data immediately. Only the identity row
> waits thirty days. There is no cancel endpoint and no way back from the app.
>
> This matters because the UI has to say something true. It now reads "this
> deletes your verses, tags, photos and reminders now, not in 30 days", and
> points at the export first. Anyone reinstating a genuine grace period has to
> defer the purge, not just the row.

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

> **Built in Phase 1.** A Cloud Run Job (`infra/backup/`) rather than the
> `/internal/*` route §1.3 uses for other deferred work: a dump can outlive the
> service's 60s request timeout, and `pg_dump` in the web image would be pulled
> on every cold start of a service that never runs it. The job refuses to call
> anything a backup unless the dump exceeds a plausible minimum *and* the object
> read back from R2 hashes identically to what was sent. The rehearsal is
> `infra/backup/verify-restore.mjs`, and it is a script rather than a note
> because §8.8 is right that an untested backup is a guess. Media versioning
> remains a Cloudflare dashboard action — see docs/operations.md §2g.

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
8. **`privacy`** — export + erasure.
9. **v1 data migration.**

> **Backups moved to Phase 1.** They were listed here with `privacy`, but real
> accounts with real password hashes exist from the moment registration ships,
> and §8.8 already calls Neon's free-tier recovery window insufficient on its
> own. Waiting until Phase 8 means carrying eight phases of data on a recovery
> story the document itself rejects. The nightly dump to R2 lands as Phase 1's
> last task; the monthly restore rehearsal stays with `privacy`, where there is
> enough data for a row-count check to mean something.

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

---

## 11. Wanted next — captured, not designed

Asked for after the current build. Written down here rather than in a message
so the reasoning survives, and deliberately *not* designed: each entry says
what it is, where it lands, and what it collides with. None of it is scheduled
and none of it changes anything above.

### 11.1 Reading key/value out of an image

Dates, reservation numbers, seat, gate — pulled off a photographed or
screenshotted booking and written into the Verse.

The target already exists: `properties` is schema-free key/value, and the five
verticals (§`.flight`, `.hotel`, `.restaurant`, `.concert`, `.movie`) already
carry *suggested* property sets, which double as a list of what is worth
looking for in a `.flight` image.

The hard part is not the extraction, it is the bill. OCR and vision models are
metered, and §3.1 has exactly one metered dependency today (Places) with a
paragraph explaining why that is a deliberate exception. A second one needs the
same argument made again: per-image cost, a cap, and a default of *off*. The
three shapes, cheapest first — on-device OCR in WASM (free, no egress, worst
accuracy on a crumpled boarding pass), a cloud OCR API (cheap per call, returns
text and not fields), a vision model (returns fields directly, costs the most).

Whichever it is, it runs as deferred work through Cloud Tasks like thumbnails
do (§1.3), never in the upload request: extraction that fails must not fail the
upload, and the photo is already safely in R2 by then.

**Every extracted value is a suggestion, not a fact.** A wrong seat number
written silently into a Verse is worse than no seat number, so the result
belongs in front of the person before it is saved.

### 11.2 Cropping an image

Straightforward, with one rule already decided: the original is kept precisely
so variants can be re-derived from it (§ media). A crop is therefore a *new
derived variant*, never a destructive edit of what was uploaded — the same
reason `medium` and `thumb` exist alongside the original.

Open: crop in the browser before upload (no round trip, and `downscale.ts`
already does canvas work client-side) or server-side from the original (lets
the crop be changed later, costs a Task per edit). The second is more in
keeping with keeping the original.

### 11.3 Periods of time, with inherited tags

A window — a trip, a stay, a festival — where a Verse falling inside it picks
up the window's tags.

**This is the closest anything has come to the Timeline entity that CLAUDE.md
records as considered and rejected**, and it needs to be resolved on purpose
rather than by accident. A period does not need a new table: a Verse already
takes `eventStart` *and* `eventEnd`, so a period is a Verse with a range. What
is new is the inheritance.

Two questions decide the whole shape:

1. **Computed at read time or written at write time?** Read-time means moving a
   trip's dates re-files everything inside it, which is the behaviour someone
   would expect and also means a Verse's tags are not a fact about the row.
   Write-time means the inheritance is a one-off suggestion applied on save,
   which is duller and far easier to reason about.
2. **What does it do to visibility?** This is the blocker, not a detail.
   Visibility resolves to the *most restrictive* among a Verse's tags and fails
   closed (CLAUDE.md), and this app holds medical notes and financial
   screenshots. Tags arriving implicitly because of a date range means
   visibility can change without anyone touching the Verse — and worse, a
   period made public could pull a private Verse's resolution in a direction
   nobody asked for. Any design here has to state what happens to an inherited
   tag in the resolver, and the safe answer is probably that inherited tags
   narrow visibility but never widen it.

### 11.4 Default location for a period

"I lived in Lisbon from March to September." "This flight confirmation says I
am in Berlin from the 3rd to the 9th." Verses written in that window get the
location filled in.

The same mechanism as 11.3 and blocked behind the same two questions, plus one
of its own: a default is not the same as a value. A location that was
*inherited* and one that was *typed* need to be distinguishable, or correcting
one Verse's location looks identical to the period being wrong.

Deriving the window from a confirmed booking is 11.1 and 11.3 stacked: extract
the dates and the city from a `.flight` verse's image, propose a period, and
let it default the location. Worth noting it is the *last* of these to build,
not the first, however appealing it sounds — it is only as good as the two
features underneath it.

### 11.5 Tag visualisation

A dashboard per tag already exists (`GET /v1/tags/:id/dashboard`), and every
tag is already a filterable sub-timeline. So this is not new plumbing — it is
what those two surfaces show.

Worth being concrete about before building, because "visualisation" can mean
three different things here: what a tag looks like *over time* (a sparkline of
when you actually went to restaurants), what it looks like *against other tags*
(the co-tag data the dashboard already returns), and what a filtered timeline
looks like when it is a whole screen rather than a filter on the main one.

---

## 12. v3 — the chat redesign (planned, not built)

Asked for in November 2026, after v2's nine phases shipped. Everything in this
section is a plan and a set of decisions; none of it is code yet. It is written
down before the first line for the reason §11 was: each item collides with
something already decided, and the collisions are cheaper to find here.

### 12.1 What changes for the person using it

- **The timeline reads like a chat.** Still centred on today and scrollable
  both ways, but the past is up and the future is down. Today it is the other
  way round (`Timeline.tsx` renders the future reversed above the past).
- **A composer replaces the add button.** A text box pinned to the bottom, a
  microphone on one side for voice notes, and a `+` on the other for photos and
  video, files, reminders, locations, contacts, visibility and tags. Pasting an
  image, a link or a file into it makes a verse.
- **Typed text is parsed, not just stored.** `Trip to Recife from: 5 January
  2027 to: 24/02/27 where: Recife Airport rating: 8 .travel` becomes a verse
  with a range, a location, a rating and a tag. What was typed appears on the
  right; what Agnte understood appears on the left as an editable card. The
  form stays, as the way to edit a card.
- **Replying to a verse edits it.** `seat: 4A airplane: A320` sent as a reply
  adds two properties to the verse it replies to.
- **Screenshots become verses.** A flight confirmation yields origin,
  destination, times and the booking reference (§11.1, now scheduled).
- **Tags Agnte inferred are distinguishable from tags the person typed.**
- **Filtering grows**: tags as now, plus a date range and a place.
- **A tag can be published.** A public URL anyone can open — a restaurant's
  daily menu is the motivating case.
- **Native apps** for Android and iPhone.

### 12.2 Decisions made

1. **One timeline, ordered by event date.** A chat orders by when something was
   typed and this timeline orders by when it happened, and the request's own
   example separates them: a trip typed today belongs in January 2027. The
   event-date axis is the product, so it wins. The literal text is stored on
   the verse and shown beside its card *where the verse lives*; for an entry
   dated today, which is most of them, that is indistinguishable from a chat.
   For one filed elsewhere the composer answers with where it went and a jump.
2. **Ratings stay 0–10.**
3. **Voice notes are transcribed**, so they are searchable and go through the
   same parser as typed text.
4. **Still one person's app first.** No billing, no organisation accounts, no
   moderation queue. That bounds 12.5 below: metered features get hard
   per-day caps rather than a pricing model, and the billing kill switch stays
   exactly as it is, because the only account it can take down is the owner's.
   Publishing still needs the minimum a public page needs — see 12.4.
5. **One UI codebase is the preferred outcome, decided by a spike.** See 12.6.

### 12.3 The grammar

Deterministic and client-side. No model reads typed text: a parser is free,
instant, works offline, and can be tested exhaustively in four languages. It
lives in the shared `core` package (12.6) so every client parses identically.

- `key: value` sets a field or a property; `.name` adds a tag; whatever is left
  is `xp`.
- Reserved keys map to fields: `from`, `to`, `when`, `where`, `rating`,
  `visibility`. Anything else is a property — `seat: 4A`, `plat: rice with
  setas`.
- A value runs to the next key, so `entrée: croquetas plat: rice dessert: ice
  cream` is three properties.

Traps already known, each of which needs a rule and a test before the composer
ships:

- **Colons that are not keys.** `Note: call mom`, `10:30`, `https://…`. A key
  must be a single word directly followed by a colon and a space or a value,
  and times and URLs are recognised first.
- **Ambiguous dates.** `24/02/27` can only be day-first; `05/01/27` cannot be
  told apart. The reader's locale decides, and the card shows the
  interpretation so a wrong guess is visible rather than silent.
- **Property keys were ASCII-only** (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), so
  `entrée:` was refused by the domain. **Fixed ahead of the composer:** a key
  is now letters and digits in any script, NFC-normalised so a composed `é` and
  an `e` with a combining accent are one key, and accents are *not* folded —
  `entree` and `entrée` stay different, because a key is the label the person
  chose. Tag names are still ASCII; that was not asked for and is a separate
  decision, since a tag name is also a URL segment once tags can be published.
- **Keywords are localised with the interface** (decided). `from:` in English
  is `desde:` in Spanish, and each string table carries its own reserved keys
  the same way it carries its own month names. Two consequences to design for:
  a reserved key in one language is an ordinary property key in another (`de:`
  is "from" in Spanish and nothing in English), so the same text parses
  differently under a different interface language — which is why the literal
  text and the parsed result are both stored, and a re-parse is never automatic.
  And English keys are accepted in every language as a fallback, so a habit
  formed in one language keeps working after switching.
- **Precision.** A parsed date with no time is `'date'`; with a time it is
  `'minute'` in the typist's zone. This is the reason the event-precision work
  (branch `claude/event-precision`) had to land first.

**Built:** `parseComposer` in `packages/core/src/composer.ts`, with each
language's reserved words in its string table (`composer`). Rules settled in
the building: an unreadable reserved value is kept as a property and listed in
`unread`, never dropped; visibility is read only from an exact word and is
otherwise unset; a range has one precision, so a time on one end only is
ignored; an end typed without a year follows its start; English reads
ambiguous numeric dates day-first. `Note: call mom` is a property by the rule
— the card is what makes that visible.

**Built on the web client:** a composer bar pinned to the bottom of the
timeline, with the card above it showing what was understood *before* saving.
The literal text is stored in `verse.typed_text`, verbatim, and is never
rewritten by an edit to a field. A typed tag resolves to a tag of that name,
then to a tag with that shortcut, then to a new tag. A verse still needs a
tag, so text with none cannot be sent — the card says so. The plus in the bar
opens the form for what typing cannot say.

**The chat layout is built on the web client.** The column reads oldest at the
top, opens with today at the bottom of the screen just above the composer,
and continues into the future below. The flip is in the rendering only: pages
and their order from the API are unchanged. Older rows are now what gets
added above the reader, so the scroll correction moved to that side and
measures the today mark rather than the document height (the "Loading…" line
made the height wrong by 44px a page); the browser's own anchoring is turned
off so every browser takes the one path. A verse made in the composer shows
its literal text as a bubble on the right, above the card. Measured in
headless Chromium at phone width: five loads of older rows moved the tracked
row 0–1px. **Not checked on Safari/iOS**, which is the browser the manual
correction exists for. Known limit: the date header follows headings as they
scroll past, so after a programmatic jump it can lag until the next heading.
**Attachments and media kinds are built.** The composer bar attaches by
picking, by pasting, and by recording a voice note; each uploads as it is
added and the verse carries only media ids. Media is no longer images only:
a closed list of eighteen types — audio, video, PDF, text, CSV, calendar,
contact card, docx, xlsx — with nothing a browser would run (no HTML, SVG or
script). Caps are per kind: video 50MB, everything else 15MB. Only images are
thumbnailed and decoded; the other kinds go straight to `ready` and **their
bytes are not inspected**, so the declared type is trusted. A contact is a
`.vcf` attachment, not a structured field. Two header changes came with it:
`microphone=(self)` in the permissions policy and a `media-src` for object
storage — both found by pressing record in a browser.

**Restyle.** Controls are rounded boxes that carry their own name: an icon
and a placeholder inside, instead of a title above (`.control`, with the name
kept as `aria-label`). Icons are a small inline-SVG set in `Icon.tsx` — no
icon font, no package. The sheet has a larger radius and a grabber; quiet
buttons lose the underline for a soft wash; the composer is one pill holding
the text with attach and record inside it, and send is the one filled control.
The direction in CLAUDE.md stands — paper palette, hairlines, 150ms motion,
dark mode — only the shapes changed. Applied to the verse form and the
composer; the other forms (sign-in, reminders, tags) took the new shape of
inputs and buttons but still have titles above their fields.

**The bar and the form are one draft.** Pressing plus opens the form with
what the bar holds — the typed text already parsed into the fields, typed tags
as names, and anything attached in the bar carried along by name — so "write,
then plus, then add photos" continues the same verse. Saving from the form
stores the bar's text as `typedText` and clears the bar. The plus is no longer
the metallic button: at that size the gradient read as a grey disc, so it is
an accent-tinted one.

**A tap on a verse edits it.** From the timeline a verse opens straight in the
editor, focused on the part of the row that was tapped — the note, the place,
the time, the rating, or one property. The row is still one stretched button
(valid HTML, one accessible name); which part was tapped is read from what is
under the pointer. The verse is fetched fresh first, so the editor never
holds a stale version, and the editor carries Delete now that no read view
sits in front of it. Search results still open the read view. Photos on a row
are a swipeable strip with the next one peeking at the edge, and a tap opens
a full-screen viewer that swipes between them — both are the browser's own
scroll-snap, with no gesture code.

**Place and date-range filters.** The search bar gains a place field and a
From/To pair, narrowing the same page the text and tags do: `place` is a
substring of the location (case and accents ignored, `%` and `_` literal),
and `from`/`to` are days with the last day included — made exclusive once, in
the route, so no client does the arithmetic. A verse is in a range when it
overlaps it (a stay that began before `from` and runs into it counts);
deep-time and undated verses are never in one. Everything that narrows the
timeline clears together, and the bar stays up while any of it is set.
**Place is still a text column**, not a structured location: there is no
coordinate, no radius search and no "near here" — that needs the place
provider's identifier stored with the verse, which is a decision (a second
metered call per save) and is not made. Known limit: a date range reads
moments in UTC while the timeline displays them in the reader's zone, so a
verse within hours of a range boundary can sit on the other side of it.

Not built: **transcription of voice notes** (decided, but it is the second
metered dependency and needs a provider, a key and the daily cap of §12.5
before any code), stripping metadata from non-image files on erasure, video
thumbnails, and non-ASCII tag names. **Good to have, not a priority:**
reply-to-edit.

The parse is committed immediately and the card is editable afterwards — no
confirmation step — because a composer that asks "is this right?" after every
message is not a chat.

### 12.4 What the data model has to grow, and what each collides with

- **The literal text, and the history of replies.** A verse gains the entries
  that produced it: raw text, attachments, and the change each one made.
  Reply-to-edit is "append an entry", which also gives an edit history for free.
  Collides with nothing; it is new.
- **Inferred tags carry their origin.** `verse_tag` gains a source — typed or
  inferred. **An inferred tag must never widen visibility** (CLAUDE.md: fail
  closed). Today a verse inherits the most restrictive visibility among its
  tags, so a verse whose *only* tag is an inferred `.travel`, where `.travel`
  has been published, would be made public by a machine. Inferred tags are
  therefore excluded from resolution in the permissive direction, in the one
  function that resolves visibility, with a test that names this case.
  Inferred tags come from a fixed vocabulary at first, so extraction cannot
  mint tags.
- **Location becomes structured.** It is a bare string today. Filtering by
  place needs a place id and coordinates alongside the label; typed
  `where:` text needs a decision on whether it is geocoded (a metered call) or
  matched as text.
- **Media stops being images only.** `ALLOWED_CONTENT_TYPES` is JPEG, PNG and
  WebP. Audio, video and arbitrary files each need a size cap; video is stored
  as uploaded with a poster frame and is **never transcoded**, or it becomes
  the bill. Recorded audio differs by browser (WebM/Opus against MP4/AAC).
- **Contacts are other people's personal data.** A contact attached to a verse
  is third-party data under GDPR and is covered by export and erasure.
- **Publishing needs things that do not exist:** a handle on the user, an
  unauthenticated read path (there is none — every read authenticates), public
  media URLs that are not short-lived signed links and serve only derived
  variants with metadata stripped, and CDN caching. The read path goes through
  the same visibility resolver as every other (§2); it does not get its own
  query. Publishing is **retroactive** — every verse carrying only that tag
  becomes public — so it is confirmed against a count. Even for a one-person
  app, a public page needs a report address and a way to take a page down.
- **Link previews fetch arbitrary URLs from the server**, which is a
  request-forgery surface: private address ranges are blocked and the fetch is
  size- and time-bounded.

### 12.5 Metered dependencies: the rule changes, deliberately

§3.1's discipline allowed exactly one metered dependency (place suggestions).
v3 adds two: **vision extraction** for screenshots and **transcription** for
voice notes. The rule is not dropped; it is restated for more than one:

- every metered call sits behind a per-user daily cap enforced server-side,
- each is switched off by leaving its key unset, like Places, so `npm run dev`
  still needs no account,
- extraction runs as a deferred job (§1.3) and produces a **proposed** verse
  the person confirms, shown beside the screenshot it came from — a wrong date
  extracted silently is the worst failure this feature has,
- text inside an image is untrusted input: the extractor returns fields and
  nothing else, and nothing it returns is acted on,
- sending an image to a third party is asked for, not assumed. This app holds
  medical and financial screenshots; the processor, its region and its
  retention are written into §8.7 before the first image leaves.

### 12.6 Stack

**Kept:** TypeScript, Postgres, the modular monolith and its boundaries, R2,
Cloudflare, Cloud Run, the API inside the web deployable. The route handlers
are plain `Request → Response` functions, so moving them to their own service
later is mechanical and there is no reason to pay for it now.

**Changed:**

- **A monorepo with a shared `core` package** — design tokens, string tables,
  date formatting, the parser, the timeline arithmetic and the offline queue's
  rules. `format.ts` already carries a hand-copied duplicate of the verse
  module's timeline maths with a comment admitting what happens when they
  drift; a second client would make it three copies.
  **Started:** `packages/core` (`@agnte/core`, an npm workspace) holds the
  tokens, the string tables, date reading and the timeline scale; the verse
  domain and the web client now share one copy of that arithmetic. It is
  consumed as TypeScript source (`transpilePackages`), and ESLint forbids it
  React, Next, Node built-ins and app code. The web app deliberately **stays
  at the repository root** for now: moving it changes the image build and the
  deploy for no gain until `apps/mobile` exists. The parser and the offline
  queue's rules move in when the composer is built.
- **API errors are consumed by code, not prose** (§8.6.1's open gap). A native
  build in someone's pocket for months cannot depend on English sentences, and
  `/v1` becomes additive-only from the first store release.
- **Native apps on Expo (React Native).** A chat input, hold-to-record and the
  keyboard are where a wrapped web view feels wrong. iOS builds run in a cloud
  build service because the development machine is not a Mac. Push needs a
  native delivery adapter beside Web Push. The share sheet — "Share to Agnte"
  from any app — is the real successor to messaging things to yourself, and is
  the first native-only feature worth building.
- **Sign in with Apple**, required by the App Store once Google sign-in is
  offered.

**The spike.** Whether the signed-in app becomes one Expo codebase for web,
iOS and Android, or stays two (Next for web, Expo for native), is decided by
building the hardest screen once: a two-directional, date-sectioned timeline
with a sticky header and a keyboard-attached composer, on React Native, running
on the web and on a phone. One codebase halves every future UI change for a
solo developer, and its web output can be driven in a browser the same way the
current client is. The risk is that screen. If it holds, v3's UI is built once;
if it does not, `core` is shared and the two UIs are not. Public pages are
server-rendered either way.

**Repository.** Goes private, and stays on GitHub. Deployment is not limited by
the host — it happens on GCP through workload identity — and moving would mean
rewriting six workflows and the federation for a smaller free CI allowance.
The history up to this point has been public and should be treated as such.

### 12.7 Order of work

> **Spike result (step 2): share `core`, keep two UIs.** React Native's list
> on web cannot hold scroll position when older rows load above
> (`maintainVisibleContentPosition` is not implemented there), and the manual
> fix is defeated by estimated row heights. Measurements and what was not
> tried are in `apps/mobile/SPIKE.md`. The native half is **untested on a
> device**. `apps/mobile` is outside the npm workspace on purpose: its own
> lockfile and React version, and never in the web image.

Each step is one deliverable ending in a merged pull request.

1. **Foundations.** Merge `claude/event-precision`, 
   `claude/push-test-notification` and `claude/pause-runbook`; finish the display half of event
   precision (done, `claude/date-display`); replace the five-minute reminder cron with wake-ups (§8.4); the
   monorepo and `core`; error codes.
2. **The spike** (12.6), which decides how steps 3 and 8 are built.
3. **Composer and chat timeline.** Grammar, entries, reply-to-edit, the flip,
   paste, the `+` menu over what already exists.
4. **Media kinds.** Voice with transcription, files, capped video, contacts.
5. **Structured location and the new filters.**
6. **Publishing.**
7. **Screenshot extraction and inferred tags.**
8. **Native apps**, starting with the share sheet.

Not addressed here and still open: live updates across devices (a chat implies
them; nothing provides them today), the `contribute` permission (§10), and the
v1 converter, which is still blocked on v1's schema.

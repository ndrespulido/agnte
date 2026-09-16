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
> Still not built, in the worker: **thumbnails are not cached**. They are signed
> R2 URLs, so cross-origin and opaque, and an opaque response is padded against
> the storage quota (~7MB each in some browsers) — enough of a reason to do it
> deliberately rather than in passing. A photo verse read offline shows its text
> and an empty tile. And there is **no `push` handler**: the worker is the Web
> Push transport §8.4 needs, but nothing sends to it yet.
> - **A conflict no longer lands in the editor.** It used to be thrown while the
>   sheet was open, which put the message where the change had been typed. It now
>   surfaces on the row, because the sheet no longer waits for the network — the
>   deliberate cost of not blocking a person composing a verse underground.

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

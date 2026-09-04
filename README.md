# Agnte

> *A timeline for your life — write to it like a journal, query it like a database.*

A personal life-timeline app. You log fragments of lived experience as
**Verses**, placed on a timeline centred on today and scrollable into both past
and future — including deep time, back to the Big Bang.

This repository is **v2**, a rebuild. Nothing has been implemented yet: what's
here is the design that the build follows.

## Start here

| File | What it is |
|---|---|
| `CLAUDE.md` | Project context — read automatically by Claude Code each session |
| `docs/architecture.md` | The architecture and decision record. Read before writing code. |
| `docs/v1-reference/` | The previous version's schema and requirements, kept for the data migration and as a domain reference |

## Stack

Node/TypeScript · Next.js · PostgreSQL (Neon) · modular monolith ·
Google Cloud Run · Cloudflare R2 + CDN · Resend

## Status

**Phase 0 — not started.** Phase 0 is: repo, CI, preview environments,
Cloud Run + Neon + Cloudflare wired up, and cost controls including the billing
kill switch. The deployment path gets proven before anything is built on top of
it.

Build order is in `docs/architecture.md` §9.

## Constraints worth knowing before you touch anything

- **Local dev and pipeline both matter.** `npm run dev` must work with no GCP
  account, no Cloudflare account and no Docker — see `docs/architecture.md`
  §7.1. Every PR still produces a preview URL for checking on a phone.
- **Cost must stay near zero.** Scale-to-zero, `max-instances` caps, no NAT
  gateway, no load balancer. See `docs/architecture.md` §3.1 — the billing kill
  switch is part of Phase 0, not an afterthought.
- **Visibility resolution fails closed.** This app holds medical notes and
  financial screenshots. See `docs/architecture.md` §2.

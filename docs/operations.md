# Operations

The infrastructure for Agnte is a set of idempotent scripts in `infra/` plus
this runbook, rather than Terraform (decided in Phase 0: ~15 resources, touched
once, and a state backend would be its own bootstrap problem). That trade only
holds if this document stays good enough to rebuild the project from nothing.

Everything below is a one-time setup step. Per-deploy infrastructure lives in
`.github/workflows/`.

---

## Status of the setup

| Step | What it creates | Task | Done |
|---|---|---|---|
| GCP bootstrap | Project, APIs, Artifact Registry, service accounts, budget | 0.3 | ☐ |
| Neon project | Database, connection strings | 0.4 | ☐ |
| Cloudflare R2 | Bucket, scoped API token | 0.5 | ☐ |
| Kill switch | Pub/Sub topic, billing-disable function | 0.6 | ☐ |
| Workload Identity | Keyless GitHub Actions → GCP auth | 0.8 | ☐ |

---

## 1. GCP bootstrap (task 0.3)

### Before running

Pick the project ID first — it is permanent and globally unique. Something like
`agnte-prod` or `agnte-<something>`.

```bash
gcloud auth login
gcloud billing accounts list      # note the ACCOUNT_ID column
```

### Run

```bash
PROJECT_ID=agnte-prod \
BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X \
./infra/bootstrap-gcp.sh
```

Safe to re-run: every step checks before it creates. If it fails partway,
fix the cause and run it again rather than cleaning up by hand.

### What it deliberately does not do

- **No `compute.googleapis.com`.** Cloud Run does not need it, and a NAT
  gateway or load balancer cannot be created without it. Leaving the API off
  turns "never create one" (§3.1) from a discipline into a constraint.
- **No service account keys.** CI authenticates through Workload Identity
  Federation (task 0.8). A downloaded JSON key in a public repository's
  secrets is the single most common way a GCP project gets drained.
- **No project-level roles for the runtime account.** Secret access is granted
  per secret, so a new secret is never readable by accident.

### Region

Default `europe-west3` (Frankfurt), to sit in the same metro as the Neon
project. App-to-database latency is paid on every query; user-to-app latency is
paid once per request, and Cloudflare will absorb some of that later. Override
with `REGION=` if you pick a different Neon region.

---

## 2. Neon (task 0.4)

Console setup, three steps:

1. Create a project. **Choose a region in the same metro as `REGION` above** —
   `aws-eu-central-1` (Frankfurt) pairs with `europe-west3`.
   New Neon projects are AWS-only at time of writing; if a GCP European region
   now appears in the dropdown, prefer it and tell the team — it removes the
   cross-cloud hop entirely.
2. Create an API key (Account settings → API keys). This is what the preview
   workflow uses to create and delete a branch per PR.
3. Copy both connection strings for the `main` branch.

### Two connection strings, not one

Prisma needs both, and using the wrong one for the wrong job is a slow, ugly
bug to find:

| Variable | Which string | Why |
|---|---|---|
| `DATABASE_URL` | **Pooled** (host contains `-pooler`) | The app. Cloud Run can start many instances; without the pooler they exhaust Postgres connections. |
| `DIRECT_URL` | **Direct** (no `-pooler`) | Migrations. The migration engine needs a real session; PgBouncer's transaction pooling breaks it. |

### Free plan limits that shape the pipeline

- **10 branches per project.** Branch-per-PR runs into this, so teardown on PR
  close is load-bearing, not housekeeping — plus the nightly orphan sweeper in
  task 0.9 for the cases where the close event never fires.
- **0.5 GB storage, 100 CU-hours per month.** Computes suspend after 5 minutes
  idle, so previews cost almost nothing when nobody is looking at them.
- **5 GB public network transfer per month.** Cloud Run on GCP talking to Neon
  on AWS is public network transfer. Irrelevant at Phase 0 volumes; worth
  remembering before anything starts shipping large result sets.

---

## 3. Cost controls

### What actually protects the project

In order of how much they matter:

1. **`--max-instances=3`** on the production service, `1` on previews. A capped
   service cannot produce a runaway bill regardless of traffic.
2. **No NAT gateway, no load balancer.** Enforced by leaving the Compute API
   off entirely.
3. **Artifact Registry cleanup policy.** Images are one of the few things that
   cost money while the project is idle.
4. **Budget alerts** at roughly €5 / €10 / €20.
5. **The kill switch** at €30 (task 0.6).

### Why the kill switch is last on that list

GCP budget data lags actual spend by hours. A genuine runaway can pass €30
before the switch ever fires, so it is a backstop against a slow leak — a
forgotten resource, an image pile-up — not a cap. Treat items 1 and 2 as the
real protection.

### When the kill switch fires

Billing is disabled project-wide. Everything stops, including the function that
disabled it. This is correct for a last resort, and it is recoverable:

1. Find out *why* first — open the billing report before re-enabling, or you
   will just trigger it again.
2. Re-link billing: Console → Billing → Account management → link the project.
   (Or `gcloud billing projects link PROJECT_ID --billing-account=ACCOUNT_ID`.)
3. Redeploy. Cloud Run services may need recreating; the image may need
   rebuilding if Artifact Registry was pruned.
4. Nothing outside GCP is affected — Neon and R2 hold the data and are billed
   separately.

GCP deletes resources in a project with billing disabled after a grace period.
Everything in this project is reproducible from this repository, which is why
the destructive option is acceptable here.

---

## 4. Secrets

| Secret | Lives in | Used by |
|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Google Secret Manager | Cloud Run at runtime |
| `NEON_API_KEY` | GitHub Actions secrets | Preview branch create/delete |
| R2 credentials | Google Secret Manager | Cloud Run at runtime |
| `PREVIEW_PASSWORD` | Google Secret Manager | Preview access gate |

No service account keys anywhere. GCP auth from CI is Workload Identity
Federation (task 0.8); when that is set up, its attribute condition **must**
pin the repository, or any GitHub repository in the world can assume the
deployer account.

The repository is public. Workflows triggered by pull requests must never hold
write permissions or secrets, and the preview deploy is additionally gated on
the pull request originating from this repository rather than a fork.

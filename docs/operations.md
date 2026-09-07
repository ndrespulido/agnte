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
| GCP bootstrap | Project, APIs, Artifact Registry, service accounts, budget | 0.3 | ☑ |
| Workload Identity | Keyless GitHub Actions → GCP auth | 0.3b | ☑ |
| Neon project | Database, connection strings | 0.4 | ☑ |
| Cloudflare R2 | Bucket, scoped API token | 0.5 | ☑ |
| Kill switch | Pub/Sub topic, billing-disable function | 0.6 | ☐ |

---

## 1. GCP bootstrap (task 0.3)

### Before running

Pick the project ID first — it is permanent and globally unique. Something like
`agnte-prod` or `agnte-<something>`.

```bash
gcloud auth login
gcloud billing accounts list      # note the ACCOUNT_ID column
```

**Check the `OPEN` column reads `True`.** A closed billing account cannot be
linked to a project, and nothing in this project works without it. If it reads
`False`, open the [billing console](https://console.cloud.google.com/billing)
and either reactivate the account — usually by adding a valid payment method —
or create a new one and use its ID. The script refuses to run against a closed
account rather than creating a project it cannot finish configuring.

### Run

```bash
PROJECT_ID=agnte-prod \
BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X \
./infra/bootstrap-gcp.sh
```

Safe to re-run: every step checks before it creates. If it fails partway,
fix the cause and run it again rather than cleaning up by hand.

### If it fails partway

Re-run it. Every step checks before it creates, so a second run picks up where
the first stopped rather than duplicating anything.

**`PERMISSION_DENIED` on a resource you clearly own** — usually
`artifactregistry.repositories.create` — is almost always API propagation, not
IAM. Enabling an API returns as soon as the request is accepted, and calls made
before it is actually serving fail with a denial that reads like a
misconfigured account. The message even says "(or it may not exist)". The
script now waits for each API to report enabled and retries with backoff, so
this should not surface; if it does after several minutes, check you hold Owner
on the project:

```bash
gcloud projects get-iam-policy agnte-prod \
  --flatten=bindings[].members --format='value(bindings.role)' \
  --filter="bindings.members:$(gcloud config get-value account)"
```

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

## 1b. Workload Identity Federation (task 0.3b)

Moved ahead of the first deploy. The original plan had a manual deploy from a
locally built image, which is not possible here: the development machine has no
Docker (§7.1). The image can only be built in CI, so CI needs to authenticate
before anything can be deployed at all.

```bash
PROJECT_ID=agnte-prod GITHUB_REPO=ndrespulido/agnte ./infra/bootstrap-wif.sh
```

Then set the four values it prints as **repository variables** (not secrets):
Settings → Secrets and variables → Actions → Variables.

The script refuses to proceed if an existing provider is not pinned to this
repository. That condition is the security boundary — an OIDC provider without
it trusts a GitHub Actions token from *any* repository on GitHub, and it is the
step most commonly missed.

### Two service accounts, two jobs

`GCP_DEPLOYER_SA` is what CI impersonates. `GCP_RUNTIME_SA` is what the Cloud
Run service *runs as*, and it holds no project-level roles. Passing the deployer
to `--service-account` would give a public, internet-facing container the
ability to deploy revisions of itself; keep them distinct.

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

### You only need to copy one string

The pooler is a separate hostname for the same database, so the direct URL is
the pooled one with `-pooler` removed:

```
...@ep-something-1234-pooler.<region>.aws.neon.tech/neondb...   pooled
...@ep-something-1234.<region>.aws.neon.tech/neondb...          direct
```

`infra/set-secrets.sh` asks for the pooled string and derives the direct one,
showing both hosts with credentials masked so you can confirm before it stores
them. Pasting the same string into both slots was the easiest mistake to make
and the slowest to diagnose, so the script no longer offers the chance.

### Two connection strings, not one

Prisma needs both, and using the wrong one for the wrong job is a slow, ugly
bug to find:

| Variable | Which string | Why |
|---|---|---|
| `DATABASE_URL` | **Pooled** (host contains `-pooler`) | The app. Cloud Run can start many instances; without the pooler they exhaust Postgres connections. |
| `DIRECT_URL` | **Direct** (no `-pooler`) | Migrations. The migration engine needs a real session; PgBouncer's transaction pooling breaks it. |

### Storing the connection strings

Never paste either URL into a chat, a file, or a shell argument — an argument
lands in shell history and in the process table. This script reads both from
the terminal and stores them in Secret Manager:

```bash
PROJECT_ID=agnte-prod ./infra/set-secrets.sh
```

It refuses obvious mix-ups (a pooled URL in the direct slot and vice versa),
adds a new secret *version* rather than replacing, so a rotation is revertible,
and grants access per secret: the runtime account can read the pooled URL and
nothing else; the deployer can read the direct URL for migrations.

Neither string is stored in GitHub. CI reads the direct URL from Secret Manager
with its own identity; Cloud Run mounts the pooled one at deploy time.

To rotate: reset the password in the Neon console, then re-run the script.

The script verifies its own work before reporting success: it reads each IAM
policy back and confirms the binding is actually there. Granting and
having-been-granted are different things, and the failure mode otherwise
surfaces much later, as a `PERMISSION_DENIED` in a deploy.

If a deploy fails at **Run migrations** with `secretmanager.versions.access`
denied, check whether the secret exists at all — GCP returns the same denial
for a missing resource as for one you cannot read:

```bash
gcloud secrets list --project=agnte-prod
gcloud secrets get-iam-policy agnte-direct-url --project=agnte-prod
```

### How migrations run

`prisma migrate deploy` runs as a CI step *before* the Cloud Run deploy, never
at container boot. Booting instances would race each other for the migration
advisory lock and pay the cost on every cold start, and a failed migration
would leave a revision serving against the wrong schema. Running it first means
a bad migration stops the release instead.

The consequence is that **every migration must be backward-compatible with the
revision currently serving**, because the old revision keeps serving while the
new one deploys. Expand and contract: add a column in one release, backfill,
and only remove the old one in a later release. Rolling back a Cloud Run
revision does not roll back a migration.

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

## 2b. Cloudflare R2 (task 0.5)

In the Cloudflare dashboard:

1. **Create a bucket** — `agnte-media`. Choose the **EU jurisdiction** at
   creation; it cannot be changed afterwards, and it is what keeps object data
   in the EU (§8.7).
2. **Create an S3-compatible API token** — R2 → Manage API tokens → Create
   token, **Object Read & Write**, scoped to *that bucket only*. Copy the
   Access Key ID and Secret Access Key; the secret is shown once.
3. **Note the S3 API endpoint** from the bucket's settings, of the form
   `https://<account-id>.r2.cloudflarestorage.com`. An EU-jurisdiction bucket
   has `.eu.` in it — the jurisdiction is part of the endpoint rather than a
   separate setting, so use exactly what the dashboard shows.

Then store them:

```bash
PROJECT_ID=agnte-prod ./infra/set-secrets.sh
```

It asks for the database first and then R2; press Enter at the R2 endpoint
prompt to skip and leave existing R2 secrets untouched.

Before storing anything it round-trips a real object through the bucket with the
credentials given, so a wrong endpoint, bucket or token fails in seconds rather
than at the next deploy.

**The endpoint must match the bucket's jurisdiction.** An EU-created bucket is
reachable only through the endpoint containing `.eu.`; the default endpoint
answers `NoSuchBucket`, which reads like a mistyped bucket name. Cloudflare
shows both endpoints on the same page, so this is easy to get wrong.

### One bucket, prefixes per environment

Preview environments will share this bucket under an `R2_PREFIX` such as
`pr-12/`, rather than getting one bucket each. Buckets are a limited, manual
resource; prefixes are free and a lifecycle rule can expire them. Add that rule
when previews land in task 0.9 — until then nothing writes a prefix.

The application writes one object, `_healthcheck/probe`, on every health check
and reads it back. Round-tripping a fresh value is what proves the wire: a write
and a read of two unrelated objects would both pass against a bucket that
silently discarded writes.

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

### Deploying it (task 0.6)

```bash
PROJECT_ID=agnte-prod BILLING_ACCOUNT=012753-4C8C98-4A0FD4 ./infra/deploy-kill-switch.sh
```

Creates the Pub/Sub topic, a dedicated service account, the Cloud Function, and
points the existing budget at the topic. **It deploys disarmed**: the function
logs what it would do and changes nothing.

The service account gets `roles/billing.admin` **on the billing account** — a
genuinely powerful grant, and why this identity exists for nothing else. It is
not the runtime account and not the deployer.

### The trigger has its own identity

An Eventarc trigger invokes the function as a *different* identity from the one
the function runs as. Left unset it falls back to the default compute service
account — which this project does not have, because the Compute API is
deliberately disabled (§3.1) so a NAT gateway or load balancer cannot be
created at all.

The first deployment hit exactly that:

```
The request was not authenticated ... The IAM principal lacks {run.routes.invoke}
```

The script now names the trigger identity explicitly and grants it
`roles/eventarc.eventReceiver` on the project and `roles/run.invoker` scoped to
the function's own Cloud Run service — not project-wide, so the kill switch
cannot invoke the application.

Worth remembering when anything else event-driven is added: Cloud Tasks and
Cloud Scheduler callbacks in later phases will need the same treatment, and the
symptom is an unauthenticated-invocation warning rather than a permissions
error naming the missing role.

### Confirming real alerts reach the topic

Cloud Billing publishes budget notifications **periodically**, not only when a
threshold is crossed, so the real path proves itself within an hour of wiring
without any budget being exceeded. Look for lines like:

```
kill-switch: no action — 0% of budget (0 of 30 EUR)
```

That is the strongest confirmation available: Cloud Billing → Pub/Sub →
Eventarc → function, including Cloud Billing's own publish permission, which
the rehearsal cannot exercise because it publishes to the topic directly.

```bash
gcloud functions logs read agnte-kill-switch --region=europe-west3   --project=agnte-prod --limit=20
```

### If those lines never appear

The rehearsal publishes to the topic directly, so it proves the function, the
trigger and the IAM — but not that *Cloud Billing itself* can publish. Those are
separate paths, and only the second one carries a real budget alert.

Attaching the topic to the budget normally provisions Google's publisher access
automatically. The deploy script also tries to grant it explicitly, asking GCP
to name its own service agent rather than hardcoding an address — an earlier
version guessed `billing-budgets@system.gserviceaccount.com`, which does not
exist. That grant is best-effort and never stops the deployment.

To confirm the wiring after deploying, check the budget shows the topic:

```bash
gcloud billing budgets list --billing-account=<id>   --format='value(displayName, notificationsRule.pubsubTopic)'
```

Cloud Billing reports delivery failures against the budget in the console under
Billing → Budgets & alerts. If notifications are not arriving, granting
`roles/pubsub.publisher` on `agnte-budget-alerts` to the identity named there is
the fix.

### Rehearse before arming

An untested kill switch is a guess, and the alternative way to test it is to
overspend for real. Same argument as backups (§8.8): rehearse the one thing
whose failure is unrecoverable.

```bash
PROJECT_ID=agnte-prod ./infra/rehearse-kill-switch.sh
```

Publishes a synthetic over-threshold notification and shows what the function
logged. While disarmed you should see:

```
kill-switch: WOULD DISABLE BILLING for agnte-prod — budget exceeded: 999.99 of 30 EUR
```

Only once you have seen that, arm it:

```bash
ARMED=true PROJECT_ID=agnte-prod BILLING_ACCOUNT=... ./infra/deploy-kill-switch.sh
```

Rehearsing again **now really disables billing** — the script demands you type
`DISABLE BILLING` first. Doing that drill once, deliberately, is worth it: you
find out whether it works and you walk the recovery path calmly rather than
during an incident.

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

**The function disables its own project, so it cannot un-disable it.** That is
by design — a last resort should not be able to undo itself — but it means
recovery is always manual, through the console or a `gcloud billing projects
link` from your own account.

### What it will not catch

Budget data lags actual spend by hours. A genuine runaway can pass EUR 30 before
this function ever runs, so treat it as a backstop against a slow leak — a
forgotten resource, images piling up — rather than a cap.

The caps that actually bound the bill are `--max-instances=3` on Cloud Run and
the Compute API being left disabled, which makes a NAT gateway or load balancer
impossible to create rather than merely discouraged.

---

## 4. Secrets

| Secret | Lives in | Used by |
|---|---|---|
| `agnte-database-url` (pooled) | Google Secret Manager | Cloud Run at runtime |
| `agnte-direct-url` (direct) | Google Secret Manager | Migrations, read by CI |
| `NEON_API_KEY` | GitHub Actions secrets | Preview branch create/delete (task 0.9) |
| R2 credentials | Google Secret Manager | Cloud Run at runtime |
| `PREVIEW_PASSWORD` | Google Secret Manager | Preview access gate |

No service account keys anywhere. GCP auth from CI is Workload Identity
Federation (task 0.8); when that is set up, its attribute condition **must**
pin the repository, or any GitHub repository in the world can assume the
deployer account.

The repository is public. Workflows triggered by pull requests must never hold
write permissions or secrets, and the preview deploy is additionally gated on
the pull request originating from this repository rather than a fork.

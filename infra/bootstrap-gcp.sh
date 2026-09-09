#!/usr/bin/env bash
#
# One-time GCP bootstrap for Agnte (docs/architecture.md §3, §3.1).
#
# Idempotent: every step checks before it creates, so re-running after a
# failure is safe and is the intended way to use it. Nothing here is
# per-deploy — that lives in .github/workflows.
#
# Usage:
#   PROJECT_ID=agnte-prod BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X ./infra/bootstrap-gcp.sh
#
# Prerequisites: gcloud installed and `gcloud auth login` done.

set -euo pipefail

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID, e.g. agnte-prod}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:?set BILLING_ACCOUNT, from: gcloud billing accounts list}"

# Frankfurt. Chosen to sit in the same metro as the Neon project so the
# per-query cross-cloud hop is as short as possible — app-to-database latency
# is paid on every query, while user-to-app latency is paid once per request.
REGION="${REGION:-europe-west3}"

# Budget in EUR. The alert thresholds below are fractions of this amount, and
# the 100% threshold is what the kill switch will act on in task 0.6.
BUDGET_EUR="${BUDGET_EUR:-30}"

REPOSITORY="${REPOSITORY:-agnte}"
RUNTIME_SA="agnte-runtime"
DEPLOYER_SA="agnte-deployer"

# The queue deferred work goes through (architecture.md §1.3). One queue for
# every environment: a task carries its own callback URL, so a preview's task
# reaches the preview and production's reaches production, and queues are a
# named resource worth not multiplying per pull request. Must match
# CLOUD_TASKS_QUEUE in src/shared/infra/config.ts.
TASKS_QUEUE="${TASKS_QUEUE:-agnte-media-thumbnails}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# Enabling an API returns as soon as the request is accepted, not once the API
# is actually serving. Calls made in that window fail with PERMISSION_DENIED
# ("...or it may not exist"), which reads like a misconfigured account rather
# than a race. These two helpers are what stop that from derailing a first run.

wait_for_api() {
  local api="$1" waited=0
  while ! gcloud services list --enabled --project="${PROJECT_ID}" \
      --filter="config.name=${api}" --format='value(config.name)' 2>/dev/null | grep -q .; do
    if (( waited >= 180 )); then
      echo "  ${api} did not become active within 180s. Re-run the script."
      return 1
    fi
    note "waiting for ${api} to become active (${waited}s)"
    sleep 10
    waited=$(( waited + 10 ))
  done
}

retry() {
  local attempts="$1"; shift
  local delay=5 n=1
  until "$@"; do
    if (( n >= attempts )); then
      echo "  Command still failing after ${n} attempts: $*"
      return 1
    fi
    note "attempt ${n} failed; retrying in ${delay}s"
    sleep "${delay}"
    delay=$(( delay * 2 ))
    n=$(( n + 1 ))
  done
}

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

say "Preflight"
command -v gcloud >/dev/null || { echo "gcloud not found"; exit 1; }
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || { echo "Not authenticated. Run: gcloud auth login"; exit 1; }
note "Authenticated as $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
note "Project: ${PROJECT_ID}   Region: ${REGION}   Budget: EUR ${BUDGET_EUR}"

# A closed billing account cannot be linked to a project. Checking here rather
# than letting `gcloud billing projects link` fail further down means the
# script stops before creating anything, with a message that says what to do.
BILLING_OPEN="$(gcloud billing accounts describe "${BILLING_ACCOUNT}" \
  --format='value(open)' 2>/dev/null || true)"
if [[ -z "${BILLING_OPEN}" ]]; then
  echo
  echo "  Billing account ${BILLING_ACCOUNT} not found, or you lack access to it."
  echo "  List the ones you can see with: gcloud billing accounts list"
  exit 1
fi
if [[ "${BILLING_OPEN,,}" != "true" ]]; then
  echo
  echo "  Billing account ${BILLING_ACCOUNT} is CLOSED (open: ${BILLING_OPEN})."
  echo
  echo "  A closed account cannot be linked to a project, so nothing here would"
  echo "  work. Open https://console.cloud.google.com/billing and either:"
  echo "    - reactivate this account (usually: add a valid payment method), or"
  echo "    - create a new billing account and re-run with its ACCOUNT_ID."
  echo
  echo "  Nothing has been created. Re-run once billing is active."
  exit 1
fi
note "Billing account ${BILLING_ACCOUNT} is open."

# ----------------------------------------------------------------------------
# Project and billing
# ----------------------------------------------------------------------------

say "Project"
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  note "Already exists."
else
  gcloud projects create "${PROJECT_ID}" --name="Agnte"
  note "Created."
fi

gcloud config set project "${PROJECT_ID}" >/dev/null

say "Billing"
CURRENT_BILLING="$(gcloud billing projects describe "${PROJECT_ID}" \
  --format='value(billingAccountName)' 2>/dev/null || true)"
if [[ "${CURRENT_BILLING}" == *"${BILLING_ACCOUNT}"* ]]; then
  note "Already linked to ${BILLING_ACCOUNT}."
else
  gcloud billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT}"
  note "Linked."
fi

# ----------------------------------------------------------------------------
# APIs
#
# Deliberately NOT enabled: compute.googleapis.com. Cloud Run does not need it,
# and a NAT gateway or load balancer — the two classic surprise charges this
# project must never incur (§3.1) — cannot be created without it.
# ----------------------------------------------------------------------------

say "APIs"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  billingbudgets.googleapis.com \
  cloudtasks.googleapis.com \
  --project="${PROJECT_ID}"
note "Enabled."

# ----------------------------------------------------------------------------
# Artifact Registry
#
# Container images are one of the few things that cost money while the project
# is idle, so the cleanup policy is applied at creation rather than later.
# ----------------------------------------------------------------------------

say "Artifact Registry"
wait_for_api artifactregistry.googleapis.com

if gcloud artifacts repositories describe "${REPOSITORY}" \
     --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "Repository already exists."
else
  retry 5 gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Agnte container images" \
    --project="${PROJECT_ID}"
  note "Created."
fi

POLICY_FILE="$(dirname "$0")/artifact-registry-cleanup-policy.json"
retry 5 gcloud artifacts repositories set-cleanup-policies "${REPOSITORY}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --policy="${POLICY_FILE}" \
  --no-dry-run
note "Cleanup policy applied: keep 10 most recent, delete untagged after 7d."

# ----------------------------------------------------------------------------
# Service accounts
#
# Two, deliberately. The service the public internet can reach runs as
# RUNTIME_SA, which can do almost nothing; CI deploys as DEPLOYER_SA, which
# can. A single account for both would mean a compromised container could
# deploy a new revision of itself.
# ----------------------------------------------------------------------------

ensure_sa() {
  local name="$1" display="$2"
  if gcloud iam service-accounts describe \
       "${name}@${PROJECT_ID}.iam.gserviceaccount.com" \
       --project="${PROJECT_ID}" >/dev/null 2>&1; then
    note "${name}: already exists."
  else
    gcloud iam service-accounts create "${name}" \
      --display-name="${display}" --project="${PROJECT_ID}"
    note "${name}: created."
  fi
}

say "Service accounts"
ensure_sa "${RUNTIME_SA}" "Agnte Cloud Run runtime"
ensure_sa "${DEPLOYER_SA}" "Agnte CI deployer"

RUNTIME_EMAIL="${RUNTIME_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_EMAIL="${DEPLOYER_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

# The runtime account gets nothing at the project level yet. Secret access is
# granted per-secret in task 0.4, so a new secret is never readable by accident.

say "Deployer roles"
for role in roles/run.admin roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:${DEPLOYER_EMAIL}" \
    --role="${role}" --condition=None --quiet >/dev/null
  note "${role}"
done

# Needed so the deployer may deploy a service that *runs as* the runtime
# account. Scoped to that one account rather than granted project-wide.
gcloud iam service-accounts add-iam-policy-binding "${RUNTIME_EMAIL}" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" \
  --role="roles/iam.serviceAccountUser" \
  --project="${PROJECT_ID}" --quiet >/dev/null
note "roles/iam.serviceAccountUser (scoped to ${RUNTIME_SA})"

# ----------------------------------------------------------------------------
# Cloud Tasks (architecture.md §1.3, §8.3)
#
# Cloud Run may kill a container as soon as it returns a response, so work
# that must outlive the request — generating a photo's thumbnails — is handed
# to a queue that calls back into /internal/* in a request of its own.
#
# Free tier is one million operations a month; an upload enqueues one task, so
# this costs nothing at this project's scale.
# ----------------------------------------------------------------------------

say "Cloud Tasks"
wait_for_api cloudtasks.googleapis.com

if gcloud tasks queues describe "${TASKS_QUEUE}" \
    --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "Queue ${TASKS_QUEUE} already exists."
else
  # --max-attempts caps how long a genuinely broken task is retried. The
  # handler already writes `failed` to the row and answers 200 for an image it
  # can never process (modules/media/application/process-thumbnail.ts), so a
  # retry here only ever means an infrastructure failure — five attempts is
  # plenty, and unlimited retries against a persistent fault is how a free
  # tier stops being free.
  retry 3 gcloud tasks queues create "${TASKS_QUEUE}" \
    --location="${REGION}" \
    --project="${PROJECT_ID}" \
    --max-attempts=5 \
    --max-concurrent-dispatches=10 \
    --quiet >/dev/null
  note "Created ${TASKS_QUEUE} in ${REGION}."
fi

# The runtime account creates tasks; it does not administer the queue. Granted
# on the queue rather than the project, so a second queue added later is not
# writable by accident — the same scoping the serviceAccountUser grant above
# uses.
gcloud tasks queues add-iam-policy-binding "${TASKS_QUEUE}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_EMAIL}" \
  --role="roles/cloudtasks.enqueuer" \
  --quiet >/dev/null
note "roles/cloudtasks.enqueuer (scoped to ${TASKS_QUEUE})"

# Nothing grants Cloud Tasks permission to *invoke* Cloud Run, because the
# service runs --allow-unauthenticated (a preview has to be reachable from a
# phone with no Google account). /internal/* is kept private by a shared
# secret instead — see shared/infra/internal-auth.ts, and the
# agnte-internal-tasks-secret entry in ./infra/set-secrets.sh.

# ----------------------------------------------------------------------------
# Budget and alerts
#
# A budget is a notification, not a cap — and GCP's spend data lags by hours,
# so this is a backstop. The real protection is --max-instances on Cloud Run
# and the absence of a NAT gateway or load balancer (§3.1). The kill switch
# that consumes the 100% threshold is task 0.6.
# ----------------------------------------------------------------------------

say "Budget"
wait_for_api billingbudgets.googleapis.com
BUDGET_NAME="agnte-${PROJECT_ID}"
if gcloud billing budgets list --billing-account="${BILLING_ACCOUNT}" \
     --format='value(displayName)' 2>/dev/null | grep -qx "${BUDGET_NAME}"; then
  note "Budget '${BUDGET_NAME}' already exists — leaving it alone."
  note "To change the amount, edit it in the console or delete and re-run."
else
  gcloud billing budgets create \
    --billing-account="${BILLING_ACCOUNT}" \
    --display-name="${BUDGET_NAME}" \
    --budget-amount="${BUDGET_EUR}EUR" \
    --filter-projects="projects/$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')" \
    --threshold-rule=percent=0.17 \
    --threshold-rule=percent=0.34 \
    --threshold-rule=percent=0.67 \
    --threshold-rule=percent=1.0
  note "Created: EUR ${BUDGET_EUR} with alerts at ~5 / ~10 / ~20 / ${BUDGET_EUR} EUR."
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------

say "Done — values needed for the next step"
cat <<SUMMARY

    GCP_PROJECT_ID     ${PROJECT_ID}
    GCP_PROJECT_NUMBER $(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')
    GCP_REGION         ${REGION}
    ARTIFACT_REPO      ${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}
    RUNTIME_SA         ${RUNTIME_EMAIL}
    DEPLOYER_SA        ${DEPLOYER_EMAIL}
    CLOUD_TASKS_QUEUE  ${TASKS_QUEUE}

  None of these are secret — they are identifiers, safe to paste into a
  public repository or a chat. No service account key was created and none
  should be: CI authenticates through Workload Identity Federation (task 0.8).

SUMMARY

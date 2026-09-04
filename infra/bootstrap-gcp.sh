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

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------

say "Preflight"
command -v gcloud >/dev/null || { echo "gcloud not found"; exit 1; }
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || { echo "Not authenticated. Run: gcloud auth login"; exit 1; }
note "Authenticated as $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
note "Project: ${PROJECT_ID}   Region: ${REGION}   Budget: EUR ${BUDGET_EUR}"

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
  --project="${PROJECT_ID}"
note "Enabled."

# ----------------------------------------------------------------------------
# Artifact Registry
#
# Container images are one of the few things that cost money while the project
# is idle, so the cleanup policy is applied at creation rather than later.
# ----------------------------------------------------------------------------

say "Artifact Registry"
if gcloud artifacts repositories describe "${REPOSITORY}" \
     --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "Repository already exists."
else
  gcloud artifacts repositories create "${REPOSITORY}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Agnte container images" \
    --project="${PROJECT_ID}"
  note "Created."
fi

POLICY_FILE="$(dirname "$0")/artifact-registry-cleanup-policy.json"
gcloud artifacts repositories set-cleanup-policies "${REPOSITORY}" \
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
# Budget and alerts
#
# A budget is a notification, not a cap — and GCP's spend data lags by hours,
# so this is a backstop. The real protection is --max-instances on Cloud Run
# and the absence of a NAT gateway or load balancer (§3.1). The kill switch
# that consumes the 100% threshold is task 0.6.
# ----------------------------------------------------------------------------

say "Budget"
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

  None of these are secret — they are identifiers, safe to paste into a
  public repository or a chat. No service account key was created and none
  should be: CI authenticates through Workload Identity Federation (task 0.8).

SUMMARY

#!/usr/bin/env bash
#
# Budget kill switch (docs/architecture.md §3.1):
#   Budget -> Pub/Sub -> Cloud Function -> project billing disabled.
#
# Deploys DISARMED by default. Rehearse it with infra/rehearse-kill-switch.sh
# before arming; an untested kill switch is a guess, and the only way to find
# out otherwise is the moment you need it.
#
# Usage:
#   PROJECT_ID=agnte-prod BILLING_ACCOUNT=012753-4C8C98-4A0FD4 ./infra/deploy-kill-switch.sh
#   ARMED=true PROJECT_ID=... BILLING_ACCOUNT=... ./infra/deploy-kill-switch.sh   # to arm

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:?set BILLING_ACCOUNT, from: gcloud billing accounts list}"
REGION="${REGION:-europe-west3}"
ARMED="${ARMED:-false}"

TOPIC="agnte-budget-alerts"
FUNCTION="agnte-kill-switch"
KILL_SA="agnte-kill-switch"
KILL_EMAIL="${KILL_SA}@${PROJECT_ID}.iam.gserviceaccount.com"
BUDGET_NAME="agnte-${PROJECT_ID}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

retry() {
  local attempts="$1"; shift
  local delay=5 n=1
  until "$@"; do
    if (( n >= attempts )); then echo "  Still failing after ${n} attempts: $*"; return 1; fi
    note "attempt ${n} failed; retrying in ${delay}s"
    sleep "${delay}"; delay=$(( delay * 2 )); n=$(( n + 1 ))
  done
}

wait_for_api() {
  local api="$1" waited=0
  while ! gcloud services list --enabled --project="${PROJECT_ID}" \
      --filter="config.name=${api}" --format='value(config.name)' 2>/dev/null | grep -q .; do
    if (( waited >= 180 )); then echo "  ${api} did not become active. Re-run."; return 1; fi
    note "waiting for ${api} (${waited}s)"; sleep 10; waited=$(( waited + 10 ))
  done
}

say "Preflight"
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || { echo "Not authenticated. Run: gcloud auth login"; exit 1; }
note "Project ${PROJECT_ID}, region ${REGION}"
if [[ "${ARMED}" == "true" ]]; then
  note "ARMED — this deployment will really disable billing when the budget is exceeded."
else
  note "DISARMED — it will log what it would do and change nothing."
fi

# ----------------------------------------------------------------------------
# APIs
#
# A 2nd-gen function is a Cloud Run service built by Cloud Build, so both are
# needed, plus Eventarc for the Pub/Sub trigger.
# ----------------------------------------------------------------------------

say "APIs"
gcloud services enable \
  cloudfunctions.googleapis.com \
  cloudbuild.googleapis.com \
  eventarc.googleapis.com \
  pubsub.googleapis.com \
  logging.googleapis.com \
  --project="${PROJECT_ID}"
for api in cloudfunctions.googleapis.com pubsub.googleapis.com eventarc.googleapis.com; do
  wait_for_api "${api}"
done
note "Enabled."

# ----------------------------------------------------------------------------
# Pub/Sub
# ----------------------------------------------------------------------------

say "Pub/Sub topic"
if gcloud pubsub topics describe "${TOPIC}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "Already exists."
else
  retry 5 gcloud pubsub topics create "${TOPIC}" --project="${PROJECT_ID}"
  note "Created."
fi

# Cloud Billing publishes budget notifications as a Google-managed service
# agent. Rather than hardcode its address — the first attempt guessed
# billing-budgets@system.gserviceaccount.com, which does not exist — ask GCP to
# provision and name it.
#
# Best-effort on purpose. Attaching a topic to a budget provisions this access
# on Google's side, so the explicit grant is belt and braces; and the rehearsal
# publishes to the topic directly, so the function path is fully testable
# without it. Only real budget alerts depend on this, and a failure here must
# not stop the deployment of the switch itself.
say "Letting Cloud Billing publish to the topic"
BUDGET_AGENT="$(gcloud beta services identity create \
  --service=billingbudgets.googleapis.com --project="${PROJECT_ID}" \
  --format='value(email)' 2>/dev/null || true)"

if [[ -n "${BUDGET_AGENT}" ]]; then
  if gcloud pubsub topics add-iam-policy-binding "${TOPIC}" \
       --member="serviceAccount:${BUDGET_AGENT}" \
       --role=roles/pubsub.publisher \
       --project="${PROJECT_ID}" --quiet >/dev/null 2>&1; then
    note "Granted to ${BUDGET_AGENT}."
  else
    note "Could not grant to ${BUDGET_AGENT}; continuing."
    note "See 'Confirming real alerts reach the topic' in docs/operations.md."
  fi
else
  note "GCP did not name a service agent for billingbudgets; continuing."
  note "Attaching the topic to the budget below normally provisions this."
  note "See 'Confirming real alerts reach the topic' in docs/operations.md."
fi

# ----------------------------------------------------------------------------
# Service account
#
# Its own account, used for nothing else. roles/billing.admin on the BILLING
# ACCOUNT is what lets it turn billing off — a genuinely powerful grant, and the
# reason this identity is isolated rather than reusing the runtime or deployer.
# ----------------------------------------------------------------------------

say "Service account"
if gcloud iam service-accounts describe "${KILL_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "Already exists."
else
  gcloud iam service-accounts create "${KILL_SA}" \
    --display-name="Agnte budget kill switch" --project="${PROJECT_ID}"
  note "Created."
fi

say "Granting billing.admin on the billing account"
note "This lets ${KILL_SA} disable billing. It is used for nothing else."
retry 3 gcloud billing accounts add-iam-policy-binding "${BILLING_ACCOUNT}" \
  --member="serviceAccount:${KILL_EMAIL}" \
  --role=roles/billing.admin --quiet >/dev/null
note "Granted."

# ----------------------------------------------------------------------------
# Function
# ----------------------------------------------------------------------------

# An Eventarc trigger invokes the function as its own identity, separate from
# the runtime identity. Left unset it falls back to the default compute service
# account — which this project does not have, because the Compute API is
# deliberately disabled so a NAT gateway or load balancer cannot be created
# (§3.1). So the trigger identity is named explicitly, and needs two roles:
# eventReceiver to accept the event, and run.invoker to call the function.
say "Roles for the trigger identity"
retry 3 gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${KILL_EMAIL}" \
  --role=roles/eventarc.eventReceiver --condition=None --quiet >/dev/null
note "roles/eventarc.eventReceiver"

say "Deploying the function (ARMED=${ARMED})"
retry 3 gcloud functions deploy "${FUNCTION}" \
  --gen2 \
  --runtime=nodejs22 \
  --region="${REGION}" \
  --source="$(dirname "$0")/kill-switch" \
  --entry-point=killSwitch \
  --trigger-topic="${TOPIC}" \
  --service-account="${KILL_EMAIL}" \
  --trigger-service-account="${KILL_EMAIL}" \
  --set-env-vars="TARGET_PROJECT_ID=${PROJECT_ID},ARMED=${ARMED}" \
  --max-instances=1 \
  --memory=256Mi \
  --timeout=60s \
  --project="${PROJECT_ID}"
note "Deployed."

# Granted after the deploy because the underlying Cloud Run service does not
# exist until then. Scoped to that one service rather than the project, so the
# kill switch cannot invoke the application.
say "Allowing the trigger to invoke the function"
retry 5 gcloud run services add-iam-policy-binding "${FUNCTION}" \
  --region="${REGION}" \
  --member="serviceAccount:${KILL_EMAIL}" \
  --role=roles/run.invoker \
  --project="${PROJECT_ID}" --quiet >/dev/null
note "roles/run.invoker on ${FUNCTION}"

# Building the function pushes images into a gcf-artifacts repository, which is
# storage that costs money while idle — the same reason the app's repository has
# a cleanup policy (§3.1).
say "Artifact Registry cleanup for function images"
if gcloud artifacts repositories describe gcf-artifacts \
     --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud artifacts repositories set-cleanup-policies gcf-artifacts \
    --location="${REGION}" --project="${PROJECT_ID}" \
    --policy="$(dirname "$0")/artifact-registry-cleanup-policy.json" \
    --no-dry-run >/dev/null
  note "Applied."
else
  note "gcf-artifacts does not exist yet; re-run this script once to apply it."
fi

# ----------------------------------------------------------------------------
# Budget wiring
# ----------------------------------------------------------------------------

say "Pointing the budget at the topic"
BUDGET_ID="$(gcloud billing budgets list --billing-account="${BILLING_ACCOUNT}" \
  --filter="displayName=${BUDGET_NAME}" --format='value(name)' 2>/dev/null | head -1)"

if [[ -z "${BUDGET_ID}" ]]; then
  echo "  No budget named '${BUDGET_NAME}' on billing account ${BILLING_ACCOUNT}."
  echo "  Run ./infra/bootstrap-gcp.sh first — it creates the budget."
  exit 1
fi

gcloud billing budgets update "${BUDGET_ID}" \
  --notifications-rule-pubsub-topic="projects/${PROJECT_ID}/topics/${TOPIC}" >/dev/null
note "Budget ${BUDGET_NAME} now publishes to ${TOPIC}."

say "Done"
cat <<SUMMARY

  Deployed $([[ "${ARMED}" == "true" ]] && echo "ARMED" || echo "DISARMED").

  Next: rehearse it, which publishes a synthetic over-threshold message and
  shows you what the function did.

      PROJECT_ID=${PROJECT_ID} ./infra/rehearse-kill-switch.sh

  While disarmed that is completely safe — it logs an intent and changes
  nothing. Arm it only once you have seen that.

SUMMARY

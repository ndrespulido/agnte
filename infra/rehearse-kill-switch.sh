#!/usr/bin/env bash
#
# Rehearses the budget kill switch by publishing a synthetic over-threshold
# budget notification and showing what the function did.
#
# An untested kill switch is a guess, and the alternative way to test it is to
# genuinely overspend. This is the same argument the architecture doc makes
# about backups (§8.8): the one place being wrong is unrecoverable is the one
# place to rehearse.
#
# Safe while the function is disarmed: it logs an intent and changes nothing.
# Once armed, this REALLY DISABLES BILLING and asks before doing so.
#
# Usage:
#   PROJECT_ID=agnte-prod ./infra/rehearse-kill-switch.sh

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west3}"
TOPIC="agnte-budget-alerts"
FUNCTION="agnte-kill-switch"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

say "Checking how the function is deployed"
ARMED_NOW="$(gcloud functions describe "${FUNCTION}" --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --format='value(serviceConfig.environmentVariables.ARMED)' 2>/dev/null || true)"

if [[ -z "${ARMED_NOW}" ]]; then
  echo "  Could not read ${FUNCTION} in ${REGION}. Deploy it first:"
  echo "    PROJECT_ID=${PROJECT_ID} BILLING_ACCOUNT=... ./infra/deploy-kill-switch.sh"
  exit 1
fi

if [[ "${ARMED_NOW}" == "true" ]]; then
  cat <<'WARNING'

  ############################################################
  #  The kill switch is ARMED.                               #
  #                                                          #
  #  This will really disable billing for the project.       #
  #  Everything stops: Cloud Run, the function itself, the   #
  #  lot. Recovery is manual — docs/operations.md section 3. #
  #                                                          #
  #  Neon and R2 are outside GCP and keep your data.         #
  ############################################################

WARNING
  read -rp "  Type DISABLE BILLING to continue: " CONFIRM
  [[ "${CONFIRM}" == "DISABLE BILLING" ]] || { echo "  Aborted. Nothing published."; exit 1; }
else
  note "DISARMED — it will log what it would do and change nothing."
fi

# Mirrors the payload Cloud Billing publishes, with a cost above the budget so
# the 100% threshold is what is exercised. The lower alerts share this topic and
# must not trigger the switch; tests/unit/kill-switch.test.ts covers that.
PAYLOAD=$(cat <<'JSON'
{"budgetDisplayName":"REHEARSAL — synthetic message, not a real budget alert",
 "alertThresholdExceeded":1.0,
 "costAmount":999.99,
 "costIntervalStart":"2026-01-01T00:00:00Z",
 "budgetAmount":30.0,
 "budgetAmountType":"SPECIFIED_AMOUNT",
 "currencyCode":"EUR"}
JSON
)

say "Publishing the synthetic notification"
PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
gcloud pubsub topics publish "${TOPIC}" --project="${PROJECT_ID}" \
  --message="${PAYLOAD}" >/dev/null
note "Published at ${PUBLISHED_AT}."

say "Waiting for the function to run"
sleep 25

say "What it logged"
gcloud logging read \
  "resource.type=cloud_run_revision AND resource.labels.service_name=${FUNCTION} AND timestamp>=\"${PUBLISHED_AT}\" AND textPayload:kill-switch" \
  --project="${PROJECT_ID}" --limit=10 --format='value(textPayload)' --order=asc \
  || note "No log lines yet — logs can lag. Re-read them with:"

cat <<NEXT

  If nothing appeared, wait a few seconds and read the logs directly:

      gcloud functions logs read ${FUNCTION} --region=${REGION} \\
        --project=${PROJECT_ID} --limit=20

  Expected while disarmed:
      kill-switch: WOULD DISABLE BILLING for ${PROJECT_ID} — budget exceeded ...

  Expected once armed:
      kill-switch: DISABLING BILLING for ${PROJECT_ID} — budget exceeded ...
      kill-switch: billing DISABLED ...

NEXT

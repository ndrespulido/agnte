#!/usr/bin/env bash
#
# Reports the actual state of the kill switch wiring.
#
# Written after two failed guesses at why the Eventarc trigger could not invoke
# the function. The identities involved are not visible from the function's own
# configuration, so this prints all of them side by side and says which one is
# wrong.
#
# Read-only. Usage:
#   PROJECT_ID=agnte-prod ./infra/diagnose-kill-switch.sh

set -uo pipefail   # deliberately not -e: report everything, even when a step fails

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-europe-west3}"
FUNCTION="agnte-kill-switch"
KILL_EMAIL="agnte-kill-switch@${PROJECT_ID}.iam.gserviceaccount.com"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

say "Function"
gcloud functions describe "${FUNCTION}" --region="${REGION}" --project="${PROJECT_ID}" \
  --format='value[separator="
"](
  "runs as:        " + serviceConfig.serviceAccountEmail,
  "ARMED:          " + serviceConfig.environmentVariables.ARMED,
  "state:          " + state
)' 2>&1 | sed 's/^/    /'

say "Eventarc trigger (the identity that invokes the function)"
TRIGGER_SA="$(gcloud eventarc triggers list --location="${REGION}" --project="${PROJECT_ID}" \
  --format='value(serviceAccount)' 2>/dev/null | head -1)"
TRIGGER_NAME="$(gcloud eventarc triggers list --location="${REGION}" --project="${PROJECT_ID}" \
  --format='value(name)' 2>/dev/null | head -1)"

if [[ -z "${TRIGGER_NAME}" ]]; then
  note "No Eventarc trigger found. The function has nothing wired to it."
else
  note "trigger:        ${TRIGGER_NAME}"
  note "invokes as:     ${TRIGGER_SA:-<unset — defaults to the compute service account>}"
fi

say "Who may invoke the function's Cloud Run service"
gcloud run services get-iam-policy "${FUNCTION}" --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --flatten='bindings[].members' \
  --filter='bindings.role=roles/run.invoker' \
  --format='value(bindings.members)' 2>&1 | sed 's/^/    /' \
  || note "Could not read the policy."

say "Verdict"
INVOKERS="$(gcloud run services get-iam-policy "${FUNCTION}" --region="${REGION}" \
  --project="${PROJECT_ID}" --flatten='bindings[].members' \
  --filter='bindings.role=roles/run.invoker' \
  --format='value(bindings.members)' 2>/dev/null)"

if [[ -z "${TRIGGER_SA}" ]]; then
  note "The trigger has no explicit identity, so it invokes as the default"
  note "compute service account — which does not exist here, because the"
  note "Compute API is deliberately disabled (architecture.md §3.1)."
  note ""
  note "A function redeploy does not change an existing trigger's identity."
  note "Update the trigger in place:"
  note ""
  note "  gcloud eventarc triggers update ${TRIGGER_NAME:-<trigger>} \\"
  note "    --location=${REGION} --project=${PROJECT_ID} \\"
  note "    --service-account=${KILL_EMAIL}"
elif ! grep -q "${TRIGGER_SA}" <<<"${INVOKERS}"; then
  note "The trigger invokes as ${TRIGGER_SA}, which is NOT in the invoker list."
  note "Grant it:"
  note ""
  note "  gcloud run services add-iam-policy-binding ${FUNCTION} \\"
  note "    --region=${REGION} --project=${PROJECT_ID} \\"
  note "    --member=serviceAccount:${TRIGGER_SA} --role=roles/run.invoker"
else
  note "Trigger identity and invoker permission agree."
  note "If invocations still fail, the binding may not have propagated yet —"
  note "IAM changes can take a couple of minutes. Rehearse again before"
  note "looking further."
fi

say "Recent invocation attempts"
gcloud functions logs read "${FUNCTION}" --region="${REGION}" \
  --project="${PROJECT_ID}" --limit=10 2>&1 | tail -12 | sed 's/^/    /'

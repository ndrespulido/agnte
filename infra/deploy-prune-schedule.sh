#!/usr/bin/env bash
#
# Schedules the daily retention sweep (architecture.md §1.3, §8.7).
#
# Seven pruners existed and were tested long before anything called them —
# expired idempotency keys, rate-limit windows, refresh tokens, password reset
# tokens, pending registrations (each holding a password hash), OAuth handoffs
# and abandoned uploads. This is the caller: Cloud Scheduler POSTs
# /internal/prune once a day.
#
# A scheduled HTTP call rather than a Cloud Run Job, unlike the backup: the
# work is seven DELETEs that finish in milliseconds, so it fits a request
# comfortably and needs none of the Job machinery.
#
#   PROJECT_ID=agnte-prod ./infra/deploy-prune-schedule.sh
#
# Safe to re-run: the schedule is updated in place if it already exists.
# Run it after the service has been deployed at least once — the scheduler
# needs a URL to call.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-europe-west3}"
SERVICE="${SERVICE:-agnte}"
JOB="${JOB:-agnte-prune-daily}"

# 04:40 UTC. Off the hour and off the backup's 03:17, so the two never
# contend for the same free-tier database at the same moment.
SCHEDULE="${SCHEDULE:-40 4 * * *}"

bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }

RUNTIME_SA="${RUNTIME_SA:-agnte-runtime@${PROJECT_ID}.iam.gserviceaccount.com}"

# ----------------------------------------------------------------------------
# Preflight
# ----------------------------------------------------------------------------
bold "Checking prerequisites"

gcloud services enable cloudscheduler.googleapis.com --project="${PROJECT_ID}" >/dev/null
note "cloudscheduler API enabled"

if ! gcloud secrets describe agnte-internal-tasks-secret --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  Missing secret: agnte-internal-tasks-secret"
  echo "  Run: PROJECT_ID=${PROJECT_ID} ./infra/set-secrets.sh"
  exit 1
fi

SERVICE_URL=$(gcloud run services describe "${SERVICE}" \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --format='value(status.url)' 2>/dev/null || true)

if [[ -z "${SERVICE_URL}" ]]; then
  echo "  The ${SERVICE} service does not exist yet in ${REGION}."
  echo "  Deploy it once (push to main), then run this again."
  exit 1
fi
note "target ${SERVICE_URL}/internal/prune"

# ----------------------------------------------------------------------------
# Schedule
#
# The shared secret travels as a header on the scheduled request, the same one
# Cloud Tasks sends on a thumbnail callback (shared/infra/internal-auth.ts).
#
# Not OIDC, which is the more usual answer for Scheduler → Cloud Run: this
# service runs --allow-unauthenticated so a preview URL opens without a Google
# account, which means Cloud Run's own IAM cannot gate /internal/* and an OIDC
# token would have to be verified in application code we deliberately do not
# have.
#
# The consequence, stated so it is not a surprise: rotating
# agnte-internal-tasks-secret means re-running this script, or the daily sweep
# starts answering 401. Nothing else breaks, and the sweep is idempotent — the
# next successful run clears whatever the failed ones did not.
# ----------------------------------------------------------------------------
bold "Scheduling the daily sweep"

SECRET_VALUE=$(gcloud secrets versions access latest \
  --secret=agnte-internal-tasks-secret --project="${PROJECT_ID}")

FLAGS=(
  --location="${REGION}"
  --schedule="${SCHEDULE}"
  --time-zone="UTC"
  --uri="${SERVICE_URL}/internal/prune"
  --http-method=POST
  --headers="Authorization=Bearer ${SECRET_VALUE}"
  # One a day, and a failure is not urgent — the next run sweeps whatever this
  # one missed. Three attempts is enough to ride out a cold start.
  --max-retry-attempts=3
  --attempt-deadline=60s
  --project="${PROJECT_ID}"
)

if gcloud scheduler jobs describe "${JOB}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB}" "${FLAGS[@]}" --quiet >/dev/null
  note "updated: ${SCHEDULE} UTC"
else
  gcloud scheduler jobs create http "${JOB}" "${FLAGS[@]}" --quiet >/dev/null
  note "created: ${SCHEDULE} UTC"
fi

# The runtime account is named for consistency with the backup job's grant,
# but nothing here needs it: the request carries a bearer secret and the
# service is public, so Scheduler calls it as nobody in particular.
note "auth: shared secret header (not OIDC — see the comment above)"

bold "Done"
cat <<DONE

    Run it now, without waiting for tomorrow:

      gcloud scheduler jobs run ${JOB} --location=${REGION} --project=${PROJECT_ID}

    Then read what it swept:

      gcloud run services logs read ${SERVICE} --region=${REGION} \\
        --project=${PROJECT_ID} | grep internal/prune

DONE

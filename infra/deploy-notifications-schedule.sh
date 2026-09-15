#!/usr/bin/env bash
#
# Schedules the reminder tick (architecture.md §8.4).
#
# Cloud Scheduler POSTs /internal/notifications/tick every five minutes; the
# dispatcher claims due reminders with FOR UPDATE SKIP LOCKED and sends them,
# which is what makes two instances ticking at once safe without a broker.
#
# A scheduled HTTP call rather than a Cloud Run Job, like the retention sweep
# and unlike the backup: a tick is a bounded batch of sends that fits a request
# comfortably, and needs none of the Job machinery.
#
#   PROJECT_ID=agnte-prod ./infra/deploy-notifications-schedule.sh
#
# Note what this costs, because §3.1 calls cost discipline non-negotiable and
# "€0 idle" stops being literally true the moment this exists: 288 wake-ups a
# day, so the service never sleeps longer than five minutes. That stays inside
# Cloud Run's free tier by a wide margin — the tick is a single indexed query
# when nothing is due — but it is a real change to the idle profile and should
# be a deliberate one.
#
# Safe to re-run: the schedule is updated in place if it already exists.
# Run it after the service has been deployed at least once — the scheduler
# needs a URL to call.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-europe-west3}"
SERVICE="${SERVICE:-agnte}"
JOB="${JOB:-agnte-notifications-tick}"

# Every five minutes, which is the resolution §8.4 specifies. A reminder is
# therefore accurate to within five minutes of its fire time, which is the
# right trade for a personal reminder and the reason the dispatcher does not
# need per-second precision anywhere.
SCHEDULE="${SCHEDULE:-*/5 * * * *}"

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
note "target ${SERVICE_URL}/internal/notifications/tick"

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
# agnte-internal-tasks-secret means re-running this script, or the tick
# starts answering 401. Nothing else breaks for long: a reminder the tick could
# not claim is still pending, so the next successful tick sends it — late by
# however long the 401s lasted, which is the one cost worth knowing about.
# ----------------------------------------------------------------------------
bold "Scheduling the reminder tick"

SECRET_VALUE=$(gcloud secrets versions access latest \
  --secret=agnte-internal-tasks-secret --project="${PROJECT_ID}")

# gcloud echoes its entire argument list back when it rejects a flag, and one
# of those arguments is the shared secret. That is how the secret ended up in
# a terminal the first time this script's update path was wrong — a usage
# error, not a breach, but the value was just as exposed either way.
#
# So the scheduler calls go through here: stderr is captured rather than
# inherited, and the secret is replaced before anything is printed. There is
# no --headers-from-file on `gcloud scheduler`, so passing it in argv is
# unavoidable; keeping it out of the *output* is not.
run_redacted() {
  local err
  if ! err=$("$@" 2>&1 >/dev/null); then
    printf '%s\n' "${err//${SECRET_VALUE}/<redacted>}" >&2
    exit 1
  fi
}

FLAGS=(
  --location="${REGION}"
  --schedule="${SCHEDULE}"
  --time-zone="UTC"
  --uri="${SERVICE_URL}/internal/notifications/tick"
  --http-method=POST
  # A failed tick is not urgent: the reminders it would have claimed are still
  # pending and the next tick is five minutes away, so retrying hard would only
  # pile attempts on top of a service that is already struggling. Three is
  # enough to ride out a cold start.
  --max-retry-attempts=3
  # Longer than the sweep's: a tick may send up to MAX_PER_TICK reminders, and
  # each one is an outbound email.
  --attempt-deadline=180s
  --project="${PROJECT_ID}"
)

# The header flag is spelled differently on the two subcommands, and the
# difference is not cosmetic: `create http` takes --headers, while
# `update http` rejects it outright and wants --update-headers (it also has
# --remove-headers and --clear-headers, which is why it cannot reuse the
# plain name — "set these" and "merge these in" are different operations).
#
# Found the hard way: this script worked the first time and failed every time
# after, because the first run created the job and every later run updated it.
# A bug that only appears on the second invocation is exactly the kind a
# re-runnable script has to be tested against twice.
if gcloud scheduler jobs describe "${JOB}" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  run_redacted gcloud scheduler jobs update http "${JOB}" "${FLAGS[@]}" \
    --update-headers="Authorization=Bearer ${SECRET_VALUE}" --quiet
  note "updated: ${SCHEDULE} UTC"
else
  run_redacted gcloud scheduler jobs create http "${JOB}" "${FLAGS[@]}" \
    --headers="Authorization=Bearer ${SECRET_VALUE}" --quiet
  note "created: ${SCHEDULE} UTC"
fi

# The runtime account is named for consistency with the backup job's grant,
# but nothing here needs it: the request carries a bearer secret and the
# service is public, so Scheduler calls it as nobody in particular.
note "auth: shared secret header (not OIDC — see the comment above)"

bold "Done"
cat <<DONE

    Run it now, without waiting five minutes:

      gcloud scheduler jobs run ${JOB} --location=${REGION} --project=${PROJECT_ID}

    Then read what it swept:

      gcloud run services logs read ${SERVICE} --region=${REGION} \\
        --project=${PROJECT_ID} | grep internal/notifications

DONE

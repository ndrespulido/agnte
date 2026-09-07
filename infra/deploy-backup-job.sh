#!/usr/bin/env bash
#
# Deploys the nightly backup (architecture.md §8.8) as a Cloud Run Job plus a
# Cloud Scheduler trigger.
#
# A Job rather than a route in the web service: a dump can outlive the service's
# 60s request timeout as the database grows, and a Job has no such limit. It also
# keeps pg_dump out of the web image, which is pulled on every cold start.
#
# Cost: a Job costs nothing until it runs, Cloud Scheduler's free tier covers
# three jobs, and R2 has no egress fees — so this stays inside the §3.1 target.
#
#   PROJECT_ID=agnte-prod ./infra/deploy-backup-job.sh
#
# Safe to re-run: every step checks before it creates.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID}"
REGION="${REGION:-europe-west3}"
JOB="${JOB:-agnte-backup}"
SCHEDULE="${SCHEDULE:-17 3 * * *}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
REPO="${REPO:-agnte}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${JOB}:latest"

bold() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
note() { printf '    %s\n' "$1"; }

RUNTIME_SA="${RUNTIME_SA:-agnte-runtime@${PROJECT_ID}.iam.gserviceaccount.com}"

# ----------------------------------------------------------------------------
# Preflight
#
# Every secret this job reads must exist first. Creating the job against a
# missing secret produces a deployment that only fails at 3am on the first run,
# which is the worst possible time to find out.
# ----------------------------------------------------------------------------
bold "Checking prerequisites"

for secret in agnte-direct-url agnte-r2-endpoint agnte-r2-bucket \
              agnte-r2-access-key-id agnte-r2-secret-access-key; do
  if ! gcloud secrets describe "${secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "  Missing secret: ${secret}"
    echo "  Run: PROJECT_ID=${PROJECT_ID} ./infra/set-secrets.sh"
    exit 1
  fi
  note "${secret}: present"
done

# The dump needs the *direct* URL, which until now only CI read. pg_dump holds
# one session across many statements; PgBouncer's transaction pooling breaks it.
bold "Granting the runtime account the direct URL"
gcloud secrets add-iam-policy-binding agnte-direct-url \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor \
  --project="${PROJECT_ID}" --quiet >/dev/null
note "runtime -> agnte-direct-url"

bold "Building the backup image"
# infra/backup as the context, not the repository root: three files instead of
# a gigabyte, and it sidesteps the root .dockerignore, which excludes `infra`
# for the web image's benefit.
gcloud builds submit --project="${PROJECT_ID}" --region="${REGION}" \
  --tag="${IMAGE}" --file=infra/backup/Dockerfile infra/backup \
  || {
    echo
    echo "  Cloud Build failed. If it reports the API is not enabled:"
    echo "    gcloud services enable cloudbuild.googleapis.com --project=${PROJECT_ID}"
    exit 1
  }

bold "Creating the job"
JOB_FLAGS=(
  --image="${IMAGE}"
  --region="${REGION}"
  --service-account="${RUNTIME_SA}"
  # One attempt beyond the first. A dump that fails twice is a real problem, and
  # retrying a third time mostly burns money on a database that is not answering.
  --max-retries=1
  # Generous, because a restore-shaped workload should never be killed halfway.
  # It costs nothing unless it is used.
  --task-timeout=30m
  # The dump is written to /tmp, which on Cloud Run is memory. This is the one
  # number to raise when the database outgrows it — and the size check in
  # backup.mjs is what will make that obvious rather than mysterious.
  --memory=1Gi
  --set-env-vars="BACKUP_RETENTION_DAYS=${RETENTION_DAYS},BACKUP_PREFIX=backups/"
  --set-secrets=DIRECT_URL=agnte-direct-url:latest,R2_ENDPOINT=agnte-r2-endpoint:latest,R2_BUCKET=agnte-r2-bucket:latest,R2_ACCESS_KEY_ID=agnte-r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=agnte-r2-secret-access-key:latest
)

if gcloud run jobs describe "${JOB}" --region="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud run jobs update "${JOB}" --project="${PROJECT_ID}" "${JOB_FLAGS[@]}" >/dev/null
  note "updated ${JOB}"
else
  gcloud run jobs create "${JOB}" --project="${PROJECT_ID}" "${JOB_FLAGS[@]}" >/dev/null
  note "created ${JOB}"
fi

# ----------------------------------------------------------------------------
# Scheduler
#
# The scheduler needs its own identity with permission to run the job. Left
# unset it falls back to the default compute service account, which does not
# exist here — the Compute API is deliberately disabled so a NAT gateway cannot
# be created (§3.1). Exactly the trap the kill switch hit in task 0.6.
# ----------------------------------------------------------------------------
bold "Granting the scheduler permission to run it"
gcloud run jobs add-iam-policy-binding "${JOB}" \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/run.invoker --quiet >/dev/null
note "runtime -> run.invoker on ${JOB}"

bold "Scheduling it"
JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB}:run"
SCHEDULER_FLAGS=(
  --location="${REGION}"
  --schedule="${SCHEDULE}"
  --time-zone="UTC"
  --uri="${JOB_URI}"
  --http-method=POST
  --oauth-service-account-email="${RUNTIME_SA}"
  --project="${PROJECT_ID}"
)

if gcloud scheduler jobs describe "${JOB}-nightly" --location="${REGION}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB}-nightly" "${SCHEDULER_FLAGS[@]}" --quiet >/dev/null
  note "updated schedule: ${SCHEDULE} UTC"
else
  gcloud scheduler jobs create http "${JOB}-nightly" "${SCHEDULER_FLAGS[@]}" --quiet >/dev/null
  note "created schedule: ${SCHEDULE} UTC"
fi

bold "Done"
cat <<DONE

  Run it once now rather than waiting for tonight — an untested backup is a
  guess (§8.8), and the first run is where a missing permission shows up:

    gcloud run jobs execute ${JOB} --region=${REGION} --project=${PROJECT_ID} --wait

  Then rehearse a restore. That needs a scratch database to restore into; a
  Neon branch is the cheap way to get one:

    SCRATCH_URL=<a throwaway Neon branch URL> \\
      node infra/backup/verify-restore.mjs

DONE

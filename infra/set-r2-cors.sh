#!/usr/bin/env bash
#
# Configures R2 to accept the browser's presigned upload (architecture.md
# §8.3) from the app's own origins. Without this the browser blocks the
# upload before it leaves: "blocked by CORS policy ... No
# 'Access-Control-Allow-Origin' header is present."
#
# One-time, like bootstrap-gcp.sh and set-secrets.sh — not per-deploy. Safe
# to re-run any time an origin changes (a custom domain, a new region): it
# replaces the whole rule rather than adding to it.
#
# Usage:
#   PROJECT_ID=agnte-prod ./infra/set-r2-cors.sh
#
# Prerequisites: gcloud installed and `gcloud auth login` done, R2 already
# configured via ./infra/set-secrets.sh, and node with `npm install` run in
# this repository.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${GCP_REGION:-europe-west3}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

if ! command -v node >/dev/null || [[ ! -d "$(dirname "$0")/../node_modules/@aws-sdk" ]]; then
  echo "  Needs node and \`npm install\` in this repository."
  exit 1
fi

say "Reading R2 credentials from Secret Manager"
for name in agnte-r2-endpoint agnte-r2-bucket agnte-r2-access-key-id agnte-r2-secret-access-key; do
  if ! gcloud secrets describe "${name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "  Secret ${name} does not exist yet. Run ./infra/set-secrets.sh first."
    exit 1
  fi
done
R2_ENDPOINT="$(gcloud secrets versions access latest --secret=agnte-r2-endpoint --project="${PROJECT_ID}")"
R2_BUCKET="$(gcloud secrets versions access latest --secret=agnte-r2-bucket --project="${PROJECT_ID}")"
R2_ACCESS_KEY_ID="$(gcloud secrets versions access latest --secret=agnte-r2-access-key-id --project="${PROJECT_ID}")"
R2_SECRET_ACCESS_KEY="$(gcloud secrets versions access latest --secret=agnte-r2-secret-access-key --project="${PROJECT_ID}")"

say "Finding the app's own origins"
PROD_URL="$(gcloud run services describe agnte \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --format='value(status.url)' 2>/dev/null || true)"
if [[ -n "${PROD_URL}" ]]; then
  note "Production: ${PROD_URL}"
else
  note "Production service does not exist yet — skipping."
fi

PREVIEW_URL="$(gcloud run services describe agnte-preview \
  --region="${REGION}" --project="${PROJECT_ID}" \
  --format='value(status.url)' 2>/dev/null || true)"
if [[ -n "${PREVIEW_URL}" ]]; then
  note "Preview, every pull request: ${PREVIEW_URL/https:\/\//https:\/\/*---}"
else
  note "Preview service does not exist yet — skipping."
fi

if [[ -z "${PROD_URL}" && -z "${PREVIEW_URL}" ]]; then
  echo "  Neither service has been deployed yet. Deploy at least one first."
  exit 1
fi

say "Setting the CORS rule on ${R2_BUCKET}"
R2_ENDPOINT="${R2_ENDPOINT}" R2_BUCKET="${R2_BUCKET}" \
  R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
  PROD_URL="${PROD_URL}" PREVIEW_URL="${PREVIEW_URL}" \
  node "$(dirname "$0")/set-r2-cors.mjs"

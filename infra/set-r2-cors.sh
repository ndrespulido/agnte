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
#   Once a custom domain fronts the service (docs/operations.md §2k), add it
#   too — Cloud Run's own URL stays reachable, but the browser's Origin on a
#   presigned upload is whatever the person actually loaded the app from:
#   PROJECT_ID=agnte-prod APP_BASE_URL=https://agnte.app ./infra/set-r2-cors.sh
#
# Prerequisites: gcloud installed and `gcloud auth login` done, R2 already
# configured via ./infra/set-secrets.sh, node with `npm install` run in this
# repository, and a *separate*, Admin-scoped R2 API token — see below.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
REGION="${GCP_REGION:-europe-west3}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

if ! command -v node >/dev/null || [[ ! -d "$(dirname "$0")/../node_modules/@aws-sdk" ]]; then
  echo "  Needs node and \`npm install\` in this repository."
  exit 1
fi

say "Reading the bucket's endpoint and name from Secret Manager"
for name in agnte-r2-endpoint agnte-r2-bucket; do
  if ! gcloud secrets describe "${name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "  Secret ${name} does not exist yet. Run ./infra/set-secrets.sh first."
    exit 1
  fi
done
R2_ENDPOINT="$(gcloud secrets versions access latest --secret=agnte-r2-endpoint --project="${PROJECT_ID}")"
R2_BUCKET="$(gcloud secrets versions access latest --secret=agnte-r2-bucket --project="${PROJECT_ID}")"

# ----------------------------------------------------------------------------
# Deliberately NOT agnte-r2-access-key-id / agnte-r2-secret-access-key.
#
# Those are scoped Object Read & Write (docs/operations.md §2b) — enough for
# the app to put and get objects, and nothing more. `PutBucketCors` is a
# bucket-*configuration* operation, which R2 reserves for an Admin-scoped
# token; an Object-scoped one answers it with AccessDenied. That scoping is
# not a bug to route around: production's stored credential should not be
# able to change what the bucket accepts requests from, so this asks for a
# separate token instead of asking Secret Manager to hold a wider one.
# ----------------------------------------------------------------------------

cat <<'EXPLAIN'

Setting a bucket's CORS policy needs an Admin-scoped R2 API token —
Object Read & Write (what production runs with) is not enough, and R2 will
say AccessDenied rather than silently doing nothing.

From the Cloudflare dashboard: R2 -> Manage API tokens -> Create token ->
Admin Read & Write, scoped to this bucket if the "Apply to specific
buckets only" option is offered. This is used once, for this run only,
and is never written to Secret Manager or anywhere on disk — revoke it
afterward if you like; CORS is not something this needs to change often.

EXPLAIN

read -rp "  Admin-scoped R2 access key ID:   " R2_ADMIN_ACCESS_KEY_ID
read -rsp "  Admin-scoped R2 secret key:      " R2_ADMIN_SECRET_ACCESS_KEY
echo
[[ -n "${R2_ADMIN_ACCESS_KEY_ID}" && -n "${R2_ADMIN_SECRET_ACCESS_KEY}" ]] \
  || { echo "  Both values are required."; exit 1; }

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

if [[ -n "${APP_BASE_URL:-}" ]]; then
  note "Custom domain: ${APP_BASE_URL}"
fi

if [[ -z "${PROD_URL}" && -z "${PREVIEW_URL}" && -z "${APP_BASE_URL:-}" ]]; then
  echo "  Neither service has been deployed yet. Deploy at least one first."
  exit 1
fi

say "Setting the CORS rule on ${R2_BUCKET}"
if ! R2_ENDPOINT="${R2_ENDPOINT}" R2_BUCKET="${R2_BUCKET}" \
  R2_ACCESS_KEY_ID="${R2_ADMIN_ACCESS_KEY_ID}" R2_SECRET_ACCESS_KEY="${R2_ADMIN_SECRET_ACCESS_KEY}" \
  PROD_URL="${PROD_URL}" PREVIEW_URL="${PREVIEW_URL}" CUSTOM_DOMAIN="${APP_BASE_URL:-}" \
  node "$(dirname "$0")/set-r2-cors.mjs"; then
  echo
  echo "  If that said AccessDenied, the token above is not Admin-scoped —"
  echo "  Object Read & Write cannot set a bucket's CORS policy."
  exit 1
fi

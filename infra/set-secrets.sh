#!/usr/bin/env bash
#
# Stores the Neon connection strings in Google Secret Manager and grants each
# service account access to only the secret it needs.
#
# The URLs are read from the terminal, never passed as arguments: an argument
# lands in shell history and in the process table, where a connection string
# with an embedded password does not belong.
#
# Usage:
#   PROJECT_ID=agnte-prod ./infra/set-secrets.sh

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
RUNTIME_SA="agnte-runtime@${PROJECT_ID}.iam.gserviceaccount.com"
DEPLOYER_SA="agnte-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# ----------------------------------------------------------------------------
# Collect
# ----------------------------------------------------------------------------

cat <<'EXPLAIN'

Neon gives two connection strings for the same database. Both are needed, and
using the wrong one for the wrong job is a slow bug to find:

  pooled  - host contains "-pooler". Used by the application. Cloud Run can
            start several instances; without the pooler they exhaust Postgres
            connections.

  direct  - no "-pooler". Used only by the migration engine, which takes
            advisory locks and runs DDL in a session. PgBouncer's transaction
            pooling breaks both.

In the Neon console, the "Connection pooling" toggle on the connection widget
switches between them.

EXPLAIN

read -rsp "  Pooled connection string (DATABASE_URL): " DATABASE_URL; echo
[[ -n "${DATABASE_URL}" ]] || { echo "  Required — nothing was entered."; exit 1; }

if [[ "${DATABASE_URL}" != *"-pooler"* ]]; then
  echo
  echo "  That string has no '-pooler' in its host, so it is the direct URL,"
  echo "  not the pooled one. In the Neon console the connection widget has a"
  echo "  pooled/direct switch; the pooled host looks like:"
  echo "      ep-something-1234-pooler.<region>.aws.neon.tech"
  exit 1
fi

# The pooler is a separate hostname for the same database, so the direct URL is
# the pooled one without "-pooler". Deriving it rather than asking twice removes
# the commonest failure here: pasting the same string into both prompts, which
# silently breaks migrations later rather than failing now.
DERIVED_DIRECT="${DATABASE_URL/-pooler/}"

# Show the hosts to confirm, with credentials masked — the point is to check the
# hostnames differ in exactly the expected way, not to display the secret.
mask_url() { sed -E 's#(://[^:]*:)[^@]*(@)#\1********\2#' <<<"$1"; }

echo
echo "  Pooled (application):  $(mask_url "${DATABASE_URL}")"
echo "  Direct (migrations):   $(mask_url "${DERIVED_DIRECT}")"
echo
read -rsp "  Press Enter to accept, or paste a different direct URL: " DIRECT_OVERRIDE; echo
DIRECT_URL="${DIRECT_OVERRIDE:-${DERIVED_DIRECT}}"

if [[ "${DIRECT_URL}" == *"-pooler"* ]]; then
  echo
  echo "  The direct URL still contains '-pooler'. Migrations against the pooler"
  echo "  fail in ways that look like corruption rather than a wrong URL."
  exit 1
fi

# ----------------------------------------------------------------------------
# Store
#
# A new version is added rather than the secret replaced, so a rotation is
# revertible and Cloud Run's ":latest" reference picks it up on next deploy.
# ----------------------------------------------------------------------------

store() {
  local name="$1" value="$2"
  if gcloud secrets describe "${name}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    printf '%s' "${value}" | gcloud secrets versions add "${name}" \
      --data-file=- --project="${PROJECT_ID}" >/dev/null
    note "${name}: new version added."
  else
    printf '%s' "${value}" | gcloud secrets create "${name}" \
      --data-file=- --replication-policy=automatic --project="${PROJECT_ID}" >/dev/null
    note "${name}: created."
  fi
}

# ----------------------------------------------------------------------------
# Cloudflare R2
#
# Optional so the database can be configured before the bucket exists. Skipping
# leaves any previously stored R2 secrets untouched.
# ----------------------------------------------------------------------------

cat <<'EXPLAIN'

Cloudflare R2 next. From the R2 dashboard:

  - the bucket name
  - an S3-compatible API token scoped to that bucket (Manage API tokens ->
    Create token, Object Read & Write, scoped to this bucket only), which gives
    an Access Key ID and a Secret Access Key
  - the S3 API endpoint shown on the bucket's settings page, of the form
    https://<account-id>.r2.cloudflarestorage.com
    (an EU-jurisdiction bucket has .eu. before r2, and that URL is the one to
    use — the jurisdiction is part of the endpoint, not a separate setting)

Press Enter at the endpoint prompt to skip R2 for now.

EXPLAIN

read -rp "  R2 S3 API endpoint: " R2_ENDPOINT

if [[ -n "${R2_ENDPOINT}" ]]; then
  read -rp "  R2 bucket name:     " R2_BUCKET
  read -rsp "  R2 access key ID:   " R2_ACCESS_KEY_ID; echo
  read -rsp "  R2 secret key:      " R2_SECRET_ACCESS_KEY; echo

  [[ -n "${R2_BUCKET}" && -n "${R2_ACCESS_KEY_ID}" && -n "${R2_SECRET_ACCESS_KEY}" ]] \
    || { echo "  All four R2 values are required once an endpoint is given."; exit 1; }

  if [[ "${R2_ENDPOINT}" != https://* ]]; then
    echo "  The endpoint must be an https:// URL."
    exit 1
  fi
  # The application rejects a partially configured R2 at boot; catching a
  # bucket name pasted into the endpoint slot here is cheaper than at deploy.
  if [[ "${R2_ENDPOINT}" != *"r2.cloudflarestorage.com"* ]]; then
    echo "  That does not look like an R2 S3 API endpoint."
    echo "  Expected something like https://<account-id>.r2.cloudflarestorage.com"
    exit 1
  fi
fi

say "Storing secrets"
store agnte-database-url "${DATABASE_URL}"
store agnte-direct-url "${DIRECT_URL}"

if [[ -n "${R2_ENDPOINT}" ]]; then
  store agnte-r2-endpoint "${R2_ENDPOINT}"
  store agnte-r2-bucket "${R2_BUCKET}"
  store agnte-r2-access-key-id "${R2_ACCESS_KEY_ID}"
  store agnte-r2-secret-access-key "${R2_SECRET_ACCESS_KEY}"
fi

# ----------------------------------------------------------------------------
# Grant
#
# Per secret, not project-wide: the runtime service account can read the pooled
# URL it needs and nothing else, so a new secret is never readable by accident.
# ----------------------------------------------------------------------------

say "Granting access"
gcloud secrets add-iam-policy-binding agnte-database-url \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor \
  --project="${PROJECT_ID}" --quiet >/dev/null
note "runtime  -> agnte-database-url (the application)"

gcloud secrets add-iam-policy-binding agnte-direct-url \
  --member="serviceAccount:${DEPLOYER_SA}" \
  --role=roles/secretmanager.secretAccessor \
  --project="${PROJECT_ID}" --quiet >/dev/null
note "deployer -> agnte-direct-url (migrations in CI)"

if [[ -n "${R2_ENDPOINT}" ]]; then
  for secret in agnte-r2-endpoint agnte-r2-bucket agnte-r2-access-key-id agnte-r2-secret-access-key; do
    gcloud secrets add-iam-policy-binding "${secret}" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role=roles/secretmanager.secretAccessor \
      --project="${PROJECT_ID}" --quiet >/dev/null
    note "runtime  -> ${secret}"
  done
fi

# ----------------------------------------------------------------------------
# Verify
#
# Granting and having-been-granted are different things: a binding can be
# written against the wrong secret, or the create can have failed earlier in a
# way that left nothing to bind to. Reading the policy back is what turns "the
# script ran" into "the deploy will work".
# ----------------------------------------------------------------------------

say "Verifying"
verify() {
  local secret="$1" member="$2" label="$3"
  if ! gcloud secrets describe "${secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "  ${secret} does not exist. Something above failed; re-run this script."
    exit 1
  fi
  if gcloud secrets get-iam-policy "${secret}" --project="${PROJECT_ID}" \
       --flatten='bindings[].members' \
       --filter="bindings.role=roles/secretmanager.secretAccessor AND bindings.members:${member}" \
       --format='value(bindings.members)' 2>/dev/null | grep -q .; then
    note "${secret}: ${label} can read it."
  else
    echo "  ${secret}: ${label} (${member}) is NOT bound as secretAccessor."
    echo "  The deploy will fail with PERMISSION_DENIED. Re-run this script."
    exit 1
  fi
}

verify agnte-database-url "${RUNTIME_SA}" "runtime"
verify agnte-direct-url "${DEPLOYER_SA}" "deployer"

if [[ -n "${R2_ENDPOINT}" ]]; then
  for secret in agnte-r2-endpoint agnte-r2-bucket agnte-r2-access-key-id agnte-r2-secret-access-key; do
    verify "${secret}" "${RUNTIME_SA}" "runtime"
  done
fi

say "Done"
cat <<'DONE'

  Nothing further to paste anywhere. CI reads the direct URL from Secret
  Manager using its own identity, and Cloud Run mounts the pooled URL at
  deploy time, so neither connection string is stored in GitHub.

DONE

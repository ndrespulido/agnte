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
read -rsp "  Direct connection string (DIRECT_URL):  " DIRECT_URL; echo

[[ -n "${DATABASE_URL}" && -n "${DIRECT_URL}" ]] || { echo "  Both are required."; exit 1; }

# Cheap guards against the commonest paste mistake — swapping them.
if [[ "${DATABASE_URL}" != *"-pooler"* ]]; then
  echo
  echo "  The pooled URL does not contain '-pooler'. Check you copied the"
  echo "  pooled one; using a direct URL from Cloud Run exhausts connections."
  exit 1
fi
if [[ "${DIRECT_URL}" == *"-pooler"* ]]; then
  echo
  echo "  The direct URL contains '-pooler'. Migrations against the pooler fail"
  echo "  in ways that look like corruption rather than a wrong URL."
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

say "Storing secrets"
store agnte-database-url "${DATABASE_URL}"
store agnte-direct-url "${DIRECT_URL}"

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

say "Done"
cat <<'DONE'

  Nothing further to paste anywhere. CI reads the direct URL from Secret
  Manager using its own identity, and Cloud Run mounts the pooled URL at
  deploy time, so neither connection string is stored in GitHub.

DONE

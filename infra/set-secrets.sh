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

Press Enter at the endpoint prompt to keep whatever is already stored.

EXPLAIN

# Show what is already there, so a re-run does not mean re-entering credentials
# that are working. This is the common case: the database or Resend needs
# changing and R2 does not.
if gcloud secrets versions access latest --secret=agnte-r2-endpoint \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "Already stored: $(gcloud secrets versions access latest --secret=agnte-r2-endpoint --project="${PROJECT_ID}" 2>/dev/null)"
  note "Press Enter to keep it."
fi

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

  # Prove the credentials work before storing them. The failure this catches is
  # a jurisdiction mismatch — an EU-created bucket is only reachable through the
  # ".eu." endpoint, and the default one answers NoSuchBucket, which reads like a
  # mistyped bucket name. Seconds here against a failed deploy later.
  say "Checking the R2 credentials"
  if command -v node >/dev/null && [[ -d node_modules/@aws-sdk ]]; then
    # A failure here used to abort the whole script, which discarded the
    # database URL, the Resend key and everything else already typed — for a
    # mistake in one of four values, on a re-run where R2 was probably fine
    # already. Now it offers to leave R2 alone and carry on, so one wrong paste
    # costs one section rather than the entire run.
    if ! R2_ENDPOINT="${R2_ENDPOINT}" R2_BUCKET="${R2_BUCKET}" \
      R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}" R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}" \
      node "$(dirname "$0")/verify-r2.mjs"; then
      echo
      echo "  Those R2 credentials were rejected, so they will not be stored."
      echo "  Most often that is the Access Key ID and Secret: the prompts are"
      echo "  hidden, and R2 shows the secret only once when the token is made."
      echo
      read -rp "  Continue without changing R2? [Y/n] " R2_CONTINUE
      if [[ "${R2_CONTINUE}" =~ ^[Nn] ]]; then
        exit 1
      fi
      # Cleared, so the store and grant steps below skip R2 entirely and leave
      # whatever is already in Secret Manager untouched.
      R2_ENDPOINT=""
      note "Leaving the stored R2 configuration as it is."
    fi
  else
    note "Skipped: needs node and \`npm install\` in this repository."
    note "The deploy's smoke test will catch a bad configuration instead."
  fi
fi

# ----------------------------------------------------------------------------
# Resend (architecture.md §3)
#
# Optional in exactly the same way R2 is: without it the app deploys, the status
# page reports email as not-configured, and POST /v1/auth/register answers 503
# rather than accepting a registration whose verification link it cannot send.
# ----------------------------------------------------------------------------

say "Resend (email)"
cat <<'EXPLAIN'

  From the Resend dashboard you need:

  - an API key (API Keys -> Create API Key, sending access is enough)
  - a From address on a domain you have verified there

  Until a domain is verified, Resend only delivers to the address that owns the
  Resend account, and only from onboarding@resend.dev. That is enough to test
  registration yourself, and not enough for anyone else — so verify a domain
  before inviting a second person.

Press Enter at the API key prompt to skip email for now.

EXPLAIN

read -rsp "  Resend API key:  " RESEND_API_KEY; echo

if [[ -n "${RESEND_API_KEY}" ]]; then
  read -rp "  From address:    " EMAIL_FROM

  [[ -n "${EMAIL_FROM}" ]] || { echo "  A From address is required once a key is given."; exit 1; }

  # The app rejects a half-configured transport at boot; catching a From address
  # pasted into the key slot here is cheaper than at deploy.
  if [[ "${RESEND_API_KEY}" != re_* ]]; then
    echo "  A Resend API key starts with \"re_\". That does not look like one."
    exit 1
  fi
  # Accepts both "a@b.com" and "Name <a@b.com>".
  if [[ "${EMAIL_FROM}" != *@*.* ]]; then
    echo "  The From address needs to contain an address, e.g."
    echo "  \"Agnte <no-reply@your-domain>\" or no-reply@your-domain"
    exit 1
  fi

  # Prove the key works before storing it, the same way the R2 credentials are
  # proved. A 401 here is seconds; the same 401 discovered at registration is a
  # person waiting for an email that will never arrive.
  say "Checking the Resend key"
  RESEND_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${RESEND_API_KEY}" \
    https://api.resend.com/domains || echo "000")
  case "${RESEND_STATUS}" in
    2*) note "Resend accepted the key." ;;
    401|403) echo "  Resend rejected that key (HTTP ${RESEND_STATUS})."; exit 1 ;;
    000) note "Could not reach Resend; storing the key unverified." ;;
    *)  note "Resend answered HTTP ${RESEND_STATUS}; storing the key unverified." ;;
  esac
fi

# ----------------------------------------------------------------------------
# Access token signing key (architecture.md §4)
#
# Generated rather than asked for: it is 32 random bytes, not something you go
# and fetch, and a prompt would only invite a memorable value. Created once and
# left alone on re-runs — replacing it signs every user out, so it must not be a
# side effect of running this script again for an unrelated reason.
# ----------------------------------------------------------------------------

say "Access token signing key"

if gcloud secrets describe agnte-jwt-secret --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "agnte-jwt-secret already exists; leaving it alone."
  note "To rotate deliberately (this signs everyone out):"
  note "  openssl rand -hex 32 | gcloud secrets versions add agnte-jwt-secret --data-file=-"
  JWT_SECRET=""
else
  JWT_SECRET="$(openssl rand -hex 32)"
  note "Generated a new 32-byte key."
fi

# ----------------------------------------------------------------------------
# Google OAuth (architecture.md §4)
#
# Optional like R2 and Resend. Production only, by necessity: Google does not
# accept wildcard redirect URIs, so a preview's per-pull-request URL cannot be
# registered in advance.
# ----------------------------------------------------------------------------

say "Google sign-in"
cat <<'EXPLAIN'

  From the Google Cloud console (APIs & Services -> Credentials):

  - Create an OAuth 2.0 Client ID of type "Web application"
  - Add this exact authorised redirect URI:

      <your production URL>/v1/auth/google/callback

  The URI must match byte for byte, including the scheme and any trailing path.
  Google rejects wildcards, so preview environments cannot use Google sign-in —
  they use email and password, and their status page says so.

Press Enter at the client ID prompt to skip Google sign-in for now.

EXPLAIN

read -rp "  Google client ID:     " GOOGLE_CLIENT_ID

if [[ -n "${GOOGLE_CLIENT_ID}" ]]; then
  read -rsp "  Google client secret: " GOOGLE_CLIENT_SECRET; echo

  [[ -n "${GOOGLE_CLIENT_SECRET}" ]] \
    || { echo "  A client secret is required once a client ID is given."; exit 1; }

  # A Google web client ID always ends this way. Catching a project id or an API
  # key pasted here is cheaper than a redirect_uri_mismatch at sign-in.
  if [[ "${GOOGLE_CLIENT_ID}" != *.apps.googleusercontent.com ]]; then
    echo "  A Google client ID ends with \".apps.googleusercontent.com\"."
    echo "  That looks like something else — check you copied the Client ID."
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

if [[ -n "${JWT_SECRET}" ]]; then
  store agnte-jwt-secret "${JWT_SECRET}"
fi

if [[ -n "${RESEND_API_KEY}" ]]; then
  store agnte-resend-api-key "${RESEND_API_KEY}"
  store agnte-email-from "${EMAIL_FROM}"
fi

if [[ -n "${GOOGLE_CLIENT_ID}" ]]; then
  store agnte-google-client-id "${GOOGLE_CLIENT_ID}"
  store agnte-google-client-secret "${GOOGLE_CLIENT_SECRET}"
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

# Unconditional: the secret exists by now either way — this run created it, or
# an earlier one did — and the binding is idempotent.
gcloud secrets add-iam-policy-binding agnte-jwt-secret \
  --member="serviceAccount:${RUNTIME_SA}" \
  --role=roles/secretmanager.secretAccessor \
  --project="${PROJECT_ID}" --quiet >/dev/null
note "runtime  -> agnte-jwt-secret"

# ----------------------------------------------------------------------------
# The deployer needs to *see* these, not read them.
#
# Both deploy workflows mount JWT, Resend and Google only once each secret
# exists, so that the code needing them can ship before they do. That check is
# `gcloud secrets describe`, and it runs as the deployer — which until now was
# granted nothing on them. The describe failed with PERMISSION_DENIED, the
# workflow read that as "not created yet", and skipped mounting a secret that
# was sitting right there. The status page then said not-configured, which is
# exactly what it says when the secret really is missing: the two failures were
# indistinguishable.
#
# `viewer`, not `secretAccessor`: the deploy passes secrets by reference and
# never reads a value — Cloud Run resolves them as the runtime account at start
# up. Knowing the secret exists is the whole requirement.
# ----------------------------------------------------------------------------
for secret in agnte-jwt-secret agnte-resend-api-key agnte-email-from \
              agnte-google-client-id agnte-google-client-secret; do
  if gcloud secrets describe "${secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    gcloud secrets add-iam-policy-binding "${secret}" \
      --member="serviceAccount:${DEPLOYER_SA}" \
      --role=roles/secretmanager.viewer \
      --project="${PROJECT_ID}" --quiet >/dev/null
    note "deployer -> ${secret} (viewer, so the workflow can see it exists)"
  fi
done

if [[ -n "${RESEND_API_KEY}" ]]; then
  for secret in agnte-resend-api-key agnte-email-from; do
    gcloud secrets add-iam-policy-binding "${secret}" \
      --member="serviceAccount:${RUNTIME_SA}" \
      --role=roles/secretmanager.secretAccessor \
      --project="${PROJECT_ID}" --quiet >/dev/null
    note "runtime  -> ${secret}"
  done
fi

if [[ -n "${GOOGLE_CLIENT_ID}" ]]; then
  for secret in agnte-google-client-id agnte-google-client-secret; do
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

verify agnte-jwt-secret "${RUNTIME_SA}" "runtime"

if [[ -n "${RESEND_API_KEY}" ]]; then
  for secret in agnte-resend-api-key agnte-email-from; do
    verify "${secret}" "${RUNTIME_SA}" "runtime"
  done
fi

if [[ -n "${GOOGLE_CLIENT_ID}" ]]; then
  for secret in agnte-google-client-id agnte-google-client-secret; do
    verify "${secret}" "${RUNTIME_SA}" "runtime"
  done
fi

say "Done"
cat <<'DONE'

  Nothing further to paste anywhere. CI reads the direct URL from Secret
  Manager using its own identity, and Cloud Run mounts the pooled URL at
  deploy time, so neither connection string is stored in GitHub.

DONE

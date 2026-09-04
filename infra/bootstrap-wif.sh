#!/usr/bin/env bash
#
# Workload Identity Federation: lets GitHub Actions authenticate to GCP with a
# short-lived token instead of a downloaded service account key.
#
# Run after infra/bootstrap-gcp.sh. Idempotent.
#
# Usage:
#   PROJECT_ID=agnte-prod GITHUB_REPO=ndrespulido/agnte ./infra/bootstrap-wif.sh

set -euo pipefail

PROJECT_ID="${PROJECT_ID:?set PROJECT_ID}"
GITHUB_REPO="${GITHUB_REPO:?set GITHUB_REPO, e.g. ndrespulido/agnte}"

POOL="${POOL:-github}"
PROVIDER="${PROVIDER:-github-provider}"
DEPLOYER_SA="agnte-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"

say "APIs"
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com \
  --project="${PROJECT_ID}"

say "Identity pool"
if gcloud iam workload-identity-pools describe "${POOL}" \
     --location=global --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "Already exists."
else
  gcloud iam workload-identity-pools create "${POOL}" \
    --location=global --display-name="GitHub Actions" --project="${PROJECT_ID}"
  note "Created."
fi

# ----------------------------------------------------------------------------
# The attribute condition is the security boundary.
#
# Without it, the provider trusts *any* GitHub Actions token from *any*
# repository on GitHub — anyone could create a public repo, run a workflow, and
# assume the deployer account. Pinning assertion.repository is what makes this
# safe, and it is the single most commonly skipped step in WIF setup guides.
# ----------------------------------------------------------------------------

say "Identity provider"
if gcloud iam workload-identity-pools providers describe "${PROVIDER}" \
     --workload-identity-pool="${POOL}" --location=global \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  note "Already exists — verifying its repository condition."
  CONDITION="$(gcloud iam workload-identity-pools providers describe "${PROVIDER}" \
    --workload-identity-pool="${POOL}" --location=global \
    --project="${PROJECT_ID}" --format='value(attributeCondition)')"
  if [[ "${CONDITION}" == *"${GITHUB_REPO}"* ]]; then
    note "Pinned to ${GITHUB_REPO}. Good."
  else
    echo
    echo "  WARNING: provider is not pinned to ${GITHUB_REPO}."
    echo "  Found condition: ${CONDITION:-<none>}"
    echo "  Fix it before using this provider — as written, other repositories"
    echo "  may be able to assume the deployer account."
    exit 1
  fi
else
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" \
    --location=global \
    --workload-identity-pool="${POOL}" \
    --display-name="GitHub Actions OIDC" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'" \
    --project="${PROJECT_ID}"
  note "Created, pinned to ${GITHUB_REPO}."
fi

say "Allow the repository to impersonate the deployer"
gcloud iam service-accounts add-iam-policy-binding "${DEPLOYER_SA}" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}" \
  --project="${PROJECT_ID}" --quiet >/dev/null
note "Bound."

say "Done — set these as GitHub Actions repository variables"
cat <<SUMMARY

  Settings -> Secrets and variables -> Actions -> Variables tab

    GCP_PROJECT_ID       ${PROJECT_ID}
    GCP_REGION           ${REGION:-europe-west3}
    GCP_WIF_PROVIDER     projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}
    GCP_DEPLOYER_SA      ${DEPLOYER_SA}
    GCP_RUNTIME_SA       agnte-runtime@${PROJECT_ID}.iam.gserviceaccount.com

  Variables, not secrets — none of this is confidential, and no key exists to
  leak. Access is granted to the repository itself, so it cannot be replayed
  from anywhere else.

SUMMARY

#!/usr/bin/env bash
#
# Put a free https://<site>.web.app hostname in front of the Cloud Run service.
#
# Run this only after scripts/deploy_cloudrun.sh has succeeded — Firebase
# Hosting rewrites to a Cloud Run service that must already exist.
#
#   firebase login          # once; separate from `gcloud auth login`
#   ./scripts/deploy_firebase.sh
#
# Ordering matters here. Firebase Hosting adds one hop to X-Forwarded-For, so
# Cloud Run needs NOCTURNE_PROXY_HOPS=1 to keep matching the real client — but
# setting that while no proxy is actually in front strips the client's own
# address and locks everyone out with a 403. So the Cloud Run change happens
# last, only once hosting is confirmed live, and rolls back if the check fails.

set -euo pipefail

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-nocturne-502617}"
# Must match the region deploy_cloudrun.sh used, and the region in firebase.json.
REGION="${REGION:-asia-southeast1}"
SERVICE="${SERVICE:-nocturne-console}"
SITE="${SITE:-nocturne}"

die() { echo "error: $*" >&2; exit 1; }

[[ -f firebase.json ]] || die "run this from nocturne_dashboard/"
command -v gcloud >/dev/null || die "gcloud not found"

# Prefer a globally installed CLI; fall back to npx so a fresh checkout still
# works. Both read the same credentials from ~/.config/configstore.
if command -v firebase >/dev/null; then
  FIREBASE=(firebase)
else
  FIREBASE=(npx --yes firebase-tools@latest)
fi

set_hops() {
  gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
    --update-env-vars "NOCTURNE_PROXY_HOPS=$1" >/dev/null
  echo "    NOCTURNE_PROXY_HOPS=$1"
}

# --- preflight: fail before touching anything ------------------------------
echo "==> checking Firebase CLI auth"
"${FIREBASE[@]}" projects:list >/dev/null 2>&1 \
  || die "Firebase CLI is not authenticated. Run:  firebase login
       (this is separate from gcloud auth — the CLI keeps its own credentials)"
echo "    authenticated"

echo "==> enabling Firebase APIs (no-op if already enabled)"
gcloud services enable firebase.googleapis.com firebasehosting.googleapis.com \
  --project "$PROJECT_ID" >/dev/null
"${FIREBASE[@]}" projects:addfirebase "$PROJECT_ID" >/dev/null 2>&1 \
  || echo "    already a Firebase project"

echo "==> claiming hosting site '$SITE'"
if "${FIREBASE[@]}" hosting:sites:create "$SITE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "    claimed ${SITE}.web.app"
else
  echo "    '${SITE}' already exists on this project, or is taken by someone else"
fi

echo "==> deploying hosting rewrite"
"${FIREBASE[@]}" deploy --only hosting --project "$PROJECT_ID"

# --- only now is a proxy actually in front ---------------------------------
echo "==> telling Cloud Run one proxy now sits in front of it"
set_hops 1

echo "==> verifying end to end"
sleep 5
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 45 "https://${SITE}.web.app/login" || echo 000)"
if [[ "$code" == "200" ]]; then
  echo "    https://${SITE}.web.app/login -> 200"
else
  echo "    https://${SITE}.web.app/login -> ${code}; rolling the hop count back" >&2
  set_hops 0
  die "hosting is deployed but the perimeter rejected the proxied request.
       Read the real chain with:
         gcloud run services logs read $SERVICE --region $REGION --project $PROJECT_ID | grep perimeter
       then set NOCTURNE_PROXY_HOPS to the number of trailing proxy hops."
fi

echo
echo "live: https://${SITE}.web.app"
echo "      https://${SITE}.firebaseapp.com"

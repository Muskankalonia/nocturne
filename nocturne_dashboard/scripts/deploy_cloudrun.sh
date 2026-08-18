#!/usr/bin/env bash
#
# Deploy the Nocturne Console to Cloud Run.
#
# Run this from nocturne_dashboard/ — the build context is this directory, and
# the Dockerfile beside it is the console's. The Dockerfile at the repo root
# belongs to the Python crawler.
#
#   ./scripts/deploy_cloudrun.sh
#
# Secrets are read from .env.local and pushed to Secret Manager. They are never
# printed, never passed on a command line where `ps` could see them, and never
# copied into the image (see .dockerignore).

set -euo pipefail

# `gcloud run deploy --source` stops to ask before creating the Artifact
# Registry repository on a first run, which hangs any non-interactive invocation.
# The prompts this script can raise are all benign resource creation.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-}"
# Snowflake for this account lives in AWS ap-southeast-1, so Cloud Run goes in
# GCP's Singapore region. Co-locating compute with the database beats
# co-locating it with the browser: the Snowflake handshake costs several round
# trips, the page load costs one.
REGION="${REGION:-asia-southeast1}"
SERVICE="${SERVICE:-nocturne-console}"
ENV_FILE="${ENV_FILE:-.env.local}"

# Comma-separated. Leave NOCTURNE_ALLOWED_IPS empty to open the service to any
# address; leave NOCTURNE_ALLOWED_HOSTS empty to accept any Host header.
ALLOWED_IPS="${ALLOWED_IPS:-}"
ALLOWED_HOSTS="${ALLOWED_HOSTS:-}"

# Trailing X-Forwarded-For hops added by a proxy in front of Cloud Run: 0 when
# reached directly, 1 once Firebase Hosting fronts it. Carried here as well as
# in deploy_firebase.sh because --set-env-vars below replaces the entire
# environment, so omitting it would silently undo the Firebase step.
PROXY_HOPS="${PROXY_HOPS:-0}"

# Absolute base for links inside alert emails. Must be the public hostname.
CONSOLE_URL="${CONSOLE_URL:-https://nocturne-console.web.app}"

# 0 means scale to nothing when idle, which is free but pays the ~4.3s Snowflake
# connect on every cold start. For the demo, opt in explicitly:
#
#   MIN_INSTANCES=1 ./scripts/deploy_cloudrun.sh
#
# One warm instance for a demo day sits inside the monthly free tier (180k
# vCPU-seconds); left on it exhausts that in roughly two days and starts
# billing. Put it back to 0 when you are done.
MIN_INSTANCES="${MIN_INSTANCES:-0}"

die() { echo "error: $*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud not found. Install the SDK or run this from Cloud Shell."
[[ -f Dockerfile ]] || die "run this from nocturne_dashboard/ (no Dockerfile here)"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found"

if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
fi
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "(unset)" ]] \
  || die "no project set. Use: PROJECT_ID=your-project ./scripts/deploy_cloudrun.sh"

echo "project=$PROJECT_ID region=$REGION service=$SERVICE"

# Read one KEY=VALUE out of the env file without sourcing it — sourcing would
# execute whatever happens to be in there.
read_env() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"//' -e 's/"$//'
}

require_env() {
  local key="$1" value
  value="$(read_env "$key")"
  [[ -n "$value" ]] || die "$key is missing from $ENV_FILE"
  printf '%s' "$value"
}

echo "==> enabling APIs (no-op if already enabled)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT_ID"

# --- secrets ---------------------------------------------------------------
# One Secret Manager secret per sensitive value. Adding a version each run means
# a rotated token is picked up by redeploying, and old versions stay available
# to roll back to. The free tier covers six active versions.
put_secret() {
  local name="$1" value="$2"
  if ! gcloud secrets describe "$name" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic --project "$PROJECT_ID"
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT_ID" >/dev/null
  echo "    $name updated"
}

echo "==> syncing secrets to Secret Manager"
put_secret nocturne-snowflake-token   "$(require_env SNOWFLAKE_TOKEN)"
put_secret nocturne-session-secret    "$(require_env NOCTURNE_SESSION_SECRET)"

# Grant the runtime service account read access. Idempotent.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
for secret in nocturne-snowflake-token nocturne-session-secret; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor \
    --project "$PROJECT_ID" >/dev/null
done

# --- deploy ----------------------------------------------------------------
# gcloud splits --set-env-vars on commas, and the two allowlists are themselves
# comma-separated. The ^@^ prefix tells gcloud to split on @ instead, so a
# multi-address allowlist survives intact.
ENV_VARS="NOCTURNE_DATA_SOURCE=live"
ENV_VARS+="@SNOWFLAKE_ACCOUNT=$(require_env SNOWFLAKE_ACCOUNT)"
ENV_VARS+="@SNOWFLAKE_USER=$(require_env SNOWFLAKE_USER)"
ENV_VARS+="@SNOWFLAKE_WAREHOUSE=$(read_env SNOWFLAKE_WAREHOUSE)"
ENV_VARS+="@SNOWFLAKE_ROLE=$(read_env SNOWFLAKE_ROLE)"
ENV_VARS+="@SNOWFLAKE_DATABASE=$(read_env SNOWFLAKE_DATABASE)"
ENV_VARS+="@SNOWFLAKE_SCHEMA=$(read_env SNOWFLAKE_SCHEMA)"
ENV_VARS+="@SNOWFLAKE_QUERY_TAG=$(read_env SNOWFLAKE_QUERY_TAG)"
ENV_VARS+="@SNOWFLAKE_QUERY_TIMEOUT_SECONDS=$(read_env SNOWFLAKE_QUERY_TIMEOUT_SECONDS)"
ENV_VARS+="@NEXT_PUBLIC_DASHBOARD_REFRESH_MS=$(read_env NEXT_PUBLIC_DASHBOARD_REFRESH_MS)"
ENV_VARS+="@NOCTURNE_ALLOWED_IPS=${ALLOWED_IPS}"
ENV_VARS+="@NOCTURNE_ALLOWED_HOSTS=${ALLOWED_HOSTS}"
ENV_VARS+="@NOCTURNE_PROXY_HOPS=${PROXY_HOPS}"
ENV_VARS+="@NOCTURNE_DEMO_PASSWORD_SUFFIX=$(read_env NOCTURNE_DEMO_PASSWORD_SUFFIX)"
# Breach-alert delivery. Deliberately NOT read from .env.local: that file holds
# the local console URL, and shipping it would point every "Open in Nocturne"
# link in a real alert email at someone's laptop.
ENV_VARS+="@NOCTURNE_CONSOLE_URL=${CONSOLE_URL}"
ENV_VARS+="@FIREBASE_PROJECT_ID=${PROJECT_ID}"
ENV_VARS+="@FIREBASE_MAIL_COLLECTION=$(read_env FIREBASE_MAIL_COLLECTION)"
# Bucket for manual paste-dump uploads. require_env rather than read_env: an
# empty value here does not fail the deploy, it ships a console whose upload
# button returns a configuration error, which is a far worse way to find out.
ENV_VARS+="@NOCTURNE_MANUAL_UPLOAD_BUCKET=$(require_env NOCTURNE_MANUAL_UPLOAD_BUCKET)"
# Crawler job for the on-demand live leak scan. read_env, not require_env: the
# server defaults these to nocturne-crawler / us-central1 / FIREBASE_PROJECT_ID,
# so an empty value here is a working configuration rather than a broken one.
ENV_VARS+="@NOCTURNE_CRAWLER_JOB=$(read_env NOCTURNE_CRAWLER_JOB)"
ENV_VARS+="@NOCTURNE_CRAWLER_REGION=$(read_env NOCTURNE_CRAWLER_REGION)"
ENV_VARS+="@NOCTURNE_CRAWLER_PROJECT=$(read_env NOCTURNE_CRAWLER_PROJECT)"
ENV_VARS="^@^${ENV_VARS}"

echo "==> building and deploying (Cloud Build compiles remotely; no local Docker needed)"
echo "    perimeter ips=${ALLOWED_IPS:-<any>} hosts=${ALLOWED_HOSTS:-<any>}"

# --allow-unauthenticated lets the request reach the container. The perimeter
# allowlist in src/middleware.ts and the login page decide who gets further.
# Without it Google's IAM check fires first and visitors never see the app.
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 \
  --memory 1Gi \
  --min-instances "$MIN_INSTANCES" \
  --max-instances 3 \
  --timeout 60 \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "SNOWFLAKE_TOKEN=nocturne-snowflake-token:latest,NOCTURNE_SESSION_SECRET=nocturne-session-secret:latest,NOCTURNE_ALERT_DISPATCH_TOKEN=NOCTURNE_ALERT_DISPATCH_TOKEN:latest"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo
echo "deployed: $URL"
echo
echo "next:"
echo "  1. add the service host to the allowlist so the Host check passes:"
echo "       ALLOWED_HOSTS=\"\${ALLOWED_HOSTS},${URL#https://}\" ./scripts/deploy_cloudrun.sh"
echo "  2. after the demo, stop paying for the warm instance:"
echo "       gcloud run services update $SERVICE --region $REGION --min-instances 0"

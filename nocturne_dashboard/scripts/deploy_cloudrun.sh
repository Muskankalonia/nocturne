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

# Static-egress networking. The service leaves through a Cloud NAT bound to a
# reserved IP (nocturne-egress-ip → nocturne-nat on the default VPC) so its
# outbound address never rotates; that fixed IP is what the Snowflake network
# policy DEPLOY_PIPELINE_POLICY allowlists. These flags are reasserted on every
# deploy on purpose: a `gcloud run deploy` that omitted them could drop the
# service back to dynamic Google egress, at which point the next Snowflake query
# 503s with "IP ... is not allowed to access Snowflake". Override only if you
# move the service to a different VPC/subnet.
VPC_NETWORK="${VPC_NETWORK:-default}"
VPC_SUBNET="${VPC_SUBNET:-default}"
VPC_EGRESS="${VPC_EGRESS:-all-traffic}"

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

# Reads a required key into the named variable.
#
# The assignment matters. The previous version returned the value on stdout, so
# every call sat inside "$( )" — a subshell — and `die` could only ever exit
# that subshell. The script carried on with an empty string, which is how a
# missing NOCTURNE_SECRET_KEY printed a clear "missing from .env.local" and
# then buried it under gcloud's "Secret Payload cannot be empty", leaving the
# second, less useful error to set the exit code.
#
# `printf -v` writes into the caller's scope, so this runs in the parent shell
# and `die` stops the deploy at the thing that is actually wrong.
need() {
  local var="$1" key="$2" value
  value="$(read_env "$key")"
  [[ -n "$value" ]] || die "$key is missing from $ENV_FILE"
  printf -v "$var" '%s' "$value"
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
need SNOWFLAKE_TOKEN_VALUE SNOWFLAKE_TOKEN
need SESSION_SECRET_VALUE NOCTURNE_SESSION_SECRET
put_secret nocturne-snowflake-token   "$SNOWFLAKE_TOKEN_VALUE"
put_secret nocturne-session-secret    "$SESSION_SECRET_VALUE"

# The key that encrypts stored Jira and Slack credentials.
#
# need, not read_env, and this is the important part: the ciphertext
# lives in NOCTURNE.CONFIG.INTEGRATION_SETTINGS, which local and production
# share. Deploying with a different key — or none — does not disable the
# integrations page, it makes it fail to decrypt credentials that are already
# saved, which reads as corruption rather than as a missing setting.
need SECRET_KEY_VALUE NOCTURNE_SECRET_KEY
put_secret nocturne-secret-key "$SECRET_KEY_VALUE"

# Shared secret for the inbound Jira close-sync webhook. Optional: a deployment
# with no Jira automation does not need it, and the route rejects every request
# when it is unset, which is the correct closed default.
JIRA_WEBHOOK_SECRET_VALUE="$(read_env JIRA_WEBHOOK_SECRET)"
if [[ -n "$JIRA_WEBHOOK_SECRET_VALUE" ]]; then
  put_secret nocturne-jira-webhook-secret "$JIRA_WEBHOOK_SECRET_VALUE"
else
  warn_missing_jira=1
fi

# Grant the runtime service account read access. Idempotent.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
SECRET_NAMES=(nocturne-snowflake-token nocturne-session-secret nocturne-secret-key)
[[ -n "${JIRA_WEBHOOK_SECRET_VALUE:-}" ]] && SECRET_NAMES+=(nocturne-jira-webhook-secret)
for secret in "${SECRET_NAMES[@]}"; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor \
    --project "$PROJECT_ID" >/dev/null
done

# --- deploy ----------------------------------------------------------------
# gcloud splits --set-env-vars on commas, and the two allowlists are themselves
# comma-separated. The ^@^ prefix tells gcloud to split on @ instead, so a
# multi-address allowlist survives intact.
need SNOWFLAKE_ACCOUNT_VALUE SNOWFLAKE_ACCOUNT
need SNOWFLAKE_USER_VALUE SNOWFLAKE_USER
ENV_VARS="NOCTURNE_DATA_SOURCE=live"
ENV_VARS+="@SNOWFLAKE_ACCOUNT=${SNOWFLAKE_ACCOUNT_VALUE}"
ENV_VARS+="@SNOWFLAKE_USER=${SNOWFLAKE_USER_VALUE}"
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
# need, not read_env. With this empty, api/auth/session falls back to "the
# password is the username" — a deliberate convenience for local development,
# and a published password on a console anyone can reach. A previous deploy
# pushed an empty value here and every demo account signed in with admin/admin
# until someone noticed. An empty suffix must fail the deploy, not ship.
need DEMO_SUFFIX_VALUE NOCTURNE_DEMO_PASSWORD_SUFFIX
ENV_VARS+="@NOCTURNE_DEMO_PASSWORD_SUFFIX=${DEMO_SUFFIX_VALUE}"
# Breach-alert delivery. Deliberately NOT read from .env.local: that file holds
# the local console URL, and shipping it would point every "Open in Nocturne"
# link in a real alert email at someone's laptop.
ENV_VARS+="@NOCTURNE_CONSOLE_URL=${CONSOLE_URL}"
ENV_VARS+="@FIREBASE_PROJECT_ID=${PROJECT_ID}"
ENV_VARS+="@FIREBASE_MAIL_COLLECTION=$(read_env FIREBASE_MAIL_COLLECTION)"
# Bucket for manual paste-dump uploads. need rather than read_env: an
# empty value here does not fail the deploy, it ships a console whose upload
# button returns a configuration error, which is a far worse way to find out.
need UPLOAD_BUCKET_VALUE NOCTURNE_MANUAL_UPLOAD_BUCKET
ENV_VARS+="@NOCTURNE_MANUAL_UPLOAD_BUCKET=${UPLOAD_BUCKET_VALUE}"
# Crawler job for the on-demand live leak scan. read_env, not need: the
# server defaults these to nocturne-crawler / us-central1 / FIREBASE_PROJECT_ID,
# so an empty value here is a working configuration rather than a broken one.
ENV_VARS+="@NOCTURNE_CRAWLER_JOB=$(read_env NOCTURNE_CRAWLER_JOB)"
ENV_VARS+="@NOCTURNE_CRAWLER_REGION=$(read_env NOCTURNE_CRAWLER_REGION)"
ENV_VARS+="@NOCTURNE_CRAWLER_PROJECT=$(read_env NOCTURNE_CRAWLER_PROJECT)"
ENV_VARS="^@^${ENV_VARS}"

# --set-secrets, like --set-env-vars, replaces the whole list rather than
# merging, so every secret the container needs has to be named on every deploy.
RUN_SECRETS="SNOWFLAKE_TOKEN=nocturne-snowflake-token:latest"
RUN_SECRETS+=",NOCTURNE_SESSION_SECRET=nocturne-session-secret:latest"
RUN_SECRETS+=",NOCTURNE_ALERT_DISPATCH_TOKEN=NOCTURNE_ALERT_DISPATCH_TOKEN:latest"
RUN_SECRETS+=",NOCTURNE_SECRET_KEY=nocturne-secret-key:latest"
[[ -n "${JIRA_WEBHOOK_SECRET_VALUE:-}" ]] \
  && RUN_SECRETS+=",JIRA_WEBHOOK_SECRET=nocturne-jira-webhook-secret:latest"

if [[ -n "${warn_missing_jira:-}" ]]; then
  echo "    note: JIRA_WEBHOOK_SECRET is not in $ENV_FILE — the Jira close-sync"
  echo "          webhook will reject every request until it is set."
fi

# Cloud Run throttles CPU to near zero between requests by default. Two things
# here run *after* their response has been sent: the manual upload's COPY, and
# the pipeline advance the upload status poll kicks off. Under throttling both
# stall until the next request happens to wake the instance, so a paste dump
# appears to hang at "raw ingest" with nothing in the logs to explain it.
#
# CPU_THROTTLING_FLAG=--cpu-throttling turns this off again, which is only
# correct on a deployment that has no manual uploads. It bills for the
# instance's whole lifetime rather than only during requests.
CPU_THROTTLING_FLAG="${CPU_THROTTLING_FLAG:---no-cpu-throttling}"
echo "    cpu: ${CPU_THROTTLING_FLAG#--}"

echo "==> building and deploying (Cloud Build compiles remotely; no local Docker needed)"
echo "    perimeter ips=${ALLOWED_IPS:-<any>} hosts=${ALLOWED_HOSTS:-<any>}"
echo "    egress: ${VPC_NETWORK}/${VPC_SUBNET} vpc-egress=${VPC_EGRESS} (static NAT IP)"

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
  --network "$VPC_NETWORK" \
  --subnet "$VPC_SUBNET" \
  --vpc-egress "$VPC_EGRESS" \
  ${CPU_THROTTLING_FLAG} \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$RUN_SECRETS"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo
echo "deployed: $URL"
echo
echo "next:"
echo "  1. add the service host to the allowlist so the Host check passes:"
echo "       ALLOWED_HOSTS=\"\${ALLOWED_HOSTS},${URL#https://}\" ./scripts/deploy_cloudrun.sh"
echo "  2. after the demo, stop paying for the warm instance:"
echo "       gcloud run services update $SERVICE --region $REGION --min-instances 0"

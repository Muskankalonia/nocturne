#!/usr/bin/env bash
#
# Nocturne Console — one-command deploy.
#
#   cd nocturne_dashboard
#   ./deploy.sh
#
# That is the whole procedure. The script checks your tools, signs you in if
# needed, deploys the container to Cloud Run, puts the Firebase Hosting
# hostname in front of it, and verifies the result.
#
# What you need first:
#   1. A .env.local in this directory. Copy .env.example and fill in the
#      Snowflake values:  cp .env.example .env.local
#   2. Access to the nocturne-502617 Google Cloud project.
#
# Everything else — signing in, enabling APIs, uploading secrets, building the
# image — happens below. Re-running is safe; each step is idempotent.

set -euo pipefail

export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${PROJECT_ID:-nocturne-502617}"
REGION="${REGION:-asia-southeast1}"
SERVICE="${SERVICE:-nocturne-console}"
SITE="${SITE:-nocturne-console}"
ENV_FILE="${ENV_FILE:-.env.local}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")"

bold "Nocturne Console → Cloud Run + Firebase Hosting"
echo "  project $PROJECT_ID · region $REGION · service $SERVICE"
echo

# --- 1. tools ---------------------------------------------------------------
bold "[1/6] checking tools"

if ! command -v gcloud >/dev/null; then
  die "gcloud not found. Install it with:
       curl https://sdk.cloud.google.com | bash && exec -l \$SHELL
     or run this script from Cloud Shell, which has it preinstalled."
fi
echo "  gcloud    ok"

if ! command -v firebase >/dev/null; then
  die "firebase CLI not found. Install it with:
       curl -sL https://firebase.tools | bash"
fi
echo "  firebase  ok"

command -v node >/dev/null || die "node not found (needed by the Firebase CLI)"
echo "  node      ok"

# --- 2. credentials ---------------------------------------------------------
bold "[2/6] checking sign-in"

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  warn "  not signed in to gcloud — opening a browser"
  gcloud auth login
fi
echo "  gcloud    $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"

# `firebase projects:list` is the cheapest call that fails when unauthenticated.
if ! firebase projects:list >/dev/null 2>&1; then
  warn "  not signed in to firebase — opening a browser"
  firebase login
fi
echo "  firebase  ok"

gcloud config set project "$PROJECT_ID" >/dev/null 2>&1 || true

# --- 3. configuration -------------------------------------------------------
bold "[3/6] checking configuration"

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE not found.
     Create it from the template and fill in the Snowflake values:
       cp .env.example $ENV_FILE"

read_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"//' -e 's/"$//'
}

for key in SNOWFLAKE_ACCOUNT SNOWFLAKE_USER SNOWFLAKE_TOKEN NOCTURNE_SESSION_SECRET \
           NOCTURNE_MANUAL_UPLOAD_BUCKET; do
  [[ -n "$(read_env "$key")" ]] || die "$key is missing from $ENV_FILE"
done
echo "  $ENV_FILE has the required values"

# The perimeter allowlist is deliberately NOT defaulted to empty. Reading it
# back off the running service means a redeploy never silently opens a console
# that someone had locked down. Override explicitly when you mean to:
#   ALLOWED_IPS="203.0.113.7" ./deploy.sh
# Read one env var off the running service. This parses JSON rather than
# grepping gcloud's rendered output: the rendered form is a Python-style dict
# whose fields are trivially confused with each other, and picking up a
# neighbouring value here would silently rewrite the allowlist to nonsense.
current_env() {
  gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
    --format=json 2>/dev/null | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        try {
          const env = JSON.parse(s).spec.template.spec.containers[0].env || [];
          const hit = env.find((e) => e.name === process.argv[1]);
          if (hit && typeof hit.value === "string") process.stdout.write(hit.value);
        } catch { /* no service yet, or no such variable */ }
      });
    ' "$1"
}

if [[ -z "${ALLOWED_IPS+x}" ]]; then
  ALLOWED_IPS="$(current_env NOCTURNE_ALLOWED_IPS || true)"
  [[ -n "$ALLOWED_IPS" ]] && echo "  reusing the IP allowlist already on the service"
fi
ALLOWED_IPS="${ALLOWED_IPS:-}"

if [[ -z "$ALLOWED_IPS" ]]; then
  warn "  IP allowlist is EMPTY — anyone who knows the URL can reach the login page."
  warn "  To restrict it:  ALLOWED_IPS=\"\$(curl -s ifconfig.me)\" ./deploy.sh"
else
  echo "  IP allowlist: $ALLOWED_IPS"
fi

# Carry the warm-instance setting across deploys. The Cloud Run deploy passes
# --min-instances explicitly, so leaving this unset would reset a warm service
# to zero on the next run and quietly bring back the cold start it was set to
# avoid.
if [[ -z "${MIN_INSTANCES+x}" ]]; then
  MIN_INSTANCES="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" \
    --region "$REGION" --format='value(spec.template.metadata.annotations["autoscaling.knative.dev/minScale"])' \
    2>/dev/null || true)"
fi
MIN_INSTANCES="${MIN_INSTANCES:-0}"
echo "  min instances: $MIN_INSTANCES$([[ "$MIN_INSTANCES" == "0" ]] && echo '  (cold starts on first visit; set MIN_INSTANCES=1 for a demo)' || echo '  (warm — this bills)')"

# Firebase rewrites the Host header to the Cloud Run hostname, so both the
# run.app names and the web.app names have to be accepted here.
ALLOWED_HOSTS="${ALLOWED_HOSTS:-}"

# --- 4. Cloud Run -----------------------------------------------------------
bold "[4/6] deploying to Cloud Run (Cloud Build compiles remotely, ~3-5 min)"

# PROXY_HOPS=1 because Firebase Hosting sits in front and appends itself to
# X-Forwarded-For. It also blocks direct run.app access as a side effect: a
# request that did not come through Firebase has nothing left after the strip.
PROXY_HOPS=1 MIN_INSTANCES="$MIN_INSTANCES" \
PROJECT_ID="$PROJECT_ID" REGION="$REGION" SERVICE="$SERVICE" ENV_FILE="$ENV_FILE" \
ALLOWED_IPS="$ALLOWED_IPS" ALLOWED_HOSTS="$ALLOWED_HOSTS" \
  ./scripts/deploy_cloudrun.sh

RUN_URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
RUN_HOST="${RUN_URL#https://}"

# Both URL forms Cloud Run publishes, plus the two Firebase hostnames.
HOSTS="${RUN_HOST},${SERVICE}-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)').${REGION}.run.app"
HOSTS="${HOSTS},${SITE}.web.app,${SITE}.firebaseapp.com"
[[ -n "$ALLOWED_HOSTS" ]] && HOSTS="${ALLOWED_HOSTS},${HOSTS}"

gcloud run services update "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --update-env-vars "^@^NOCTURNE_ALLOWED_HOSTS=${HOSTS}" >/dev/null
echo "  host allowlist set"

# --- 5. Firebase Hosting ----------------------------------------------------
bold "[5/6] deploying Firebase Hosting"

gcloud services enable firebase.googleapis.com firebasehosting.googleapis.com \
  --project "$PROJECT_ID" >/dev/null 2>&1 || true
# Ask whether the site exists rather than creating it and treating failure as
# "already there".
#
# `hosting:sites:create` does not simply exit non-zero on a duplicate: it gets a
# 409 and then *prompts* for a different site id. With stdout and stderr sent to
# /dev/null and stdin still attached to the terminal, that prompt is invisible
# and the deploy hangs forever on an unanswerable question. --non-interactive
# and </dev/null are both here so neither this command nor any it delegates to
# can block on input again.
if firebase hosting:sites:get "$SITE" --project "$PROJECT_ID" \
     --non-interactive </dev/null >/dev/null 2>&1; then
  echo "  site ${SITE} already exists"
elif firebase hosting:sites:create "$SITE" --project "$PROJECT_ID" \
       --non-interactive </dev/null >/dev/null 2>&1; then
  echo "  claimed ${SITE}.web.app"
else
  # Not fatal: the deploy below fails clearly if the site really is missing,
  # and that error is more informative than anything guessed here.
  warn "  could not confirm site ${SITE}; continuing to the hosting deploy"
fi

firebase deploy --only hosting --project "$PROJECT_ID" --non-interactive </dev/null

# --- 6. verify --------------------------------------------------------------
bold "[6/6] verifying"
sleep 8

fail=0
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "https://${SITE}.web.app/login" || echo 000)"
if [[ "$code" == "200" ]]; then
  echo "  https://${SITE}.web.app/login -> 200"
elif [[ "$code" == "403" && -n "$ALLOWED_IPS" ]]; then
  warn "  -> 403. Expected if you are not deploying from an allowlisted address."
  warn "     Current allowlist: $ALLOWED_IPS"
else
  warn "  https://${SITE}.web.app/login -> $code"
  fail=1
fi

direct="$(curl -s -o /dev/null -w '%{http_code}' --max-time 45 "${RUN_URL}/login" || echo 000)"
[[ "$direct" == "403" ]] \
  && echo "  direct ${RUN_HOST} -> 403 (correctly refused)" \
  || warn "  direct ${RUN_HOST} -> $direct (expected 403)"

# A fresh revision starts with an empty query cache, so whoever loads the
# console first would pay the full Snowflake round trip and watch the loading
# skeletons. Prime it here instead, using the demo account.
if [[ "$code" == "200" ]]; then
  SUFFIX="$(read_env NOCTURNE_DEMO_PASSWORD_SUFFIX)"
  JAR="$(mktemp)"
  if curl -s -c "$JAR" -X POST "https://${SITE}.web.app/api/auth/session" \
       -H 'content-type: application/json' \
       -d "{\"username\":\"admin\",\"password\":\"admin${SUFFIX}\"}" \
       -o /dev/null --max-time 60; then
    for ep in command-center breach-monitor; do
      curl -s -b "$JAR" -o /dev/null --max-time 120 "https://${SITE}.web.app/api/$ep" || true
    done
    echo "  query cache primed"
  fi
  rm -f "$JAR"
fi

echo
if [[ "$fail" == "0" ]]; then
  bold "deployed: https://${SITE}.web.app"
else
  warn "deployed with warnings — check the output above"
fi
cat <<EOF

notes
  · Traffic must arrive through https://${SITE}.web.app. The Cloud Run URL
    refuses direct requests by design.
  · A warm instance costs money. Turn it on for a demo, off afterwards:
      gcloud run services update $SERVICE --region $REGION --min-instances 1
      gcloud run services update $SERVICE --region $REGION --min-instances 0
  · If the console 403s unexpectedly, the perimeter logged the reason:
      gcloud run services logs read $SERVICE --region $REGION | grep perimeter
EOF

# Nocturne crawler

Nocturne is a bounded dark-web crawler that discovers onion URLs through Ahmia,
fetches matching pages through Tor, and writes raw page records either to local
text files or to gzip-compressed JSONL batches in Google Cloud Storage (GCS).
The production deployment is a single-task Cloud Run Job, so it runs only when
executed and does not expose an HTTP service.


## Repository layout

```text
.
├── Dockerfile
├── README.md
├── config.yaml
├── requirements.txt
├── src/
│   └── nocturne_crawler/
│       ├── __init__.py
│       ├── scraper.py
│       └── storage.py
└── tests/
    └── test_storage.py
```

## How storage works

Each accepted page becomes one independent JSON object (one line) inside a
`.jsonl.gz` GCS object. A batch can therefore contain many pages without merging
their text or metadata into one document. Snowflake can parse, filter, deduplicate,
or quarantine each page independently.

The GCS sink buffers at most 100 documents or 64 MiB of uncompressed JSONL by
default. Reaching either limit synchronously compresses and uploads the batch;
the crawler waits for that upload, which provides backpressure and bounded memory.

**With `OUTPUT_BACKEND=gcs`, records and gzip payloads exist only in memory; after a successful upload the buffers are released, and no local scraped-page or gzip files are created.**

The uploaded GCS object remains available for Snowflake. A failed upload fails the
job instead of discarding the buffered records and reporting success. Local mode is
separate: it writes human-readable page files and `crawl_summary.json` for development.

Each raw page record contains:

- `schema_version`, `run_id`, `source`, and `query`
- `doc_id`, identifying a particular fetched observation
- `dedupe_key`, stable for the same canonical URL and content across runs
- URL, title, fetch timestamp, depth, matched keywords, and link count
- content length, content SHA-256, and complete unredacted `raw_text`

The crawler prevents duplicate URL scheduling during a run. Cross-run data remains
append-only in GCS; Snowflake should use `dedupe_key` when it needs the latest unique
page content.

Objects use this layout:

```text
raw/crawls/
  crawl_date=YYYY-MM-DD/
    run_id=EXECUTION/
      task=0/
        attempt=0/
          part-00000.jsonl.gz
          _manifest.json
```

## Configuration

Edit `config.yaml` for the default query, keywords, maximum depth, and maximum
matched pages. These environment variables override runtime behavior:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OUTPUT_BACKEND` | `local` | Select `local` or `gcs`. |
| `OUTPUT_DIR` | `/tmp/scraped_pages` | Local output directory. |
| `GCS_BUCKET` | none | Required bucket name in GCS mode. |
| `GCS_PREFIX` | `raw/crawls` | Object-name prefix. |
| `GCS_BATCH_MAX_DOCUMENTS` | `100` | Maximum records buffered per part. |
| `GCS_BATCH_MAX_BYTES` | `67108864` | Maximum uncompressed bytes buffered per part. |
| `QUERY` | `config.yaml` value | Override the Ahmia query. |
| `MAX_DEPTH` | `config.yaml` value | Override BFS depth. |
| `MAX_PAGES` | `config.yaml` value | Maximum matched pages saved. |
| `MAX_VISITED_URLS` | `1000` | Hard limit on URLs attempted per execution. |
| `MAX_QUEUE_SIZE` | `2000` | Hard limit on pending BFS URLs. |
| `TOR_STARTUP_TIMEOUT` | `90` | Seconds to wait for the Tor SOCKS port. |
| `CONFIG_PATH` | root `config.yaml` | Alternate configuration file. |

`MAX_VISITED_URLS` and `MAX_QUEUE_SIZE` independently bound crawl work and memory;
`MAX_PAGES` alone only limits pages that pass the keyword filter.

## Test and run locally

Create a virtual environment, install dependencies, and run the unit tests:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --requirement requirements.txt
python -m unittest discover -s tests -v
```

Build and run the complete Tor/Chromium container in local-output mode:

```bash
docker build --tag nocturne-crawler:local .
mkdir -p output
docker run --rm --volume "$PWD/output:/tmp/scraped_pages" nocturne-crawler:local
```

The local files are written under `output/`. To limit a smoke crawl:

```bash
docker run --rm \
  --env MAX_DEPTH=0 \
  --env MAX_PAGES=1 \
  --volume "$PWD/output:/tmp/scraped_pages" \
  nocturne-crawler:local
```

## Deploy to Google Cloud

The following commands create a private raw bucket, a write-only crawler identity,
an Artifact Registry repository, a container image, and a Cloud Run Job. Run them
from the repository root with a gcloud account that can create these resources.

### 1. Set deployment values

```bash
export NOCTURNE_PROJECT_ID="your-gcp-project-id"
export NOCTURNE_REGION="us-central1"
export NOCTURNE_BUCKET="${NOCTURNE_PROJECT_ID}-nocturne-raw"
export NOCTURNE_REPOSITORY="nocturne-containers"
export NOCTURNE_IMAGE="crawler"
export NOCTURNE_IMAGE_TAG="v1"
export NOCTURNE_JOB="nocturne-crawler"
export NOCTURNE_SERVICE_ACCOUNT="crawler-uploader"
export NOCTURNE_SERVICE_EMAIL="${NOCTURNE_SERVICE_ACCOUNT}@${NOCTURNE_PROJECT_ID}.iam.gserviceaccount.com"
export NOCTURNE_IMAGE_URI="${NOCTURNE_REGION}-docker.pkg.dev/${NOCTURNE_PROJECT_ID}/${NOCTURNE_REPOSITORY}/${NOCTURNE_IMAGE}:${NOCTURNE_IMAGE_TAG}"

gcloud config set project "$NOCTURNE_PROJECT_ID"
```

Bucket names are globally unique. Change `NOCTURNE_BUCKET` if that name is already
owned by another project.

### 2. Enable APIs

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  iam.googleapis.com \
  run.googleapis.com \
  storage.googleapis.com
```

### 3. Create and secure the raw bucket

```bash
gcloud storage buckets create "gs://${NOCTURNE_BUCKET}" \
  --location="$NOCTURNE_REGION" \
  --default-storage-class=STANDARD \
  --uniform-bucket-level-access \
  --public-access-prevention
```

No lifecycle deletion is configured. Add one only after deciding how long raw,
unredacted landing data must remain available to Snowflake.

### 4. Create the crawler identity

```bash
gcloud iam service-accounts create "$NOCTURNE_SERVICE_ACCOUNT" \
  --display-name="Nocturne crawler GCS uploader"

gcloud storage buckets add-iam-policy-binding "gs://${NOCTURNE_BUCKET}" \
  --member="serviceAccount:${NOCTURNE_SERVICE_EMAIL}" \
  --role="roles/storage.objectCreator"
```

`roles/storage.objectCreator` lets the job create new objects but does not let it
read, list, overwrite, or delete existing raw objects. Cloud Run supplies credentials
through its service identity; do not create or copy a service-account key into the image.

### 5. Build the image

```bash
gcloud artifacts repositories create "$NOCTURNE_REPOSITORY" \
  --repository-format=docker \
  --location="$NOCTURNE_REGION" \
  --description="Nocturne crawler images"

gcloud builds submit . \
  --region="$NOCTURNE_REGION" \
  --tag="$NOCTURNE_IMAGE_URI"
```

### 6. Deploy the Cloud Run Job

```bash
gcloud run jobs deploy "$NOCTURNE_JOB" \
  --image="$NOCTURNE_IMAGE_URI" \
  --region="$NOCTURNE_REGION" \
  --service-account="$NOCTURNE_SERVICE_EMAIL" \
  --tasks=1 \
  --parallelism=1 \
  --cpu=2 \
  --memory=2Gi \
  --task-timeout=2h \
  --max-retries=1 \
  --set-env-vars="OUTPUT_BACKEND=gcs,GCS_BUCKET=${NOCTURNE_BUCKET},GCS_PREFIX=raw/crawls,GCS_BATCH_MAX_DOCUMENTS=100,GCS_BATCH_MAX_BYTES=67108864,MAX_VISITED_URLS=1000,MAX_QUEUE_SIZE=2000"
```

Only one task is used because the current Ahmia result set is not partitioned across
workers. The two-hour timeout accommodates slow or unavailable onion sites.

### 7. Execute and verify

```bash
gcloud run jobs execute "$NOCTURNE_JOB" \
  --region="$NOCTURNE_REGION" \
  --wait

gcloud run jobs executions list \
  --job="$NOCTURNE_JOB" \
  --region="$NOCTURNE_REGION"

gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=${NOCTURNE_JOB}" \
  --limit=100 \
  --format="value(textPayload)"

gcloud storage ls --recursive "gs://${NOCTURNE_BUCKET}/raw/crawls/**"
```

A successful execution always creates `_manifest.json`, even when no page matches or
all onion sites are unreachable. To inspect an object without saving a local gzip file:

```bash
export NOCTURNE_OBJECT_URI="gs://your-bucket/raw/crawls/.../part-00000.jsonl.gz"
gcloud storage cat "$NOCTURNE_OBJECT_URI" | gzip --decompress --stdout | sed -n '1p'
```

## Optional scheduling

Do not create a schedule until the desired crawl cadence is known. This example runs
every six hours in UTC and uses a separate invoker identity:

```bash
export NOCTURNE_SCHEDULER_ACCOUNT="crawler-scheduler"
export NOCTURNE_SCHEDULER_EMAIL="${NOCTURNE_SCHEDULER_ACCOUNT}@${NOCTURNE_PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts create "$NOCTURNE_SCHEDULER_ACCOUNT" \
  --display-name="Nocturne crawler scheduler"

gcloud run jobs add-iam-policy-binding "$NOCTURNE_JOB" \
  --region="$NOCTURNE_REGION" \
  --member="serviceAccount:${NOCTURNE_SCHEDULER_EMAIL}" \
  --role="roles/run.invoker"

gcloud scheduler jobs create http "${NOCTURNE_JOB}-schedule" \
  --location="$NOCTURNE_REGION" \
  --schedule="0 */6 * * *" \
  --time-zone="Etc/UTC" \
  --uri="https://run.googleapis.com/v2/projects/${NOCTURNE_PROJECT_ID}/locations/${NOCTURNE_REGION}/jobs/${NOCTURNE_JOB}:run" \
  --http-method=POST \
  --oauth-service-account-email="$NOCTURNE_SCHEDULER_EMAIL" \
  --oauth-token-scope="https://www.googleapis.com/auth/cloud-platform" \
  --headers="Content-Type=application/json" \
  --message-body="{}"
```

## Operational notes

- The job exits nonzero if Tor cannot start or a GCS batch/manifest upload fails.
- Individual unreachable pages are counted and skipped so one dead onion site does
  not fail the entire crawl.
- GCS part creation uses an object-generation precondition and conditional retries.
- A Cloud Run task retry writes to a distinct `attempt=N` prefix.
- The manifest excludes `raw_text`; raw content appears only in JSONL part objects.
- Treat the bucket as sensitive because it contains unredacted third-party content.

Official references:

- [Cloud Run Jobs](https://cloud.google.com/run/docs/create-jobs)
- [Cloud Run service identity](https://cloud.google.com/run/docs/securing/service-identity)
- [Cloud Storage public access prevention](https://cloud.google.com/storage/docs/public-access-prevention)
- [Cloud Storage IAM roles](https://cloud.google.com/storage/docs/access-control/iam-roles)
- [Schedule Cloud Run Jobs](https://cloud.google.com/run/docs/execute-jobs-on-schedule)

# Nocturne

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
├── deploy_pipeline.py
├── snowflake/
│   ├── requirements.txt
│   ├── 01_storage_integration.sql
│   ├── 02_ingestion_layer.sql
│   ├── 03_target_configuration.sql
│   ├── 04_detect_indicators_udf.sql
│   ├── 05_dt_regex_indicators.sql
│   ├── 06_build_classification_input_udf.sql
│   ├── 07_dt_l1_classification_input.sql
│   ├── 08_dt_relationship_classification.sql
│   ├── 09_dt_leak_type_severity.sql
│   └── 10_seed_validate_golive.sql
└── tests/
    └── test_storage.py
```

`snowflake/06_seed_verify_golive.sql` and `snowflake/queries.sql` belong to the
previous pipeline and are not executed by `deploy_pipeline.py`.

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

## Deploy the Snowflake pipeline

The Snowflake pipeline reads crawler page parts from GCS, detects deterministic
security indicators, selects bounded evidence windows, classifies each document
against the monitored organization, and calculates preliminary severity.

```text
GCS part-*.jsonl.gz
        |
        v
CRAWL_PAGES
        |
        v
DT_REGEX_INDICATORS
        |
        v
DT_L1_CLASSIFICATION_INPUT
        |
        v
DT_PAGE_RELATIONSHIP_CLASSIFICATION
        |
        v
DT_PAGE_CLASSIFICATION
```

The `_manifest.json` objects are deliberately excluded. Each JSONL line is loaded
as one page, while `DEDUPE_KEY` reduces repeated content to one L1 input.

### What each Snowflake file adds

| Step | File | Purpose |
| --- | --- | --- |
| 01 | `01_storage_integration.sql` | Creates the Snowflake GCS storage integration and displays its generated GCP service account. |
| 02 | `02_ingestion_layer.sql` | Creates the gzip JSON format, external stage, typed raw table, and suspended five-minute `COPY` task. It loads only `part-*.jsonl.gz`, uses `ABORT_STATEMENT`, and leaves GCS deletion disabled. |
| 03 | `03_target_configuration.sql` | Creates the monitored-organization configuration and seeds Palo Alto Networks, `PANW`, and `paloaltonetworks.com`. |
| 04 | `04_detect_indicators_udf.sql` | Creates the deterministic JavaScript indicator detector. It finds and scores validated cards, credentials, tokens, private-key markers, hashes, CVEs, emails, domains, and other indicators. |
| 05 | `05_dt_regex_indicators.sql` | Runs the indicator detector once per page and stores its structured result without modifying `RAW_TEXT`. |
| 06 | `06_build_classification_input_udf.sql` | Builds a maximum 16,000-character classification input from target anchors, leak terms, and L0 indicator spans. It masks retained sensitive matches and has a prefix/suffix fallback. |
| 07 | `07_dt_l1_classification_input.sql` | Deduplicates pages by `DEDUPE_KEY`, joins enabled organizations, materializes the input builder once, and exposes its scores and selection metadata. |
| 08 | `08_dt_relationship_classification.sql` | Calls `AI_CLASSIFY` once per unique document and organization to choose `target_data_leak`, `target_mentioned_no_leak`, `other_organization_leak`, or `no_leak`. Errors remain distinguishable from negative results. |
| 09 | `09_dt_leak_type_severity.sql` | Calls multi-label `AI_CLASSIFY` only for confirmed target leaks to detect credential, corporate-data, PII, financial, and malware/exploit exposure. It then calculates impact, target relevance, and preliminary severity. |
| 10 | `10_seed_validate_golive.sql` | Loads existing GCS parts synchronously, performs safe smoke queries, refreshes the final dynamic table, and resumes five-minute ingestion. |

Both AI calls request error details and convert the structured response to `VARIANT`
before storing it in a dynamic table. The first call establishes whether the data
belongs to the monitored company. The second call runs only for a confirmed target
leak, avoiding unnecessary Cortex calls. AI labels are decisions, not calibrated
probabilities; deterministic target, evidence, impact, and severity fields are
retained for explanation and later NER/knowledge-graph refinement.

### Snowflake prerequisites

- A warehouse named `COMPUTE_WH`, or matching changes to the SQL files.
- A role with permission to create the database, schemas, integration, stage,
  task, functions, and dynamic tables. The hackathon deployment uses
  `ACCOUNTADMIN`.
- Cortex access. Step 08 grants `SNOWFLAKE.CORTEX_USER` to `ACCOUNTADMIN`.
- Explicit cross-region Cortex approval if `AI_CLASSIFY` is unavailable in the
  account's local region.
- At least one GCS `part-*.jsonl.gz` object for an end-to-end result.

Create the Python environment from the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install --requirement snowflake/requirements.txt
```

Copy `.env.example` to `.env` and provide either a PAT or password:

```dotenv
SNOWFLAKE_ACCOUNT=your-org-your-account
SNOWFLAKE_USER=your-user
SNOWFLAKE_TOKEN=your-programmatic-access-token
SNOWFLAKE_WAREHOUSE=COMPUTE_WH
SNOWFLAKE_ROLE=ACCOUNTADMIN
```

`.env` is ignored by Git and must not be committed.

### First deployment with an existing GCS integration

Use this path when `NOCTURNE_GCS_INT` already exists and its generated Snowflake
service account already has bucket access:

```bash
source .venv/bin/activate
python deploy_pipeline.py --dry-run
python deploy_pipeline.py
```

The normal command runs steps 02 through 10. It intentionally preserves step 01
so an existing Snowflake-generated GCS identity and its IAM binding are not replaced.
Step 10 loads current files, refreshes the L0/L1 chain, and starts the recurring task,
so no separate `EXECUTE TASK` or `ALTER TASK ... RESUME` command is required.

If `CRAWL_PAGES` comes from the old pipeline, migrate or back it up and recreate it
before deployment. `CREATE TABLE IF NOT EXISTS` does not rename old columns such as
`FETCH_TIMESTAMP`, `MATCHED_KEYWORDS`, or `LINK_COUNT`.

### First deployment without a GCS integration

Run step 01 by itself:

```bash
python deploy_pipeline.py --step 1
```

Copy `STORAGE_GCP_SERVICE_ACCOUNT` from the integration description and grant it
bucket-scoped access:

```bash
gcloud storage buckets add-iam-policy-binding "gs://YOUR_BUCKET" \
  --member="serviceAccount:SNOWFLAKE_GENERATED_SERVICE_ACCOUNT" \
  --role="roles/storage.objectViewer"

gcloud storage buckets add-iam-policy-binding "gs://YOUR_BUCKET" \
  --member="serviceAccount:SNOWFLAKE_GENERATED_SERVICE_ACCOUNT" \
  --role="roles/storage.legacyBucketReader"
```

After IAM propagation, run the normal deployment:

```bash
python deploy_pipeline.py
```

Do not use a crawler service account in place of the Snowflake-generated identity.
The crawler writes objects; Snowflake needs read and list access.

### Inspect the final output

```sql
SELECT
  DOC_ID,
  TITLE,
  URL,
  RELATIONSHIP_AI_STATUS,
  RELATIONSHIP_LABEL,
  IS_RELEVANT,
  INDICATOR_SUMMARY,
  EVIDENCE_SCORE,
  TARGET_MATCH_SCORE,
  TARGET_RELEVANCE_SCORE,
  LEAK_TYPE_LABELS,
  LEAK_TYPE_AI_STATUS,
  IMPACT_SCORE,
  PRELIMINARY_SEVERITY_SCORE,
  PRELIMINARY_SEVERITY_BAND
FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
ORDER BY PRELIMINARY_SEVERITY_SCORE DESC NULLS LAST;
```

Check ingestion:

```sql
SHOW TASKS LIKE 'CRAWL_INGEST_TASK' IN SCHEMA NOCTURNE.RAW;

SELECT COUNT(*) AS RAW_PAGES
FROM NOCTURNE.RAW.CRAWL_PAGES;
```

### Running the pipeline again

New crawler data does not require another deployment. The started task checks GCS
every five minutes, and the final dynamic table has a 30-minute target lag. Snowflake
load history skips object names that were loaded successfully.

To process new GCS files immediately instead of waiting:

```bash
python deploy_pipeline.py --step 10
```

Step 10 performs a synchronous COPY, refreshes the full dependency chain, and leaves
the five-minute task running.

Do not run the complete deployment for every crawler execution. Steps 05 through 09
use `CREATE OR REPLACE DYNAMIC TABLE`; unnecessarily recreating them can reinitialize
data and repeat Cortex work.

Use the smallest applicable redeployment:

| Change made | Steps to rerun |
| --- | --- |
| New GCS data only | Nothing; wait for schedules, or run step 10 for an immediate result. |
| Target organization configuration | Update step 03/configuration, then run step 10 to force an immediate refresh. |
| Indicator detector | Steps 04, 05, 06, 07, 08, 09, and 10. |
| Classification-input builder | Steps 06, 07, 08, 09, and 10. |
| Deduplication/input dynamic tables | Steps 07, 08, 09, and 10. |
| Relationship labels, prompt, or examples | Steps 08, 09, and 10. |
| Leak types or severity formula | Steps 09 and 10. |
| Ingestion table, stage, file format, or task | Steps 02 through 10. |
| Fresh Snowflake environment with existing integration | Steps 02 through 10 with `python deploy_pipeline.py`. |

For example, after changing only the relationship classifier:

```bash
python deploy_pipeline.py --step 8
python deploy_pipeline.py --step 9
python deploy_pipeline.py --step 10
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

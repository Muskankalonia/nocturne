# Nocturne

Nocturne is a bounded dark-web crawler that discovers onion URLs through Ahmia,
fetches matching pages through Tor, and writes raw page records either to local
text files or to gzip-compressed JSONL batches in Google Cloud Storage (GCS).
The production deployment is a single-task Cloud Run Job, so it runs only when
executed and does not expose an HTTP service. Every crawl is scoped to one stable
organization ID, which remains part of the data key through Snowflake L0-L4.


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
├── cleanup_snowflake.py
├── logs/                         # Generated timestamped pipeline logs
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
│   ├── 09_dt_l2_extraction_ai.sql
│   ├── 10_dt_l2_grounding_routing.sql
│   ├── 11_dt_leak_type_severity.sql
│   ├── 12_dt_l3_knowledge_graph.sql
│   ├── 13_dt_l4_severity.sql
│   ├── 14_ai_incident_insights.sql
│   ├── 15_seed_validate_golive.sql
│   ├── 99_cleanup.sql            # Destructive; never deployed normally
│   └── tests/
│       ├── 06_build_classification_input_middle_window_test.sql
│       └── 10_l2_grounding_routing_test.sql
└── tests/
    └── test_storage.py
```

`snowflake/99_cleanup.sql`, Snowflake fixtures under `snowflake/tests/`, and
`snowflake/queries.sql` are intentionally not executed by `deploy_pipeline.py`.

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

- `schema_version=2`, `org_id`, `run_id`, `source`, and `query`
- `doc_id`, identifying a particular fetched observation
- `dedupe_key`, stable for the same canonical URL and content across runs
- URL, title, fetch timestamp, depth, matched keywords, and link count
- content length, content SHA-256, and complete unredacted `raw_text`

The organization ID participates in both hashes. Therefore identical content
crawled for two organizations remains logically separate. The crawler prevents
duplicate URL scheduling during a run. Cross-run data remains append-only in GCS;
Snowflake uses `(org_id, dedupe_key)` for organization-scoped deduplication.

Objects use this layout:

```text
raw/crawls/
  org_id=palo_alto_networks/
    crawl_date=YYYY-MM-DD/
      run_id=EXECUTION/
        task=0/
          attempt=0/
            part-00000.jsonl.gz
            _manifest.json
```

## Configuration

Edit `config.yaml` for the required organization slug, default query, keywords,
maximum depth, and maximum matched pages:

```yaml
organization:
  org_id: palo_alto_networks
```

The slug must contain lowercase letters/numbers separated by underscores. The
crawler fails before network activity if it is missing or invalid. These
environment variables override runtime behavior:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OUTPUT_BACKEND` | `local` | Select `local` or `gcs`. |
| `OUTPUT_DIR` | `/tmp/scraped_pages` | Local output directory. |
| `GCS_BUCKET` | none | Required bucket name in GCS mode. |
| `GCS_PREFIX` | `raw/crawls` | Object-name prefix. |
| `GCS_BATCH_MAX_DOCUMENTS` | `100` | Maximum records buffered per part. |
| `GCS_BATCH_MAX_BYTES` | `67108864` | Maximum uncompressed bytes buffered per part. |
| `QUERY` | `config.yaml` value | Override the Ahmia query. |
| `ORG_ID` | `config.yaml` value | Required organization slug written to records and GCS paths. |
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
  --set-env-vars="OUTPUT_BACKEND=gcs,GCS_BUCKET=${NOCTURNE_BUCKET},GCS_PREFIX=raw/crawls,ORG_ID=palo_alto_networks,GCS_BATCH_MAX_DOCUMENTS=100,GCS_BATCH_MAX_BYTES=67108864,MAX_VISITED_URLS=1000,MAX_QUEUE_SIZE=2000"
```

Only one task is used because the current Ahmia result set is not partitioned across
workers. The two-hour timeout accommodates slow or unavailable onion sites. For a
different organization, deploy/update the job with that organization's `ORG_ID`
and query, and create the same `ORG_ID` in Snowflake configuration before loading
its pages.

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

The Snowflake pipeline keeps deterministic transformations in dynamic tables and
stores every paid AI result in a persistent table. It maintains the crawler's
organization boundary from ingestion through the final dashboard output.

```text
Organization-scoped crawler -> schema-v2 JSONL.gz -> CRAWL_PAGES
  -> L0 deterministic indicators and evidence windows
  -> L1 cached relationship AI
  -> L2 cached unbiased extraction, grounding, and target resolution
  -> cached leak-type AI for target-confirmed leaks only
  -> L3 target knowledge graph
  -> L4 impact/confidence/triage scores
  -> cached per-incident AI insight
```

The `_manifest.json` objects and legacy schema-v1 paths are excluded. Each JSONL
line remains one page. A raw row reaches L0 only when:

```text
schema_version = 2
JSON org_id = GCS path org_id
org_id is enabled in NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
```

Invalid rows stay in `CRAWL_PAGES` for diagnosis but never reach AI. Pages join
only the configuration row with the same `ORG_ID`; there is no cross join between
pages and all monitored organizations.

For multiple organizations, run a separate crawler execution for each slug and
add a matching Snowflake configuration row. Different organizations may share the
bucket and Snowflake tables because all paths, hashes, cache keys, graph keys, and
final views retain `ORG_ID`:

```sql
MERGE INTO NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS TARGET
USING (
  SELECT
    'bank_of_baroda' AS ORG_ID,
    'Bank of Baroda' AS CANONICAL_NAME,
    ARRAY_CONSTRUCT('BOB') AS ALIASES,
    ARRAY_CONSTRUCT('bankofbaroda.in') AS DOMAINS,
    ARRAY_CONSTRUCT() AS PRODUCTS,
    TRUE AS ENABLED
) AS SOURCE
ON TARGET.ORG_ID = SOURCE.ORG_ID
WHEN NOT MATCHED THEN INSERT
  (ORG_ID, CANONICAL_NAME, ALIASES, DOMAINS, PRODUCTS, ENABLED)
VALUES
  (SOURCE.ORG_ID, SOURCE.CANONICAL_NAME, SOURCE.ALIASES,
   SOURCE.DOMAINS, SOURCE.PRODUCTS, SOURCE.ENABLED);
```

`ORG_ID` is the stable routing key, not the company name supplied to AI. L1 obtains
the canonical name, aliases, domains, and products by joining the configuration row
for that slug.

### What each Snowflake file adds

| Step | File | Purpose |
| --- | --- | --- |
| 01 | `01_storage_integration.sql` | Creates the Snowflake GCS storage integration and displays its generated GCP service account. |
| 02 | `02_ingestion_layer.sql` | Creates the gzip JSON format, stage, organization-aware raw table, and five-minute ingestion task. It uses `ABORT_STATEMENT` and leaves GCS deletion disabled. |
| 03 | `03_target_configuration.sql` | Creates the monitored-organization configuration and seeds Palo Alto Networks, `PANW`, and `paloaltonetworks.com`. |
| 04 | `04_detect_indicators_udf.sql` | Creates the deterministic JavaScript indicator detector. It finds and scores validated cards, credentials, tokens, private-key markers, hashes, CVEs, emails, domains, and other indicators. |
| 05 | `05_dt_regex_indicators.sql` | Rejects invalid organization scope, runs the detector once per page, and preserves unchanged `RAW_TEXT`. |
| 06 | `06_build_classification_input_udf.sql` | Builds a target-aware L1 input and a target-profile-free L2 evidence input from ranked windows, with a deterministic fallback. |
| 07 | `07_dt_l1_classification_input.sql` | Deduplicates by `(ORG_ID, DEDUPE_KEY)`, joins only the matching enabled organization, and exposes target/leak signals and window metadata. |
| 08 | `08_dt_relationship_classification.sql` | Creates the persistent relationship cache, incremental candidates, stream, and triggered `AI_CLASSIFY` task for the four L1 labels. |
| 09 | `09_dt_l2_extraction_ai.sql` | Sends only L1 target leaks and suspicious target mentions to a cached, evidence-only `AI_COMPLETE` extraction task. |
| 10 | `10_dt_l2_grounding_routing.sql` | Validates extraction output, grounds evidence, resolves target names/domains, validates endpoints, and routes each page. |
| 11 | `11_dt_leak_type_severity.sql` | Runs cached multi-label leak-type AI only after L2 returns `target_confirmed`, then builds the auditable page result. |
| 12 | `12_dt_l3_knowledge_graph.sql` | Promotes only accepted, grounded, target-connected claims and edges into an organization-scoped knowledge graph. |
| 13 | `13_dt_l4_severity.sql` | Separates impact severity, evidence confidence, and triage priority and exposes document, incident, and organization views. |
| 14 | `14_ai_incident_insights.sql` | Creates a persistent, triggered `AI_COMPLETE` cache that produces one dashboard narrative for each target incident. |
| 15 | `15_seed_validate_golive.sql` | Suspends tasks, loads schema-v2 parts, validates organization isolation, refreshes deterministic candidates, and resumes all tasks. |

`99_cleanup.sql` is destructive and is deliberately outside the deployment order.

### AI gating, caching, and task behavior

The four paid stages are relationship classification, L2 extraction, leak-type
classification, and incident insight generation. Each stage uses:

```text
incremental candidate dynamic table
  -> standard stream
  -> stream-triggered task
  -> persistent result table
```

The persistent caches retain organization-scoped identities, input hashes,
prompt/model versions, statuses, errors, and call timestamps. Successful results
and row-level errors are reused across deployment and verification. Errors are not
automatically retried, and prompt/model changes do not silently recalculate old
rows. A deliberate hackathon reset uses cleanup followed by a fresh deployment.

AI tasks have no polling schedule. They run only when their candidate stream has
data, and a waiting triggered task does not keep its warehouse active. Candidate
dynamic tables have five-minute target lags, so dependent AI stages can take
multiple refresh/task cycles to reach the final insight. GCS ingestion remains the
only five-minute scheduled task.

The cost and ownership gate is:

1. L1 classifies each valid, deduplicated page for its intended organization.
2. L2 receives `target_data_leak`, plus `target_mentioned_no_leak` only when a
   deterministic target anchor and leak/indicator signal make it suspicious.
3. L2 extracts from `EVIDENCE_INPUT` without seeing configured target metadata;
   deterministic SQL then grounds evidence and resolves entities for that row's
   `ORG_ID` only.
4. `target_confirmed` requires a grounded leak claim connected by an accepted
   `ALLEGEDLY_AFFECTS` edge to the resolved target organization or exact domain.
5. If no organization/domain resolves to the monitored target, the page does not
   reach leak-type AI, L3, target severity, or incident insights.
6. For a page containing target and other-company claims, only the target-connected
   graph component is promoted.

Other routes are `other_organization_confirmed`, `ambiguous`, `not_relevant`, and
`extraction_error`. Only `target_confirmed` is target-alert eligible.

### L4 scores and incident insights

L4 does not multiply severity by an assumed probability. Its three 0-100 metrics
answer different questions and are explicitly not probabilities:

```text
impact = 0.60 * data sensitivity
       + 0.25 * exposure actionability
       + 0.15 * claimed record scale

confidence = 0.35 * ownership evidence
           + 0.25 * evidence grounding
           + 0.20 * claim proof
           + 0.15 * distinct-content corroboration
           + 0.05 * actor credibility

triage priority = 0.80 * impact + 0.20 * confidence
```

Weights for unavailable optional inputs are normalized away. Same-content mirrors
increase sightings but not corroboration. All components and reasons remain
available for explanation. Bands are informational (0-19), low (20-39), medium
(40-59), high (60-79), and critical (80-100).

Insights are cached per incident, not per organization. For this hackathon,
`ORG_ID + CONTENT_SHA256` defines an incident: a later batch with identical content
reuses its insight, while different content creates a separate incident and
insight. The dashboard view exposes a headline, executive summary, what happened,
business impact, recommended actions, confidence assessment, and caveats.

### Snowflake prerequisites

- A warehouse named `COMPUTE_WH`, or matching changes to the SQL files.
- A role with permission to create the database, schemas, integration, stage,
  task, functions, and dynamic tables. The hackathon deployment uses
  `ACCOUNTADMIN`.
- Cortex access. Step 08 grants `SNOWFLAKE.CORTEX_USER` to `ACCOUNTADMIN`.
- Access to the configured `claude-sonnet-4-5` model and Cortex AI functions.
- At least one GCS `part-*.jsonl.gz` object for an end-to-end result.

The documented hackathon residency policy is `AWS_APJ`. An administrator can set
it after reviewing the account's data-residency requirements:

```sql
ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'AWS_APJ';
```

`deploy_pipeline.py` reads the account region, cross-region policy, and visible
base-model metadata without making a synthetic Cortex call. It does not change the
account setting or silently switch models. Deployment stops before resuming paid
tasks if the configured model cannot run under the current policy. Check current
model availability before changing this account-level setting.

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

### Deploy with an existing GCS integration

Use this path when `NOCTURNE_GCS_INT` already exists and its generated Snowflake
service account already has bucket access:

```bash
source .venv/bin/activate
python deploy_pipeline.py --dry-run
python deploy_pipeline.py
```

The normal command runs steps 02 through 15. It intentionally preserves step 01
so an existing Snowflake-generated GCS identity and its IAM binding are not replaced.
It suspends existing ingestion and AI tasks before replacing upstream objects.
Step 15 validates the rebuilt pipeline and resumes them, so no separate
`EXECUTE TASK` or `ALTER TASK ... RESUME` command is required.

Use `python deploy_pipeline.py` for normal deployments when `NOCTURNE_GCS_INT`
already exists. This architecture expects a clean schema-v2 test environment
rather than migration of the previous dynamic-table AI results.

### Deployment logs and AI-input inspection

Every `deploy_pipeline.py` invocation creates `logs/` when needed and writes the
console output to a timestamped file:

```text
logs/pipeline_YYYYMMDD_HHMMSS_UTC-OFFSET.log
```

The logs show object-level effects instead of complete SQL statements or Snowflake
result tuples. Each step reports which stage, table, task, function, or dynamic
table was created, replaced, refreshed, or resumed. COPY results include the
affected GCS filename, loaded-row count, and error count.

At the end of a deployment, the report includes:

- raw/L0 page counts and all four relationship labels by organization;
- newly classified source filenames and titles;
- L0 indicator type/count summaries, strength counts, and evidence scores;
- selected evidence-window offsets, scores, reasons, and fallback state;
- L1 labels, L2 gate reasons, and L2 routes;
- extracted organization/domain entities, grounding, target resolution and
  similarity, accepted claims, and accepted ownership edges;
- leak types, impact/confidence/triage scores, and incident-insight summaries;
- cache rows, missing candidates, AI errors, task failures, and recent tagged
  Cortex credits by stage and model.

Paid queries use the tags `NOCTURNE_RELATIONSHIP_AI`,
`NOCTURNE_L2_EXTRACTION_AI`, `NOCTURNE_LEAK_TYPE_AI`, and
`NOCTURNE_L4_INCIDENT_INSIGHT_AI`. Account-usage credit reporting can lag behind
the current run.

Exact regex values are deliberately not written to logs. For example, the report
records `validated_credit_card_count=1`, not the card number. The default detailed
report is limited to pages ingested during the current run so historical pages do
not overwhelm the terminal.

Run a read-only health check without redeploying objects, consuming streams, or
calling Cortex:

```bash
python deploy_pipeline.py --verify-only
```

Create a metadata-only text report without invoking AI:

```bash
python deploy_pipeline.py --report output/report.txt
```

To inspect both the masked target-aware L1 input and evidence-only L2 input, enable
prompt logging explicitly:

```bash
python deploy_pipeline.py --verify-only --log-ai-inputs
```

This command does not perform another classification. Known indicator spans are
masked, but unmatched sensitive text can remain, so use this option only in an
appropriately restricted development environment.

Inspect the newest log with:

```bash
ls -lt logs/
less "$(ls -t logs/pipeline_*.log | head -1)"
```

The evidence-window builder sends a complete masked short document when it fits.
Longer documents use a bounded prefix, ranked middle windows, and deduplicated
suffix within a 16,000-character limit. Ranking uses target anchors, leak terms,
and strong/medium L0 indicator locations. L2 reuses the selected page evidence but
omits configured canonical names, aliases, domains, products, and target profile,
preventing target metadata from biasing entity extraction.

The `logs/` directory is ignored by Git. Do not commit prompt logs because they can
contain sensitive page content.

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

`python deploy_pipeline.py --include-storage-integration` rebuilds all 15 steps,
but is appropriate only when the resulting integration identity already has
working bucket IAM. The safer first-time workflow is the two-phase step-1/IAM/full
deployment above because a new identity cannot read GCS until IAM is granted.

### Inspect the final output

```sql
SELECT
  ORG_ID,
  INCIDENT_KEY,
  INSIGHT_AI_STATUS,
  INSIGHT_HEADLINE,
  INCIDENT_IMPACT_SEVERITY_SCORE,
  INCIDENT_IMPACT_SEVERITY_BAND,
  INCIDENT_EVIDENCE_CONFIDENCE_SCORE,
  INCIDENT_EVIDENCE_CONFIDENCE_BAND,
  INCIDENT_TRIAGE_PRIORITY_SCORE,
  INCIDENT_TRIAGE_PRIORITY_BAND,
  EXECUTIVE_SUMMARY,
  WHAT_HAPPENED,
  BUSINESS_IMPACT,
  RECOMMENDED_ACTIONS,
  CONFIDENCE_ASSESSMENT,
  INSIGHT_CAVEATS
FROM NOCTURNE.RAW.VW_L4_INCIDENT_INSIGHTS
ORDER BY INCIDENT_TRIAGE_PRIORITY_SCORE DESC;
```

Inspect organization routing and raw scope:

```sql
SELECT ORG_ID, L2_ROUTE, ROUTING_REASON, COUNT(*) AS PAGES
FROM NOCTURNE.RAW.DT_L2_ROUTING
GROUP BY ORG_ID, L2_ROUTE, ROUTING_REASON
ORDER BY ORG_ID, L2_ROUTE;

SELECT ORG_ID, _PATH_ORG_ID, SCHEMA_VERSION, COUNT(*) AS RAW_PAGES
FROM NOCTURNE.RAW.CRAWL_PAGES
GROUP BY ORG_ID, _PATH_ORG_ID, SCHEMA_VERSION;
```

### Running the pipeline again

New crawler data does not require another deployment. The started task checks GCS
every five minutes, and Snowflake load history skips object names already loaded
successfully. Gzip objects remain in GCS while `PURGE=TRUE` is commented. New valid
pages flow through the triggered AI chain, while cached results are reused.

To load new GCS files synchronously, validate organization scope, and resume every
task while retaining terminal logs:

```bash
python deploy_pipeline.py --step 15
```

AI work after step 15 is asynchronous. Wait for triggered tasks and dynamic-table
refreshes, then inspect without additional AI calls:

```bash
python deploy_pipeline.py --verify-only
```

Do not redeploy for every crawler run. Persistent caches prevent completed calls
from repeating during normal deployment, and the deployer suspends existing tasks
before a full rebuild. Candidate tables and streams intentionally use `IF NOT
EXISTS`; candidate-logic, prompt, or model changes should use cleanup/rebuild in
this test environment rather than assuming old cache rows were recalculated.

### Suspend or resume processing

Suspend only the five-minute GCS scheduler while allowing already-ingested data to
finish the AI chain:

```sql
ALTER TASK NOCTURNE.RAW.CRAWL_INGEST_TASK SUSPEND;
```

To prevent any new paid AI calls during testing, suspend the AI tasks too:

```sql
ALTER TASK NOCTURNE.RAW.RELATIONSHIP_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.L2_EXTRACTION_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.LEAK_TYPE_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.INCIDENT_INSIGHT_AI_TASK SUSPEND;
```

Running step 15 validates and resumes all five tasks. Triggered AI tasks process
only missing candidates.

### Clean up the Snowflake test environment

The cleanup is destructive and does not create a backup. Run the interactive
wrapper from the repository root:

```bash
source .venv/bin/activate
python cleanup_snowflake.py
```

Type `DROP_NOCTURNE` when prompted. For explicitly confirmed non-interactive use:

```bash
python cleanup_snowflake.py --confirm DROP_NOCTURNE
```

The wrapper executes `snowflake/99_cleanup.sql`, stops on the first failure, and
writes a timestamped `logs/cleanup_*.log`. It suspends ingestion and all four paid
AI tasks, drops the complete `NOCTURNE` database, and drops `NOCTURNE_GCS_INT`. It
does not remove `COMPUTE_WH`, Cortex roles/settings, the GCS bucket, GCS objects,
or GCS IAM bindings. Recreating the integration can generate a new Snowflake GCS
identity that must be granted bucket access again.

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
- [Snowflake triggered tasks](https://docs.snowflake.com/en/user-guide/tasks-triggered)
- [Streams on dynamic tables](https://docs.snowflake.com/en/user-guide/dynamic-tables/streams-on-dts)
- [Cortex model availability](https://docs.snowflake.com/en/user-guide/snowflake-cortex/aisql-regional-availability)
- [Cortex AI usage history](https://docs.snowflake.com/en/sql-reference/account-usage/cortex_ai_functions_usage_history)

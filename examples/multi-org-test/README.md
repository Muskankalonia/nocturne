# Multi-organization end-to-end fixtures

These schema-v2 crawler fixtures reproduce the enabled organizations and
incidents currently shown by `nocturne_dashboard/src/mocks/`.

They are synthetic. They contain no real credentials, customer records, or
private data.

## Included organizations

| Organization | Records | Expected semantic result |
| --- | ---: | --- |
| Odido | 4 | Existing challenging fixture: one confirmed target leak and three controls |
| AT&T | 2 | Two target leaks: subscriber PII/corporate data and internal credentials |
| Bank of Baroda | 1 | One target financial-data leak with normalized-name grounding |
| Contoso Logistics | 1 | One target customer-PII leak with normalized evidence formatting |
| Northwind Traders | 1 uncompressed negative fixture | Disabled organization; must not enter normal ingestion |

The titles, URLs, organizations, domains, actors, quantities and intended leak
types match the dashboard mocks. Snowflake calculates new hashes, entity keys,
AI labels and scores from the evidence. Do not expect the genuine pipeline
scores to equal the hand-authored mock scores exactly.

## Files safe for the normal demonstration

```text
../end-to-end-test/part-00000.jsonl.gz
att/part-00000.jsonl.gz
bank_of_baroda/part-00000.jsonl.gz
contoso_logistics/part-00000.jsonl.gz
```

`northwind_traders/disabled-org-negative.jsonl` intentionally has no matching
gzip. Do not rename, compress, or upload it under a `part-*.jsonl.gz` path during
the normal run. Because Northwind is disabled, loading it is expected to block
the Step 15 organization-isolation validation.

## 1. Configure the organizations

From the repository root, deploy Step 3:

```bash
source .venv/bin/activate
python deploy_pipeline.py --step 3
```

The configuration uses an insert-only merge. It adds missing organizations but
does not overwrite any organization already edited in Snowflake.

Verify:

```sql
SELECT ORG_ID, CANONICAL_NAME, ALIASES, DOMAINS, PRODUCTS, ENABLED
FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
ORDER BY ORG_ID;
```

AT&T, Bank of Baroda, Contoso Logistics and Odido must be enabled.
Northwind Traders must be disabled.

## 2. Upload the organization-partitioned objects

Set the existing bucket:

```bash
export NOCTURNE_BUCKET="nocturne-502617-nocturne-raw"
```

Upload the three new organization fixtures:

```bash
gcloud storage cp \
  examples/multi-org-test/att/part-00000.jsonl.gz \
  "gs://${NOCTURNE_BUCKET}/raw/crawls/org_id=att/crawl_date=2026-08-02/run_id=multi-org-mocks-20260802-001/task=0/attempt=0/part-00000.jsonl.gz"

gcloud storage cp \
  examples/multi-org-test/bank_of_baroda/part-00000.jsonl.gz \
  "gs://${NOCTURNE_BUCKET}/raw/crawls/org_id=bank_of_baroda/crawl_date=2026-08-02/run_id=multi-org-mocks-20260802-001/task=0/attempt=0/part-00000.jsonl.gz"

gcloud storage cp \
  examples/multi-org-test/contoso_logistics/part-00000.jsonl.gz \
  "gs://${NOCTURNE_BUCKET}/raw/crawls/org_id=contoso_logistics/crawl_date=2026-08-02/run_id=multi-org-mocks-20260802-001/task=0/attempt=0/part-00000.jsonl.gz"
```

For a clean Snowflake environment, also upload the existing Odido fixture:

```bash
gcloud storage cp \
  examples/end-to-end-test/part-00000.jsonl.gz \
  "gs://${NOCTURNE_BUCKET}/raw/crawls/org_id=odido/crawl_date=2026-08-02/run_id=multi-org-mocks-20260802-001/task=0/attempt=0/part-00000.jsonl.gz"
```

Skip that last command when the Odido fixture is already present in
`NOCTURNE.RAW.CRAWL_PAGES`. Copying identical content under a new GCS filename
would create an unnecessary duplicate RAW row, even though downstream cache and
deduplication keys prevent duplicate paid AI work.

Confirm only the intended objects were uploaded:

```bash
gcloud storage ls \
  "gs://${NOCTURNE_BUCKET}/raw/crawls/org_id=*/crawl_date=2026-08-02/run_id=multi-org-mocks-20260802-001/**"
```

## 3. Deploy and start the multi-organization run

The safest path after tasks or dynamic tables have been suspended is a normal
deployment. It preserves the existing storage integration and persistent AI
caches, recreates deterministic objects, loads new filenames and resumes tasks
only after validation:

```bash
python deploy_pipeline.py
```

Do not use `--include-storage-integration` for the existing account. Replacing
the integration can generate a new GCS service identity and invalidate the
current bucket IAM grant.

Paid stages are cached by `(ORG_ID, DEDUPE_KEY)`. Existing Odido results are
reused. Only genuinely new organization documents become paid candidates.

## 4. Allow asynchronous stages to settle

The triggered AI tasks run only when candidate streams contain rows, while the
deterministic tables use five-minute freshness targets. A cold multi-stage run
normally needs approximately 10–20 minutes to reach incident insights.

Check progress without invoking Cortex:

```bash
python deploy_pipeline.py --verify-only
```

Expected progression:

```text
RAW/L0
→ relationship cache
→ L2 extraction cache and ownership route
→ target-confirmed leak-type cache
→ L3/L4 incident
→ cached incident insight
```

## 5. Verify organization isolation and final incidents

These queries are read-only and do not invoke Cortex.

```sql
SELECT ORG_ID, _PATH_ORG_ID, COUNT(*) AS RAW_PAGES,
       COUNT_IF(ORG_ID <> _PATH_ORG_ID) AS PATH_MISMATCHES
FROM NOCTURNE.RAW.CRAWL_PAGES
GROUP BY ORG_ID, _PATH_ORG_ID
ORDER BY ORG_ID;

SELECT ORG_ID, RELATIONSHIP_LABEL, COUNT(*) AS PAGE_COUNT
FROM NOCTURNE.RAW.DT_PAGE_RELATIONSHIP_CLASSIFICATION
GROUP BY ORG_ID, RELATIONSHIP_LABEL
ORDER BY ORG_ID, RELATIONSHIP_LABEL;

SELECT ORG_ID, L2_ROUTE, COUNT(*) AS PAGE_COUNT
FROM NOCTURNE.RAW.DT_L2_ROUTING
GROUP BY ORG_ID, L2_ROUTE
ORDER BY ORG_ID, L2_ROUTE;

SELECT ORG_ID, TOP_TITLE, LEAK_TYPE_LABELS,
       INCIDENT_IMPACT_SEVERITY_SCORE,
       INCIDENT_EVIDENCE_CONFIDENCE_SCORE,
       INCIDENT_TRIAGE_PRIORITY_SCORE,
       INSIGHT_AI_STATUS,
       INSIGHT_HEADLINE
FROM NOCTURNE.RAW.VW_L4_INCIDENT_INSIGHTS
ORDER BY ORG_ID, INCIDENT_TRIAGE_PRIORITY_SCORE DESC;
```

The normal run must contain no `northwind_traders` row in `CRAWL_PAGES` or any
AI result table.

## 6. Suspend processing after the demonstration

Suspending tasks preserves all rows for dashboard export and querying:

```sql
USE ROLE ACCOUNTADMIN;

ALTER TASK NOCTURNE.RAW.CRAWL_INGEST_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.RELATIONSHIP_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.L2_EXTRACTION_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.LEAK_TYPE_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.INCIDENT_INSIGHT_AI_TASK SUSPEND;

ALTER WAREHOUSE COMPUTE_WH SUSPEND;

SHOW TASKS IN SCHEMA NOCTURNE.RAW;
```

Dynamic tables can still wake an auto-resuming warehouse. To freeze their
current snapshots too, generate the suspend commands and execute the returned
statements:

```sql
SHOW DYNAMIC TABLES IN SCHEMA NOCTURNE.RAW;

SELECT
  'ALTER DYNAMIC TABLE NOCTURNE.RAW."' || "name" || '" SUSPEND;'
    AS SUSPEND_COMMAND
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
```

Suspended dynamic tables remain queryable, so their retained data can still be
exported to the dashboard snapshot.

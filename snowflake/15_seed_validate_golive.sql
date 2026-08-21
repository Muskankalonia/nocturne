-- =============================================================================
-- Nocturne Pipeline: Step 15 - Seed, Validate, and Go Live
-- =============================================================================
-- Requires steps 01-14, an accessible GCS stage, and at least one schema-v2
-- crawler part under an organization-partitioned raw/crawls path.
--
-- This script performs no Cortex call directly. It validates and seeds the raw
-- layer while every task is suspended, refreshes the deterministic L1 candidate
-- chain, then resumes the four stream-triggered AI tasks, the deterministic L4
-- incident-discovery task, and ingestion. Once resumed, genuinely missing
-- candidates can be processed asynchronously.
--
-- Snowflake load history skips object names already loaded successfully. GCS
-- objects remain in the bucket because PURGE is intentionally disabled.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE COMPUTE_WH;
USE SCHEMA NOCTURNE.RAW;

-- A failed validation leaves every task suspended. Suspending downstream AI
-- tasks also prevents partially validated data from triggering a paid call.
ALTER TASK NOCTURNE.RAW.CRAWL_INGEST_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.RELATIONSHIP_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.L2_EXTRACTION_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.LEAK_TYPE_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.INCIDENT_INSIGHT_AI_TASK SUSPEND;
ALTER TASK NOCTURNE.RAW.INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK SUSPEND;

-- Confirm that organization-partitioned page parts are visible. Manifests and
-- legacy schema-v1 paths are excluded by this pattern.
LIST @NOCTURNE.RAW.GCS_CRAWL_STAGE
  PATTERN = '.*org_id=[a-z0-9]+(_[a-z0-9]+)*/.*part-[0-9]+[.]jsonl[.]gz';

-- Inspect one real crawler contract without returning raw_text or indicator
-- values. RECORD_ORG_ID must equal the organization extracted from the path.
SELECT
  METADATA$FILENAME AS SOURCE_FILE,
  OBJECT_KEYS($1) AS JSON_KEYS,
  TYPEOF($1:schema_version) AS SCHEMA_VERSION_TYPE,
  TYPEOF($1:org_id) AS ORG_ID_TYPE,
  $1:org_id::STRING AS RECORD_ORG_ID,
  REGEXP_SUBSTR(
    METADATA$FILENAME,
    'org_id=([a-z0-9]+(_[a-z0-9]+)*)',
    1,
    1,
    'e',
    1
  ) AS PATH_ORG_ID,
  TYPEOF($1:fetched_at) AS FETCHED_AT_TYPE,
  TYPEOF($1:keywords_matched) AS KEYWORDS_MATCHED_TYPE,
  TYPEOF($1:links_found) AS LINKS_FOUND_TYPE,
  TYPEOF($1:raw_text) AS RAW_TEXT_TYPE
FROM @NOCTURNE.RAW.GCS_CRAWL_STAGE (
  FILE_FORMAT => 'NOCTURNE.RAW.JSONL_GZ_FORMAT',
  PATTERN => '.*org_id=[a-z0-9]+(_[a-z0-9]+)*/.*part-[0-9]+[.]jsonl[.]gz'
)
LIMIT 1;

-- Seed every schema-v2 crawler object not present in Snowflake load history.
-- This mapping intentionally matches the scheduled COPY in step 02 exactly.
COPY INTO NOCTURNE.RAW.CRAWL_PAGES (
  ORG_ID, DOC_ID, DEDUPE_KEY, RUN_ID, SOURCE, QUERY, URL, TITLE,
  FETCHED_AT, DEPTH, KEYWORDS_MATCHED, LINKS_FOUND,
  CONTENT_LENGTH, CONTENT_SHA256, RAW_TEXT, SCHEMA_VERSION,
  IMAGE_BASE64, CONTENT_TYPE,
  _PATH_ORG_ID, _SOURCE_FILE
)
FROM (
  SELECT
    $1:org_id::STRING,
    $1:doc_id::STRING,
    $1:dedupe_key::STRING,
    $1:run_id::STRING,
    $1:source::STRING,
    $1:query::STRING,
    $1:url::STRING,
    $1:title::STRING,
    $1:fetched_at::TIMESTAMP_TZ,
    $1:depth::NUMBER,
    $1:keywords_matched::ARRAY,
    $1:links_found::NUMBER,
    $1:content_length::NUMBER,
    $1:content_sha256::STRING,
    $1:raw_text::STRING,
    $1:schema_version::NUMBER,
    $1:image_base64::STRING,
    $1:content_type::STRING,
    REGEXP_SUBSTR(
      METADATA$FILENAME,
      'org_id=([a-z0-9]+(_[a-z0-9]+)*)',
      1,
      1,
      'e',
      1
    ),
    METADATA$FILENAME
  FROM @NOCTURNE.RAW.GCS_CRAWL_STAGE
)
FILE_FORMAT = (FORMAT_NAME = 'NOCTURNE.RAW.JSONL_GZ_FORMAT')
PATTERN = '.*org_id=[a-z0-9]+(_[a-z0-9]+)*/.*part-[0-9]+[.]jsonl[.]gz'
ON_ERROR = 'CONTINUE'
-- TODO(production): Grant storage.objects.delete to the Snowflake GCS identity,
-- validate deletion in a non-production prefix, then enable this option.
-- PURGE = TRUE
;

-- Human-readable raw routing summary. No page text is returned.
SELECT
  ORG_ID,
  _PATH_ORG_ID,
  SCHEMA_VERSION,
  COUNT(*) AS RAW_PAGE_COUNT,
  COUNT(DISTINCT DOC_ID) AS DISTINCT_DOC_ID_COUNT,
  COUNT(DISTINCT DEDUPE_KEY) AS DISTINCT_DEDUPE_KEY_COUNT,
  COUNT_IF(_SOURCE_FILE ILIKE '%_manifest.json') AS MANIFEST_ROW_COUNT
FROM NOCTURNE.RAW.CRAWL_PAGES
GROUP BY ORG_ID, _PATH_ORG_ID, SCHEMA_VERSION
ORDER BY ORG_ID, _PATH_ORG_ID, SCHEMA_VERSION;

-- Enforce the organization boundary before any task is resumed. An uncaught
-- exception stops this script and leaves ingestion and every AI task suspended.
EXECUTE IMMEDIATE
$$
DECLARE
  ENABLED_ORG_COUNT NUMBER DEFAULT 0;
  RAW_PAGE_COUNT NUMBER DEFAULT 0;
  INVALID_SCHEMA_COUNT NUMBER DEFAULT 0;
  PATH_MISMATCH_COUNT NUMBER DEFAULT 0;
  UNKNOWN_ORG_COUNT NUMBER DEFAULT 0;
  NO_ENABLED_ORGS EXCEPTION (
    -20001,
    'Go-live blocked: no monitored organization is enabled.'
  );
  NO_RAW_PAGES EXCEPTION (
    -20002,
    'Go-live blocked: no schema-v2 crawler page was loaded from GCS.'
  );
  INVALID_SCHEMA EXCEPTION (
    -20003,
    'Go-live blocked: CRAWL_PAGES contains a schema version other than 2.'
  );
  PATH_MISMATCH EXCEPTION (
    -20004,
    'Go-live blocked: JSON org_id does not match the GCS path org_id.'
  );
  UNKNOWN_ORG EXCEPTION (
    -20005,
    'Go-live blocked: a crawler org_id is unknown or disabled.'
  );
BEGIN
  SELECT COUNT(*)
    INTO :ENABLED_ORG_COUNT
  FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
  WHERE ENABLED;

  SELECT
    COUNT(*),
    COUNT_IF(PAGE.SCHEMA_VERSION <> 2),
    COUNT_IF(PAGE.ORG_ID <> PAGE._PATH_ORG_ID),
    COUNT_IF(ORGANIZATION.ORG_ID IS NULL)
    INTO
      :RAW_PAGE_COUNT,
      :INVALID_SCHEMA_COUNT,
      :PATH_MISMATCH_COUNT,
      :UNKNOWN_ORG_COUNT
  FROM NOCTURNE.RAW.CRAWL_PAGES AS PAGE
  LEFT JOIN NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS ORGANIZATION
    ON ORGANIZATION.ORG_ID = PAGE.ORG_ID
    AND ORGANIZATION.ENABLED = TRUE;

  IF (ENABLED_ORG_COUNT = 0) THEN
    RAISE NO_ENABLED_ORGS;
  END IF;
  IF (RAW_PAGE_COUNT = 0) THEN
    RAISE NO_RAW_PAGES;
  END IF;
  IF (INVALID_SCHEMA_COUNT > 0) THEN
    RAISE INVALID_SCHEMA;
  END IF;
  IF (PATH_MISMATCH_COUNT > 0) THEN
    RAISE PATH_MISMATCH;
  END IF;
  IF (UNKNOWN_ORG_COUNT > 0) THEN
    RAISE UNKNOWN_ORG;
  END IF;

  RETURN OBJECT_CONSTRUCT(
    'status', 'passed',
    'enabled_organizations', ENABLED_ORG_COUNT,
    'raw_pages', RAW_PAGE_COUNT,
    'invalid_schema_rows', INVALID_SCHEMA_COUNT,
    'organization_path_mismatches', PATH_MISMATCH_COUNT,
    'unknown_or_disabled_organization_rows', UNKNOWN_ORG_COUNT
  );
END;
$$;

-- Refresh only deterministic transformations. This can populate the first
-- missing-candidate stream, but it cannot invoke Cortex while tasks are paused.
ALTER DYNAMIC TABLE NOCTURNE.RAW.DT_RELATIONSHIP_AI_CANDIDATES
  REFRESH COPY SESSION;

-- Current caches and missing candidates before go-live. Empty groups are normal
-- on a clean first deployment and these queries never invoke Cortex.
SELECT
  'relationship' AS AI_STAGE,
  ORG_ID,
  STATUS,
  COUNT(*) AS CACHED_RESULT_COUNT
FROM NOCTURNE.RAW.RELATIONSHIP_AI_RESULTS
GROUP BY ORG_ID, STATUS
UNION ALL
SELECT 'l2_extraction', ORG_ID, STATUS, COUNT(*)
FROM NOCTURNE.RAW.L2_EXTRACTION_AI_RESULTS
GROUP BY ORG_ID, STATUS
UNION ALL
SELECT 'leak_type', ORG_ID, STATUS, COUNT(*)
FROM NOCTURNE.RAW.LEAK_TYPE_AI_RESULTS
GROUP BY ORG_ID, STATUS
UNION ALL
SELECT 'incident_insight', ORG_ID, STATUS, COUNT(*)
FROM NOCTURNE.RAW.INCIDENT_INSIGHT_AI_RESULTS
GROUP BY ORG_ID, STATUS
ORDER BY AI_STAGE, ORG_ID, STATUS;

SELECT
  'relationship' AS AI_STAGE,
  ORG_ID,
  COUNT(*) AS MISSING_CANDIDATE_COUNT
FROM NOCTURNE.RAW.DT_RELATIONSHIP_AI_CANDIDATES
GROUP BY ORG_ID
UNION ALL
SELECT 'l2_extraction', ORG_ID, COUNT(*)
FROM NOCTURNE.RAW.DT_L2_EXTRACTION_CANDIDATES
GROUP BY ORG_ID
UNION ALL
SELECT 'leak_type', ORG_ID, COUNT(*)
FROM NOCTURNE.RAW.DT_LEAK_TYPE_AI_CANDIDATES
GROUP BY ORG_ID
UNION ALL
SELECT 'incident_insight', ORG_ID, COUNT(*)
FROM (
  SELECT ORG_ID, INCIDENT_KEY
  FROM NOCTURNE.RAW.VW_INCIDENT_INSIGHT_AI_MISSING_CANDIDATES
  UNION ALL
  SELECT QUEUED.ORG_ID, QUEUED.INCIDENT_KEY
  FROM NOCTURNE.RAW.INCIDENT_INSIGHT_AI_CANDIDATES AS QUEUED
  LEFT JOIN NOCTURNE.RAW.INCIDENT_INSIGHT_AI_RESULTS AS RESULT
    ON RESULT.ORG_ID = QUEUED.ORG_ID
    AND RESULT.INCIDENT_KEY = QUEUED.INCIDENT_KEY
  WHERE RESULT.INCIDENT_KEY IS NULL
) AS INCIDENT_INSIGHT_PENDING
GROUP BY ORG_ID
ORDER BY AI_STAGE, ORG_ID;

-- These metadata results must show incrementally refreshed upstream candidate
-- tables, the persistent incident queue, non-stale streams, and suspended tasks
-- before activation.
SHOW DYNAMIC TABLES IN SCHEMA NOCTURNE.RAW;
SHOW STREAMS IN SCHEMA NOCTURNE.RAW;
SHOW TASKS IN SCHEMA NOCTURNE.RAW;

-- Resume deepest downstream consumers first. They remain idle until their
-- streams contain data; waiting triggered tasks do not keep a warehouse active.
ALTER TASK NOCTURNE.RAW.INCIDENT_INSIGHT_AI_TASK RESUME;
-- The discovery task performs no Cortex call. Its idempotent five-minute MERGE
-- places only new deterministic L4 incidents onto the persistent queue.
ALTER TASK NOCTURNE.RAW.INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK RESUME;
ALTER TASK NOCTURNE.RAW.LEAK_TYPE_AI_TASK RESUME;
ALTER TASK NOCTURNE.RAW.L2_EXTRACTION_AI_TASK RESUME;
ALTER TASK NOCTURNE.RAW.RELATIONSHIP_AI_TASK RESUME;

-- Recurring GCS ingestion is resumed last. During manual testing, suspend this
-- task afterward if five-minute ingestion is not wanted.
ALTER TASK NOCTURNE.RAW.CRAWL_INGEST_TASK RESUME;

-- Final state only. AI work is asynchronous and may take several dynamic-table
-- refresh/task cycles before an incident appears in the dashboard insight view.
SHOW TASKS IN SCHEMA NOCTURNE.RAW;

SELECT
  ORG_ID,
  INSIGHT_AI_STATUS,
  COUNT(*) AS INCIDENT_COUNT
FROM NOCTURNE.RAW.VW_L4_INCIDENT_INSIGHTS
GROUP BY ORG_ID, INSIGHT_AI_STATUS
ORDER BY ORG_ID, INSIGHT_AI_STATUS;

-- =============================================================================
-- Nocturne Pipeline: Step 10 - Seed, Smoke Validate, and Go Live
-- =============================================================================
-- Requires: steps 01-09, an accessible GCS stage, and at least one crawler
-- part-*.jsonl.gz object under the configured raw/crawls prefix.
--
-- This script:
--   1. suspends scheduled ingestion to avoid overlapping with the seed COPY;
--   2. inspects one staged record's contract without returning raw text;
--   3. synchronously loads every new crawler part with ABORT_STATEMENT;
--   4. refreshes the final dynamic table and displays safe smoke results;
--   5. resumes recurring five-minute ingestion.
--
-- Snowflake load history skips object names already loaded successfully, so this
-- file can be rerun. GCS objects remain in the bucket because PURGE is disabled.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE COMPUTE_WH;
USE SCHEMA NOCTURNE.RAW;

-- Prevent the scheduled COPY from overlapping with this synchronous seed load.
ALTER TASK NOCTURNE.RAW.CRAWL_INGEST_TASK SUSPEND;

-- Confirm that crawler page parts are visible. The pattern excludes manifests.
LIST @NOCTURNE.RAW.GCS_CRAWL_STAGE
  PATTERN = '.*part-[0-9]+[.]jsonl[.]gz';

-- Inspect the crawler contract without selecting raw_text or sensitive values.
SELECT
  METADATA$FILENAME AS SOURCE_FILE,
  OBJECT_KEYS($1) AS JSON_KEYS,
  TYPEOF($1:schema_version) AS SCHEMA_VERSION_TYPE,
  TYPEOF($1:fetched_at) AS FETCHED_AT_TYPE,
  TYPEOF($1:keywords_matched) AS KEYWORDS_MATCHED_TYPE,
  TYPEOF($1:links_found) AS LINKS_FOUND_TYPE,
  TYPEOF($1:raw_text) AS RAW_TEXT_TYPE
FROM @NOCTURNE.RAW.GCS_CRAWL_STAGE (
  FILE_FORMAT => 'NOCTURNE.RAW.JSONL_GZ_FORMAT',
  PATTERN => '.*part-[0-9]+[.]jsonl[.]gz'
)
LIMIT 1;

-- Seed all crawler objects that Snowflake has not loaded successfully before.
-- This mapping must remain identical to the scheduled COPY in step 02.
COPY INTO NOCTURNE.RAW.CRAWL_PAGES (
  DOC_ID,
  DEDUPE_KEY,
  RUN_ID,
  SOURCE,
  QUERY,
  URL,
  TITLE,
  FETCHED_AT,
  DEPTH,
  KEYWORDS_MATCHED,
  LINKS_FOUND,
  CONTENT_LENGTH,
  CONTENT_SHA256,
  RAW_TEXT,
  SCHEMA_VERSION,
  _SOURCE_FILE
)
FROM (
  SELECT
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
    METADATA$FILENAME
  FROM @NOCTURNE.RAW.GCS_CRAWL_STAGE
)
FILE_FORMAT = (FORMAT_NAME = 'NOCTURNE.RAW.JSONL_GZ_FORMAT')
PATTERN = '.*part-[0-9]+[.]jsonl[.]gz'
ON_ERROR = 'ABORT_STATEMENT'
-- TODO(production): Grant storage.objects.delete to the Snowflake GCS identity,
-- validate deletion in a non-production prefix, then enable this option.
-- PURGE = TRUE
;

-- Basic raw-layer smoke checks. NOT NULL constraints and ABORT_STATEMENT make
-- malformed required fields fail the COPY instead of being partially accepted.
SELECT
  COUNT(*) AS RAW_PAGE_COUNT,
  COUNT(DISTINCT DOC_ID) AS DISTINCT_DOC_ID_COUNT,
  COUNT(DISTINCT DEDUPE_KEY) AS DISTINCT_DEDUPE_KEY_COUNT,
  COUNT_IF(SCHEMA_VERSION <> 1) AS UNEXPECTED_SCHEMA_VERSION_COUNT,
  COUNT_IF(_SOURCE_FILE ILIKE '%_manifest.json') AS MANIFEST_ROW_COUNT
FROM NOCTURNE.RAW.CRAWL_PAGES;

-- Refreshing the final table refreshes the required upstream dependency chain.
ALTER DYNAMIC TABLE NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
  REFRESH COPY SESSION;

-- Safe end-to-end smoke results: no raw text or exact indicators are returned.
SELECT
  RELATIONSHIP_AI_STATUS,
  RELATIONSHIP_LABEL,
  IS_RELEVANT,
  LEAK_TYPE_AI_STATUS,
  PRELIMINARY_SEVERITY_BAND,
  COUNT(*) AS PAGE_COUNT
FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
GROUP BY
  RELATIONSHIP_AI_STATUS,
  RELATIONSHIP_LABEL,
  IS_RELEVANT,
  LEAK_TYPE_AI_STATUS,
  PRELIMINARY_SEVERITY_BAND
ORDER BY PAGE_COUNT DESC;

-- Go live only after every preceding statement has completed successfully.
ALTER TASK NOCTURNE.RAW.CRAWL_INGEST_TASK RESUME;

SHOW TASKS LIKE 'CRAWL_INGEST_TASK' IN SCHEMA NOCTURNE.RAW;

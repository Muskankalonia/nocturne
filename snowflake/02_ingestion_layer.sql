-- =============================================================================
-- Nocturne Pipeline: Step 2 - GCS Stage and Raw Ingestion
-- =============================================================================
-- Prerequisite: run step 1 and grant its STORAGE_GCP_SERVICE_ACCOUNT
-- bucket-scoped read/list access before running this file.
--
-- The scheduled COPY scans the external stage every five minutes. Snowflake load
-- metadata prevents an object name that was loaded successfully from being loaded
-- again.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

CREATE OR REPLACE FILE FORMAT NOCTURNE.RAW.JSONL_GZ_FORMAT
  TYPE = 'JSON'
  COMPRESSION = 'GZIP'
  STRIP_OUTER_ARRAY = FALSE;

CREATE OR REPLACE STAGE NOCTURNE.RAW.GCS_CRAWL_STAGE
  STORAGE_INTEGRATION = NOCTURNE_GCS_INT
  URL = 'gcs://nocturne-502617-nocturne-raw/raw/crawls/'
  FILE_FORMAT = (FORMAT_NAME = 'NOCTURNE.RAW.JSONL_GZ_FORMAT');

-- Fail here if the Snowflake-generated identity cannot list the bucket.
LIST @NOCTURNE.RAW.GCS_CRAWL_STAGE
  PATTERN = '.*part-[0-9]+[.]jsonl[.]gz';

-- Inspect one real crawler record without returning raw text or indicator values.
-- Expected types are INTEGER, VARCHAR, ARRAY, INTEGER, and VARCHAR respectively.
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

-- One typed row per JSONL page record. NOT NULL constraints turn missing crawler
-- fields into load failures instead of silently accepting incomplete records.
CREATE TABLE IF NOT EXISTS NOCTURNE.RAW.CRAWL_PAGES (
  DOC_ID STRING NOT NULL,
  DEDUPE_KEY STRING NOT NULL,
  RUN_ID STRING NOT NULL,
  SOURCE STRING NOT NULL,
  QUERY STRING NOT NULL,
  URL STRING NOT NULL,
  TITLE STRING NOT NULL,
  FETCHED_AT TIMESTAMP_TZ NOT NULL,
  DEPTH NUMBER NOT NULL,
  KEYWORDS_MATCHED ARRAY NOT NULL,
  LINKS_FOUND NUMBER NOT NULL,
  CONTENT_LENGTH NUMBER NOT NULL,
  CONTENT_SHA256 STRING NOT NULL,
  RAW_TEXT STRING NOT NULL,
  SCHEMA_VERSION NUMBER NOT NULL,
  _SOURCE_FILE STRING NOT NULL,
  _INGESTED_AT TIMESTAMP_TZ NOT NULL DEFAULT CURRENT_TIMESTAMP()
);

ALTER TABLE NOCTURNE.RAW.CRAWL_PAGES SET CHANGE_TRACKING = TRUE;

CREATE OR REPLACE TASK NOCTURNE.RAW.CRAWL_INGEST_TASK
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = '5 MINUTE'
AS
  COPY INTO NOCTURNE.RAW.CRAWL_PAGES (
    DOC_ID, DEDUPE_KEY, RUN_ID, SOURCE, QUERY, URL, TITLE,
    FETCHED_AT, DEPTH, KEYWORDS_MATCHED, LINKS_FOUND,
    CONTENT_LENGTH, CONTENT_SHA256, RAW_TEXT, SCHEMA_VERSION, _SOURCE_FILE
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

-- Tasks are created suspended. Step 7 seeds and validates existing files before
-- resuming this task for ongoing five-minute ingestion.

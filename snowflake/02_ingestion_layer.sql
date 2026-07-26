-- =============================================================================
-- Nocturne Pipeline: Step 2 - Raw Ingestion Layer (Table + Stream + Task)
-- =============================================================================
-- The stream detects new .jsonl.gz files on the GCS stage.
-- The task fires every 5 minutes (only when the stream has data) and runs
-- COPY INTO to parse each JSON line into a typed row.
-- =============================================================================

USE SCHEMA NOCTURNE.RAW;

-- Raw pages table: one row per crawled dark web page
CREATE TABLE IF NOT EXISTS NOCTURNE.RAW.CRAWL_PAGES (
  DOC_ID STRING,
  DEDUPE_KEY STRING,
  RUN_ID STRING,
  SOURCE STRING,
  QUERY STRING,
  URL STRING,
  TITLE STRING,
  FETCH_TIMESTAMP TIMESTAMP_NTZ,
  DEPTH NUMBER,
  MATCHED_KEYWORDS ARRAY,
  LINK_COUNT NUMBER,
  CONTENT_LENGTH NUMBER,
  CONTENT_SHA256 STRING,
  RAW_TEXT STRING,
  SCHEMA_VERSION STRING,
  _SOURCE_FILE STRING,
  _INGESTED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Enable change tracking so downstream dynamic tables can refresh incrementally
ALTER TABLE NOCTURNE.RAW.CRAWL_PAGES SET CHANGE_TRACKING = TRUE;

-- Stream on stage: captures new file arrivals
CREATE OR REPLACE STREAM NOCTURNE.RAW.CRAWL_STAGE_STREAM
  ON STAGE NOCTURNE.RAW.GCS_CRAWL_STAGE;

-- Ingestion task: parses .jsonl.gz and loads into CRAWL_PAGES
CREATE OR REPLACE TASK NOCTURNE.RAW.CRAWL_INGEST_TASK
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = '5 MINUTE'
  WHEN SYSTEM$STREAM_HAS_DATA('NOCTURNE.RAW.CRAWL_STAGE_STREAM')
AS
  COPY INTO NOCTURNE.RAW.CRAWL_PAGES (
    DOC_ID, DEDUPE_KEY, RUN_ID, SOURCE, QUERY, URL, TITLE,
    FETCH_TIMESTAMP, DEPTH, MATCHED_KEYWORDS, LINK_COUNT,
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
      $1:fetch_timestamp::TIMESTAMP_NTZ,
      $1:depth::NUMBER,
      $1:matched_keywords::ARRAY,
      $1:link_count::NUMBER,
      $1:content_length::NUMBER,
      $1:content_sha256::STRING,
      $1:raw_text::STRING,
      $1:schema_version::STRING,
      METADATA$FILENAME
    FROM @NOCTURNE.RAW.GCS_CRAWL_STAGE
  )
  FILE_FORMAT = (TYPE = 'JSON' COMPRESSION = 'GZIP')
  PATTERN = '.*part-.*\\.jsonl\\.gz'
  ON_ERROR = 'CONTINUE';

-- Task starts SUSPENDED. Resume after verifying the pipeline end-to-end.
-- ALTER TASK NOCTURNE.RAW.CRAWL_INGEST_TASK RESUME;

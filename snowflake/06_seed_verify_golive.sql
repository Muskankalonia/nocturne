-- =============================================================================
-- Nocturne Pipeline: Step 6 - Seed Backlog, Verify & Go Live
-- =============================================================================
-- Run this AFTER steps 1-5 are created. Seeds existing files, verifies the
-- pipeline is working end-to-end, then resumes the task for ongoing ingestion.
-- =============================================================================

USE SCHEMA NOCTURNE.RAW;

-- 1. Seed existing files into CRAWL_PAGES (stream only captures future arrivals)
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

-- 2. Verify dynamic tables refreshed and have data
SELECT COUNT(*) AS total_rows FROM NOCTURNE.RAW.DT_REGEX_INDICATORS;
SELECT COUNT(*) AS total_rows, COUNT(CASE WHEN INDICATORS_FOUND != '' THEN 1 END) AS with_indicators
FROM NOCTURNE.RAW.DT_REGEX_INDICATORS;

-- 3. Verify classification results
SELECT CATEGORY, COUNT(*) AS cnt
FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
GROUP BY CATEGORY
ORDER BY cnt DESC;

-- 4. Check dynamic tables are INCREMENTAL and ACTIVE
SHOW DYNAMIC TABLES IN SCHEMA NOCTURNE.RAW;

-- 5. Check stream exists
SHOW STREAMS IN SCHEMA NOCTURNE.RAW;

-- 6. Resume the ingest task for ongoing processing
ALTER TASK NOCTURNE.RAW.CRAWL_INGEST_TASK RESUME;

-- 7. Confirm task is running
SHOW TASKS IN SCHEMA NOCTURNE.RAW;

-- =============================================================================
-- Nocturne Pipeline: Step 5 - Layer 0 Indicator Enrichment
-- =============================================================================
-- Evaluates the deterministic indicator UDF exactly once per page and stores its
-- structured VARIANT. Layer 1 reads summary_text and score fields from that
-- result instead of rerunning the UDF.
--
-- RAW_TEXT remains byte-for-byte unchanged. Exact sensitive matches are kept in
-- INDICATORS_FOUND for controlled analysis, but are never appended to RAW_TEXT
-- or copied into the bounded Cortex classification prompt.
--
-- REFRESH_MODE = INCREMENTAL processes only source-table changes.
-- TARGET_LAG = DOWNSTREAM lets the 30-minute Layer 1 table drive refresh timing.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_REGEX_INDICATORS
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = 'DOWNSTREAM'
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  SELECT
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
    _SOURCE_FILE,
    _INGESTED_AT,
    NOCTURNE.RAW.DETECT_INDICATORS(RAW_TEXT) AS INDICATORS_FOUND
  FROM NOCTURNE.RAW.CRAWL_PAGES;

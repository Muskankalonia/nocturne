-- =============================================================================
-- Nocturne Pipeline: Step 4 - Layer 0: Regex Enrichment Dynamic Table
-- =============================================================================
-- Reads from CRAWL_PAGES, runs DETECT_INDICATORS on raw_text, and produces
-- ENRICHED_TEXT with matched indicators appended for downstream AI classification.
--
-- REFRESH_MODE = INCREMENTAL: only processes new rows, not the full table.
-- TARGET_LAG = DOWNSTREAM: refreshes only when Layer 1 (classification) needs it.
-- =============================================================================

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
    URL,
    TITLE,
    RAW_TEXT,
    MATCHED_KEYWORDS,
    CONTENT_LENGTH,
    _SOURCE_FILE,
    _INGESTED_AT,
    NOCTURNE.RAW.DETECT_INDICATORS(RAW_TEXT) AS INDICATORS_FOUND,
    CASE WHEN NOCTURNE.RAW.DETECT_INDICATORS(RAW_TEXT) != ''
      THEN RAW_TEXT || '\n\n--- DETECTED INDICATORS ---\n' || NOCTURNE.RAW.DETECT_INDICATORS(RAW_TEXT)
      ELSE RAW_TEXT
    END AS ENRICHED_TEXT
  FROM NOCTURNE.RAW.CRAWL_PAGES;

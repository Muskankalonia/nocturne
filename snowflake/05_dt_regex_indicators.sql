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
-- Organization routing is validated before the indicator UDF runs. Invalid rows
-- remain in CRAWL_PAGES for diagnosis but cannot enter L0 or any AI stage.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

-- DT_REGEX_INDICATORS now depends on the organization configuration directly.
ALTER TABLE NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
  SET CHANGE_TRACKING = TRUE;

CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_REGEX_INDICATORS
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = 'DOWNSTREAM'
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  SELECT
    PAGE.ORG_ID,
    PAGE.DOC_ID,
    PAGE.DEDUPE_KEY,
    PAGE.RUN_ID,
    PAGE.SOURCE,
    PAGE.QUERY,
    PAGE.URL,
    PAGE.TITLE,
    PAGE.FETCHED_AT,
    PAGE.DEPTH,
    PAGE.KEYWORDS_MATCHED,
    PAGE.LINKS_FOUND,
    PAGE.CONTENT_LENGTH,
    PAGE.CONTENT_SHA256,
    PAGE.RAW_TEXT,
    PAGE.SCHEMA_VERSION,
    PAGE._PATH_ORG_ID,
    PAGE._SOURCE_FILE,
    PAGE._INGESTED_AT,
    NOCTURNE.RAW.DETECT_INDICATORS(PAGE.RAW_TEXT) AS INDICATORS_FOUND
  FROM NOCTURNE.RAW.DT_IMAGE_TEXT_EXTRACTION AS PAGE
  INNER JOIN NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS ORGANIZATION
    ON ORGANIZATION.ORG_ID = PAGE.ORG_ID
    AND ORGANIZATION.ENABLED = TRUE
  WHERE PAGE.ORG_ID = PAGE._PATH_ORG_ID;

-- Safe routing check; no raw text or indicator values are returned.
-- SELECT
--   COUNT_IF(PAGE.SCHEMA_VERSION <> 2) AS LEGACY_SCHEMA_ROWS,
--   COUNT_IF(PAGE.ORG_ID <> PAGE._PATH_ORG_ID) AS PATH_MISMATCH_ROWS,
--   COUNT_IF(CONFIG.ORG_ID IS NULL) AS UNKNOWN_OR_DISABLED_ORG_ROWS
-- FROM NOCTURNE.RAW.CRAWL_PAGES AS PAGE
-- LEFT JOIN NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS CONFIG
--   ON CONFIG.ORG_ID = PAGE.ORG_ID
--   AND CONFIG.ENABLED = TRUE;

-- =============================================================================
-- Nocturne Pipeline: Step 7 - Materialized L1 Classification Input
-- =============================================================================
-- Produces one bounded, auditable Cortex input per unique page for exactly the
-- organization assigned by the crawler. No page is evaluated against every
-- enabled organization.
--
-- Two dynamic tables deliberately separate the single prompt-builder invocation
-- from projection of its returned fields. This guarantees the JavaScript UDF is
-- materialized once per DEDUPE_KEY/ORG_ID instead of being repeated for every
-- output field.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

-- Incremental dynamic tables require change tracking on base tables. ACCOUNTADMIN
-- owns this configuration table in the hackathon deployment, so make the
-- dependency explicit rather than relying on automatic enablement.
ALTER TABLE NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
  SET CHANGE_TRACKING = TRUE;

-- Select one stable representative within each organization, join only its
-- configured target profile, and invoke the input builder exactly once.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L1_INPUT_BUILD
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  WITH DEDUPED_PAGES AS (
    SELECT
      ORG_ID,
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
      _PATH_ORG_ID,
      _SOURCE_FILE,
      _INGESTED_AT,
      INDICATORS_FOUND
    FROM NOCTURNE.RAW.DT_REGEX_INDICATORS
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY ORG_ID, DEDUPE_KEY
      ORDER BY FETCHED_AT ASC, _INGESTED_AT ASC, DOC_ID ASC
    ) = 1
  )
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
    PAGE.SCHEMA_VERSION,
    PAGE._PATH_ORG_ID,
    PAGE._SOURCE_FILE,
    PAGE._INGESTED_AT,
    ORGANIZATION.CANONICAL_NAME,
    ORGANIZATION.ALIASES,
    ORGANIZATION.DOMAINS,
    ORGANIZATION.PRODUCTS,
    ORGANIZATION.UPDATED_AT AS ORGANIZATION_UPDATED_AT,
    PAGE.INDICATORS_FOUND:summary_text::STRING AS INDICATOR_SUMMARY,
    PAGE.INDICATORS_FOUND:strong_count::NUMBER AS STRONG_INDICATOR_COUNT,
    PAGE.INDICATORS_FOUND:medium_count::NUMBER AS MEDIUM_INDICATOR_COUNT,
    PAGE.INDICATORS_FOUND:weak_count::NUMBER AS WEAK_INDICATOR_COUNT,
    PAGE.INDICATORS_FOUND:evidence_score::NUMBER AS EVIDENCE_SCORE,
    NOCTURNE.RAW.BUILD_CLASSIFICATION_INPUT(
      PAGE.RAW_TEXT,
      PAGE.TITLE,
      PAGE.INDICATORS_FOUND,
      ORGANIZATION.CANONICAL_NAME,
      ORGANIZATION.ALIASES,
      ORGANIZATION.DOMAINS,
      ORGANIZATION.PRODUCTS
    ) AS INPUT_BUILD_RESULT
  FROM DEDUPED_PAGES AS PAGE
  INNER JOIN NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS ORGANIZATION
    ON ORGANIZATION.ORG_ID = PAGE.ORG_ID
    AND ORGANIZATION.ENABLED = TRUE;

-- Project the stored builder result into typed, queryable columns. This table is
-- what the relationship classifier consumes; it never needs RAW_TEXT.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L1_CLASSIFICATION_INPUT
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  SELECT
    ORG_ID,
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
    SCHEMA_VERSION,
    _PATH_ORG_ID,
    _SOURCE_FILE,
    _INGESTED_AT,
    CANONICAL_NAME,
    ALIASES,
    DOMAINS,
    PRODUCTS,
    ORGANIZATION_UPDATED_AT,
    INDICATOR_SUMMARY,
    STRONG_INDICATOR_COUNT,
    MEDIUM_INDICATOR_COUNT,
    WEAK_INDICATOR_COUNT,
    EVIDENCE_SCORE,
    INPUT_BUILD_RESULT:classification_input::STRING
      AS CLASSIFICATION_INPUT,
    INPUT_BUILD_RESULT:classification_input_length::NUMBER
      AS CLASSIFICATION_INPUT_LENGTH,
    INPUT_BUILD_RESULT:evidence_input::STRING
      AS EVIDENCE_INPUT,
    INPUT_BUILD_RESULT:evidence_input_length::NUMBER
      AS EVIDENCE_INPUT_LENGTH,
    INPUT_BUILD_RESULT:evidence_input_truncated::BOOLEAN
      AS EVIDENCE_INPUT_TRUNCATED,
    INPUT_BUILD_RESULT:source_text_length::NUMBER
      AS SOURCE_TEXT_LENGTH,
    INPUT_BUILD_RESULT:input_truncated::BOOLEAN
      AS INPUT_TRUNCATED,
    INPUT_BUILD_RESULT:input_method_version::STRING
      AS INPUT_METHOD_VERSION,
    INPUT_BUILD_RESULT:fallback_used::BOOLEAN
      AS FALLBACK_USED,
    INPUT_BUILD_RESULT:fallback_reason::STRING
      AS FALLBACK_REASON,
    INPUT_BUILD_RESULT:builder_error::STRING
      AS BUILDER_ERROR,
    INPUT_BUILD_RESULT:target_match_score::NUMBER
      AS TARGET_MATCH_SCORE,
    INPUT_BUILD_RESULT:target_anchor_type::STRING
      AS TARGET_ANCHOR_TYPE,
    INPUT_BUILD_RESULT:target_anchors::ARRAY
      AS TARGET_ANCHORS,
    INPUT_BUILD_RESULT:target_anchors_truncated::BOOLEAN
      AS TARGET_ANCHORS_TRUNCATED,
    INPUT_BUILD_RESULT:selected_windows::ARRAY
      AS SELECTED_WINDOWS,
    INPUT_BUILD_RESULT:signal_matches_scanned::NUMBER
      AS SIGNAL_MATCHES_SCANNED,
    INPUT_BUILD_RESULT:target_matches_scanned::NUMBER
      AS TARGET_MATCHES_SCANNED,
    INPUT_BUILD_RESULT:leak_matches_scanned::NUMBER
      AS LEAK_MATCHES_SCANNED,
    INPUT_BUILD_RESULT:signal_scan_truncated::BOOLEAN
      AS SIGNAL_SCAN_TRUNCATED,
    INPUT_BUILD_RESULT:indicator_spans_reused::NUMBER
      AS INDICATOR_SPANS_REUSED
  FROM NOCTURNE.RAW.DT_L1_INPUT_BUILD;

-- Safe operational checks; these never display page text or exact indicators.
-- SELECT COUNT(*) AS DUPLICATE_INPUTS
-- FROM (
--   SELECT ORG_ID, DEDUPE_KEY
--   FROM NOCTURNE.RAW.DT_L1_CLASSIFICATION_INPUT
--   GROUP BY ORG_ID, DEDUPE_KEY
--   HAVING COUNT(*) > 1
-- );
--
-- SELECT
--   INPUT_METHOD_VERSION,
--   FALLBACK_USED,
--   COUNT(*) AS PAGE_COUNT,
--   MAX(CLASSIFICATION_INPUT_LENGTH) AS MAX_INPUT_LENGTH,
--   MAX(EVIDENCE_INPUT_LENGTH) AS MAX_EVIDENCE_INPUT_LENGTH,
--   COUNT_IF(BUILDER_ERROR IS NOT NULL) AS BUILDER_ERROR_COUNT
-- FROM NOCTURNE.RAW.DT_L1_CLASSIFICATION_INPUT
-- GROUP BY INPUT_METHOD_VERSION, FALLBACK_USED;

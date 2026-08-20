-- =============================================================================
-- Nocturne Pipeline: Step 4b - Image Text Extraction (Vision OCR)
-- =============================================================================
-- For manually uploaded images, extracts visible text using Cortex AI_EXTRACT
-- with the base64-encoded image data stored in CRAWL_PAGES.IMAGE_BASE64.
--
-- Text-only uploads (IMAGE_BASE64 IS NULL) pass through unchanged.
-- Image uploads get their RAW_TEXT replaced with the AI-extracted content.
--
-- This DT sits between CRAWL_PAGES and DT_REGEX_INDICATORS, so the rest of
-- the pipeline consumes extracted text regardless of upload format.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_IMAGE_TEXT_EXTRACTION
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = 'DOWNSTREAM'
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
    CASE
      WHEN IMAGE_BASE64 IS NOT NULL THEN
        COALESCE(
          AI_EXTRACT(
            file_data => BASE64_DECODE_BINARY(IMAGE_BASE64),
            responseFormat => {'extracted_text': 'Extract all visible text from this image verbatim. Return only the raw text, preserving line breaks and formatting.'}
          ):extracted_text::STRING,
          '[image extraction failed]'
        )
      ELSE RAW_TEXT
    END AS RAW_TEXT,
    SCHEMA_VERSION,
    CONTENT_TYPE,
    _PATH_ORG_ID,
    _SOURCE_FILE,
    _INGESTED_AT
  FROM NOCTURNE.RAW.CRAWL_PAGES
  WHERE SCHEMA_VERSION = 2;

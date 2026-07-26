-- =============================================================================
-- Nocturne Pipeline: Useful Queries
-- =============================================================================

USE SCHEMA NOCTURNE.RAW;

-- Classification distribution
SELECT CATEGORY, COUNT(*) AS cnt
FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
GROUP BY CATEGORY
ORDER BY cnt DESC;

-- Pages with detected indicators
SELECT DOC_ID, TITLE, URL, INDICATORS_FOUND, CATEGORY
FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
WHERE INDICATORS_FOUND != ''
ORDER BY _INGESTED_AT DESC;

-- Malware and violation pages only
SELECT TITLE, URL, CATEGORY, INDICATORS_FOUND
FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
WHERE CATEGORY IN ('malware', 'violation')
ORDER BY _INGESTED_AT DESC;

-- Recent ingestion activity
SELECT _SOURCE_FILE, COUNT(*) AS pages, MIN(_INGESTED_AT) AS ingested_at
FROM NOCTURNE.RAW.CRAWL_PAGES
GROUP BY _SOURCE_FILE
ORDER BY ingested_at DESC;

-- Deduplicated latest pages (use DEDUPE_KEY for cross-run uniqueness)
SELECT *
FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
QUALIFY ROW_NUMBER() OVER (PARTITION BY DEDUPE_KEY ORDER BY _INGESTED_AT DESC) = 1;

-- Pipeline health check
SHOW DYNAMIC TABLES IN SCHEMA NOCTURNE.RAW;
SHOW STREAMS IN SCHEMA NOCTURNE.RAW;
SHOW TASKS IN SCHEMA NOCTURNE.RAW;

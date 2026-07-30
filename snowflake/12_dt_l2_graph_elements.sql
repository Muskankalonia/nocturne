-- =============================================================================
-- Nocturne Pipeline: Step 12 - L2 Grounding and Graph Elements
-- =============================================================================
-- Parses the step 11 extraction, verifies every quote against the source text,
-- and flattens the result into claim, entity, and edge rows.
--
-- Grounding is the core of this step. POSITION() locates each evidence_text in
-- the exact string the model was shown. A hit yields exact character offsets; a
-- miss proves the model fabricated the quote, and the row is retained with
-- IS_GROUNDED = FALSE so it can be measured and excluded rather than silently
-- displayed. Grounding rate is a reportable quality metric, not a side effect.
--
-- Entity NODE_KEY is a deterministic hash of type and normalized name. That
-- single expression is the cross-document entity resolution: the same actor
-- alias seen on three marketplaces collapses to one node with no clustering
-- step and no similarity threshold to tune.
--
-- REFRESH_MODE is AUTO from here on. These queries use LATERAL FLATTEN, joins
-- across dynamic tables, and aggregates; AUTO lets Snowflake choose incremental
-- where it can and fall back to full refresh instead of failing at CREATE time.
-- At this data volume a full refresh costs seconds. Step 11 stays INCREMENTAL
-- because that is what stops Cortex being re-invoked on every refresh.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

-- Shared by steps 12 and 13 so the graph and the monitored-organization config
-- are always normalized identically. A mismatch here silently splits one real
-- entity into two nodes, which is the most damaging failure mode in the layer.
CREATE OR REPLACE FUNCTION NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(RAW_NAME STRING)
RETURNS STRING
LANGUAGE SQL
IMMUTABLE
AS
$$
  TRIM(
    REGEXP_REPLACE(
      TRIM(
        REGEXP_REPLACE(
          LOWER(REGEXP_REPLACE(COALESCE(RAW_NAME, ''), '[^a-zA-Z0-9]+', ' ')),
          ' +',
          ' '
        )
      ),
      ' (inc|ltd|llc|plc|corp|corporation|company|limited|gmbh|pvt)$',
      ''
    )
  )
$$;

-- -----------------------------------------------------------------------------
-- Parse the structured response once.
-- -----------------------------------------------------------------------------
-- AI_COMPLETE with response_format returns a JSON string, so it is parsed here
-- and never re-parsed downstream.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_EXTRACTION
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH PARSED AS (
    SELECT
      DOC_ID,
      DEDUPE_KEY,
      ORG_ID,
      RELATIONSHIP_LABEL,
      FETCHED_AT,
      CANONICAL_NAME,
      EXTRACTION_TEXT,
      EXTRACTION_AI_RESULT,
      TRY_PARSE_JSON(EXTRACTION_AI_RESULT::STRING) AS EXTRACTION
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION_AI
  )
  SELECT
    *,
    CASE
      WHEN EXTRACTION_AI_RESULT IS NULL THEN 'error'
      WHEN EXTRACTION IS NULL THEN 'invalid_response'
      WHEN EXTRACTION:entities IS NULL
        OR EXTRACTION:claims IS NULL
        OR EXTRACTION:relationships IS NULL THEN 'invalid_response'
      ELSE 'success'
    END AS EXTRACTION_STATUS,
    ARRAY_SIZE(COALESCE(EXTRACTION:claims, ARRAY_CONSTRUCT()))
      AS CLAIM_COUNT_RAW,
    ARRAY_SIZE(COALESCE(EXTRACTION:entities, ARRAY_CONSTRUCT()))
      AS ENTITY_COUNT_RAW,
    'ai_complete_extraction_v1' AS EXTRACTION_METHOD_VERSION
  FROM PARSED;

-- -----------------------------------------------------------------------------
-- Claims, with offsets computed rather than generated.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_CLAIMS
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH FLATTENED AS (
    SELECT
      EXTRACTION.DOC_ID,
      EXTRACTION.DEDUPE_KEY,
      EXTRACTION.ORG_ID,
      EXTRACTION.FETCHED_AT,
      EXTRACTION.EXTRACTION_TEXT,
      CLAIM.VALUE:id::STRING AS CLAIM_LOCAL_ID,
      CLAIM.VALUE:statement::STRING AS STATEMENT,
      CLAIM.VALUE:claim_status::STRING AS CLAIM_STATUS_EXTRACTED,
      CLAIM.VALUE:quantity_claimed::NUMBER AS QUANTITY_CLAIMED,
      CLAIM.VALUE:evidence_text::STRING AS EVIDENCE_TEXT
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION AS EXTRACTION,
      LATERAL FLATTEN(input => EXTRACTION.EXTRACTION:claims) AS CLAIM
    WHERE EXTRACTION.EXTRACTION_STATUS = 'success'
  ),
  LOCATED AS (
    SELECT
      *,
      -- POSITION is 1-based and returns 0 when absent. An empty quote would
      -- match at position 1 and count as grounded, so it is excluded first.
      CASE
        WHEN EVIDENCE_TEXT IS NULL OR LENGTH(EVIDENCE_TEXT) = 0 THEN 0
        ELSE POSITION(EVIDENCE_TEXT, EXTRACTION_TEXT)
      END AS EVIDENCE_POSITION
    FROM FLATTENED
  )
  SELECT
    DOC_ID,
    DEDUPE_KEY,
    ORG_ID,
    FETCHED_AT,
    CLAIM_LOCAL_ID,
    STATEMENT,
    CLAIM_STATUS_EXTRACTED,
    EVIDENCE_TEXT,
    CASE WHEN EVIDENCE_POSITION > 0
      THEN EVIDENCE_POSITION - 1
    END AS EVIDENCE_START,
    CASE WHEN EVIDENCE_POSITION > 0
      THEN EVIDENCE_POSITION - 1 + LENGTH(EVIDENCE_TEXT)
    END AS EVIDENCE_END,
    EVIDENCE_POSITION > 0 AS IS_GROUNDED,
    -- An ungrounded quantity is a number the model invented. Severity must not
    -- be inflated by one, so it is dropped at the source rather than filtered
    -- in every downstream consumer.
    CASE WHEN EVIDENCE_POSITION > 0
      THEN QUANTITY_CLAIMED
    END AS QUANTITY_CLAIMED,
    SHA2(DEDUPE_KEY || '|' || ORG_ID || '|' || CLAIM_LOCAL_ID) AS CLAIM_KEY,
    'grounded_offsets_v1' AS GROUNDING_METHOD_VERSION
  FROM LOCATED;

-- -----------------------------------------------------------------------------
-- Entities, with the deterministic node key that resolves them across documents.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_ENTITIES
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH FLATTENED AS (
    SELECT
      EXTRACTION.DOC_ID,
      EXTRACTION.DEDUPE_KEY,
      EXTRACTION.ORG_ID,
      EXTRACTION.FETCHED_AT,
      EXTRACTION.EXTRACTION_TEXT,
      ENTITY.VALUE:id::STRING AS ENTITY_LOCAL_ID,
      ENTITY.VALUE:type::STRING AS ENTITY_TYPE,
      ENTITY.VALUE:name::STRING AS ENTITY_NAME,
      ENTITY.VALUE:evidence_text::STRING AS EVIDENCE_TEXT
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION AS EXTRACTION,
      LATERAL FLATTEN(input => EXTRACTION.EXTRACTION:entities) AS ENTITY
    WHERE EXTRACTION.EXTRACTION_STATUS = 'success'
  ),
  LOCATED AS (
    SELECT
      *,
      NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(ENTITY_NAME) AS NORMALIZED_NAME,
      CASE
        WHEN EVIDENCE_TEXT IS NULL OR LENGTH(EVIDENCE_TEXT) = 0 THEN 0
        ELSE POSITION(EVIDENCE_TEXT, EXTRACTION_TEXT)
      END AS EVIDENCE_POSITION
    FROM FLATTENED
  ),
  -- Every name the monitored organization is known by, normalized identically
  -- to the extracted entities so the comparison is exact rather than fuzzy.
  MONITORED_NAMES AS (
    SELECT
      ORG_ID,
      NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(CANONICAL_NAME) AS NORMALIZED_NAME
    FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
    WHERE ENABLED = TRUE
    UNION
    SELECT
      ORGANIZATION.ORG_ID,
      NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(ALIAS.VALUE::STRING)
    FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS ORGANIZATION,
      LATERAL FLATTEN(input => ORGANIZATION.ALIASES) AS ALIAS
    WHERE ORGANIZATION.ENABLED = TRUE
  )
  SELECT
    LOCATED.DOC_ID,
    LOCATED.DEDUPE_KEY,
    LOCATED.ORG_ID,
    LOCATED.FETCHED_AT,
    LOCATED.ENTITY_LOCAL_ID,
    LOCATED.ENTITY_TYPE,
    LOCATED.ENTITY_NAME,
    LOCATED.NORMALIZED_NAME,
    LOCATED.EVIDENCE_TEXT,
    CASE WHEN LOCATED.EVIDENCE_POSITION > 0
      THEN LOCATED.EVIDENCE_POSITION - 1
    END AS EVIDENCE_START,
    CASE WHEN LOCATED.EVIDENCE_POSITION > 0
      THEN LOCATED.EVIDENCE_POSITION - 1 + LENGTH(LOCATED.EVIDENCE_TEXT)
    END AS EVIDENCE_END,
    LOCATED.EVIDENCE_POSITION > 0 AS IS_GROUNDED,
    -- The graph-side confirmation of L1's regex anchors: the extraction model
    -- independently named an organization that resolves to the monitored one.
    LOCATED.ENTITY_TYPE = 'organization'
      AND MONITORED.NORMALIZED_NAME IS NOT NULL AS IS_MONITORED_ORG,
    SHA2(LOCATED.ENTITY_TYPE || '|' || LOCATED.NORMALIZED_NAME) AS NODE_KEY
  FROM LOCATED
  LEFT JOIN MONITORED_NAMES AS MONITORED
    ON MONITORED.ORG_ID = LOCATED.ORG_ID
    AND MONITORED.NORMALIZED_NAME = LOCATED.NORMALIZED_NAME
  WHERE LOCATED.NORMALIZED_NAME <> '';

-- -----------------------------------------------------------------------------
-- Edges, with document-local ids resolved to global keys.
-- -----------------------------------------------------------------------------
-- The model emits ids scoped to one document (entity_1, claim_2). The id prefix
-- says which side to resolve against. Edges whose endpoints do not resolve are
-- dropped: that is the model referencing an id it never emitted.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_EDGES
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH FLATTENED AS (
    SELECT
      EXTRACTION.DOC_ID,
      EXTRACTION.DEDUPE_KEY,
      EXTRACTION.ORG_ID,
      EXTRACTION.FETCHED_AT,
      EXTRACTION.EXTRACTION_TEXT,
      EDGE.VALUE:source::STRING AS SOURCE_LOCAL_ID,
      EDGE.VALUE:type::STRING AS EDGE_TYPE,
      EDGE.VALUE:target::STRING AS TARGET_LOCAL_ID,
      EDGE.VALUE:evidence_text::STRING AS EVIDENCE_TEXT
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION AS EXTRACTION,
      LATERAL FLATTEN(input => EXTRACTION.EXTRACTION:relationships) AS EDGE
    WHERE EXTRACTION.EXTRACTION_STATUS = 'success'
  ),
  RESOLVED AS (
    SELECT
      FLATTENED.DOC_ID,
      FLATTENED.DEDUPE_KEY,
      FLATTENED.ORG_ID,
      FLATTENED.FETCHED_AT,
      FLATTENED.EDGE_TYPE,
      FLATTENED.SOURCE_LOCAL_ID,
      FLATTENED.TARGET_LOCAL_ID,
      FLATTENED.EVIDENCE_TEXT,
      SPLIT_PART(FLATTENED.SOURCE_LOCAL_ID, '_', 1) AS SOURCE_KIND,
      SPLIT_PART(FLATTENED.TARGET_LOCAL_ID, '_', 1) AS TARGET_KIND,
      COALESCE(SOURCE_ENTITY.NODE_KEY, SOURCE_CLAIM.CLAIM_KEY) AS SOURCE_KEY,
      COALESCE(TARGET_ENTITY.NODE_KEY, TARGET_CLAIM.CLAIM_KEY) AS TARGET_KEY,
      SOURCE_ENTITY.ENTITY_TYPE AS SOURCE_ENTITY_TYPE,
      TARGET_ENTITY.ENTITY_TYPE AS TARGET_ENTITY_TYPE,
      TARGET_ENTITY.IS_MONITORED_ORG AS TARGET_IS_MONITORED_ORG,
      CASE
        WHEN FLATTENED.EVIDENCE_TEXT IS NULL
          OR LENGTH(FLATTENED.EVIDENCE_TEXT) = 0 THEN 0
        ELSE POSITION(FLATTENED.EVIDENCE_TEXT, FLATTENED.EXTRACTION_TEXT)
      END AS EVIDENCE_POSITION
    FROM FLATTENED
    LEFT JOIN NOCTURNE.RAW.DT_L2_ENTITIES AS SOURCE_ENTITY
      ON SOURCE_ENTITY.DEDUPE_KEY = FLATTENED.DEDUPE_KEY
      AND SOURCE_ENTITY.ORG_ID = FLATTENED.ORG_ID
      AND SOURCE_ENTITY.ENTITY_LOCAL_ID = FLATTENED.SOURCE_LOCAL_ID
    LEFT JOIN NOCTURNE.RAW.DT_L2_CLAIMS AS SOURCE_CLAIM
      ON SOURCE_CLAIM.DEDUPE_KEY = FLATTENED.DEDUPE_KEY
      AND SOURCE_CLAIM.ORG_ID = FLATTENED.ORG_ID
      AND SOURCE_CLAIM.CLAIM_LOCAL_ID = FLATTENED.SOURCE_LOCAL_ID
    LEFT JOIN NOCTURNE.RAW.DT_L2_ENTITIES AS TARGET_ENTITY
      ON TARGET_ENTITY.DEDUPE_KEY = FLATTENED.DEDUPE_KEY
      AND TARGET_ENTITY.ORG_ID = FLATTENED.ORG_ID
      AND TARGET_ENTITY.ENTITY_LOCAL_ID = FLATTENED.TARGET_LOCAL_ID
    LEFT JOIN NOCTURNE.RAW.DT_L2_CLAIMS AS TARGET_CLAIM
      ON TARGET_CLAIM.DEDUPE_KEY = FLATTENED.DEDUPE_KEY
      AND TARGET_CLAIM.ORG_ID = FLATTENED.ORG_ID
      AND TARGET_CLAIM.CLAIM_LOCAL_ID = FLATTENED.TARGET_LOCAL_ID
  )
  SELECT
    DOC_ID,
    DEDUPE_KEY,
    ORG_ID,
    FETCHED_AT,
    EDGE_TYPE,
    SOURCE_KIND,
    TARGET_KIND,
    SOURCE_KEY,
    TARGET_KEY,
    SOURCE_ENTITY_TYPE,
    TARGET_ENTITY_TYPE,
    COALESCE(TARGET_IS_MONITORED_ORG, FALSE) AS TARGET_IS_MONITORED_ORG,
    EVIDENCE_TEXT,
    CASE WHEN EVIDENCE_POSITION > 0
      THEN EVIDENCE_POSITION - 1
    END AS EVIDENCE_START,
    CASE WHEN EVIDENCE_POSITION > 0
      THEN EVIDENCE_POSITION - 1 + LENGTH(EVIDENCE_TEXT)
    END AS EVIDENCE_END,
    EVIDENCE_POSITION > 0 AS IS_GROUNDED,
    SHA2(
      DEDUPE_KEY || '|' || ORG_ID || '|' || SOURCE_KEY || '|'
        || EDGE_TYPE || '|' || TARGET_KEY
    ) AS EDGE_KEY
  FROM RESOLVED
  WHERE SOURCE_KEY IS NOT NULL
    AND TARGET_KEY IS NOT NULL;

-- Safe operational checks; grounding rate is the headline quality metric.
-- SELECT
--   COUNT(*) AS CLAIM_COUNT,
--   COUNT_IF(IS_GROUNDED) AS GROUNDED_COUNT,
--   ROUND(100 * COUNT_IF(IS_GROUNDED) / NULLIF(COUNT(*), 0), 1)
--     AS GROUNDING_RATE_PCT
-- FROM NOCTURNE.RAW.DT_L2_CLAIMS;
--
-- SELECT ENTITY_TYPE, COUNT(*) AS MENTIONS, COUNT(DISTINCT NODE_KEY) AS NODES
-- FROM NOCTURNE.RAW.DT_L2_ENTITIES
-- GROUP BY ENTITY_TYPE
-- ORDER BY MENTIONS DESC;

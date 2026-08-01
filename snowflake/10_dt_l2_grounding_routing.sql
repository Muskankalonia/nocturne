-- =============================================================================
-- Nocturne Pipeline: Step 10 - L2 Grounding, Resolution, and Routing
-- =============================================================================
-- Deterministically validates the cached step-09 extraction. No Cortex function
-- is called here. Exact and conservatively normalized evidence is accepted;
-- unsupported output remains queryable but cannot enter the promoted graph.
--
-- Target resolution is scoped to the crawler-assigned ORG_ID. Exact configured
-- domains, canonical names, aliases, and high-confidence fuzzy organization
-- names can confirm ownership. Products provide context only.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

-- Normalize only formatting differences that commonly occur in copied dark-web
-- text. Case and punctuation remain significant for evidence grounding.
CREATE OR REPLACE FUNCTION NOCTURNE.RAW.GROUND_EVIDENCE(
  INPUT_TEXT STRING,
  EVIDENCE_TEXT STRING
)
RETURNS VARIANT
LANGUAGE JAVASCRIPT
IMMUTABLE
AS
$$
  function normalized(value) {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\r\n?/g, '\n')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sectionAt(source, position) {
    if (position < 0) {
      return null;
    }
    var prefix = source.slice(0, position);
    var bestPosition = -1;
    var bestSection = null;
    var fixedSections = [
      ['DOCUMENT TEXT', 'document_text'],
      ['DOCUMENT INTRODUCTION', 'document_introduction'],
      ['DOCUMENT END', 'document_end'],
      [
        'FALLBACK DOCUMENT BEGINNING AND NON-OVERLAPPING END',
        'fallback_beginning_and_end'
      ]
    ];
    for (var index = 0; index < fixedSections.length; index += 1) {
      var foundAt = prefix.lastIndexOf(fixedSections[index][0]);
      if (foundAt > bestPosition) {
        bestPosition = foundAt;
        bestSection = fixedSections[index][1];
      }
    }

    var windowPattern = /EVIDENCE WINDOW ([0-9]+)/g;
    var match;
    while ((match = windowPattern.exec(prefix)) !== null) {
      if (match.index > bestPosition) {
        bestPosition = match.index;
        bestSection = 'evidence_window_' + match[1];
      }
    }
    return bestSection;
  }

  var source = String(INPUT_TEXT || '');
  var evidence = String(EVIDENCE_TEXT || '');
  if (!source || !evidence.trim()) {
    return {
      level: 'unmatched',
      start: null,
      end: null,
      selected_window_id: null,
      reason: 'empty_evidence'
    };
  }

  var exactPosition = source.indexOf(evidence);
  if (exactPosition >= 0) {
    return {
      level: 'exact',
      start: exactPosition,
      end: exactPosition + evidence.length,
      selected_window_id: sectionAt(source, exactPosition),
      reason: null
    };
  }

  var normalizedSource = normalized(source);
  var normalizedEvidence = normalized(evidence);
  var normalizedPosition = normalizedEvidence
    ? normalizedSource.indexOf(normalizedEvidence)
    : -1;
  if (normalizedPosition >= 0) {
    return {
      level: 'normalized',
      start: null,
      end: null,
      selected_window_id: sectionAt(normalizedSource, normalizedPosition),
      reason: null
    };
  }

  return {
    level: 'unmatched',
    start: null,
    end: null,
    selected_window_id: null,
    reason: 'evidence_not_found'
  };
$$;

CREATE OR REPLACE FUNCTION NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(RAW_NAME STRING)
RETURNS STRING
LANGUAGE JAVASCRIPT
IMMUTABLE
AS
$$
  var value = String(RAW_NAME || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value.replace(
    /\s+(inc|ltd|llc|plc|corp|corporation|company|limited|gmbh|pvt)$/,
    ''
  );
$$;

CREATE OR REPLACE FUNCTION NOCTURNE.RAW.NORMALIZE_DOMAIN(RAW_DOMAIN STRING)
RETURNS STRING
LANGUAGE JAVASCRIPT
IMMUTABLE
AS
$$
  return String(RAW_DOMAIN || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .toLowerCase()
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .split(/[\/?#]/, 1)[0]
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
$$;

-- Parse a structured response once and retain safe document metadata required
-- for routing, graph scoping, logging, and later severity calculation.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_EXTRACTION
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH SOURCE AS (
    SELECT
      AI.ORG_ID,
      AI.DOC_ID,
      AI.DEDUPE_KEY,
      AI.RELATIONSHIP_LABEL,
      AI.L2_GATE_REASON,
      AI.FETCHED_AT,
      AI.EXTRACTION_TEXT,
      AI.EXTRACTION_TEXT_LENGTH,
      AI.EXTRACTION_INPUT_SHA256,
      AI.EXTRACTION_METHOD_VERSION,
      AI.EXTRACTION_MODEL_NAME,
      AI.EXTRACTION_AI_STATUS,
      AI.EXTRACTION_AI_RESULT,
      AI.EXTRACTION_AI_ERROR,
      AI.EXTRACTION_CALLED_AT,
      INPUT.SOURCE,
      INPUT.URL,
      INPUT.TITLE,
      INPUT._SOURCE_FILE AS SOURCE_FILE,
      INPUT.CONTENT_SHA256,
      INPUT.INDICATOR_SUMMARY,
      INPUT.TARGET_MATCH_SCORE,
      INPUT.TARGET_ANCHOR_TYPE,
      INPUT.LEAK_MATCHES_SCANNED,
      INPUT.STRONG_INDICATOR_COUNT,
      INPUT.MEDIUM_INDICATOR_COUNT,
      INPUT.EVIDENCE_SCORE
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION_AI AS AI
    INNER JOIN NOCTURNE.RAW.DT_L1_CLASSIFICATION_INPUT AS INPUT
      ON INPUT.ORG_ID = AI.ORG_ID
      AND INPUT.DEDUPE_KEY = AI.DEDUPE_KEY
  ),
  PARSED AS (
    SELECT
      *,
      CASE
        WHEN TYPEOF(EXTRACTION_AI_RESULT) IN ('OBJECT', 'ARRAY')
          THEN EXTRACTION_AI_RESULT
        WHEN TYPEOF(EXTRACTION_AI_RESULT) = 'VARCHAR'
          THEN TRY_PARSE_JSON(EXTRACTION_AI_RESULT::STRING)
        ELSE NULL
      END AS EXTRACTION
    FROM SOURCE
  )
  SELECT
    *,
    CASE
      WHEN EXTRACTION_AI_STATUS <> 'success' THEN 'error'
      WHEN EXTRACTION IS NULL THEN 'invalid_response'
      WHEN NOT COALESCE(IS_ARRAY(EXTRACTION:claims), FALSE)
        OR NOT COALESCE(IS_ARRAY(EXTRACTION:entities), FALSE)
        OR NOT COALESCE(IS_ARRAY(EXTRACTION:relationships), FALSE)
        THEN 'invalid_response'
      ELSE 'success'
    END AS EXTRACTION_STATUS,
    ARRAY_SIZE(COALESCE(EXTRACTION:claims, ARRAY_CONSTRUCT()))
      AS CLAIM_COUNT_RAW,
    ARRAY_SIZE(COALESCE(EXTRACTION:entities, ARRAY_CONSTRUCT()))
      AS ENTITY_COUNT_RAW,
    ARRAY_SIZE(COALESCE(EXTRACTION:relationships, ARRAY_CONSTRUCT()))
      AS RELATIONSHIP_COUNT_RAW
  FROM PARSED;

-- Flatten at most a bounded audit set. Promotion caps are deliberately smaller;
-- extra model output is retained with an explicit cap reason but cannot pass.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_GRAPH_ITEMS
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH CLAIMS AS (
    SELECT
      EXTRACTION.ORG_ID,
      EXTRACTION.DOC_ID,
      EXTRACTION.DEDUPE_KEY,
      EXTRACTION.FETCHED_AT,
      EXTRACTION.EXTRACTION_TEXT,
      'claim' AS ITEM_KIND,
      CLAIM.INDEX::NUMBER AS ITEM_INDEX,
      CLAIM.VALUE:id::STRING AS LOCAL_ID,
      CLAIM.VALUE:claim_status::STRING AS ITEM_TYPE,
      NULL::STRING AS ITEM_NAME,
      CLAIM.VALUE:statement::STRING AS STATEMENT,
      CLAIM.VALUE:quantity_claimed::NUMBER AS QUANTITY_CLAIMED,
      NULL::STRING AS SOURCE_LOCAL_ID,
      NULL::STRING AS TARGET_LOCAL_ID,
      CLAIM.VALUE:evidence_text::STRING AS EVIDENCE_TEXT,
      CLAIM.INDEX < 20 AS WITHIN_PROMOTION_CAP
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION AS EXTRACTION,
      LATERAL FLATTEN(input => EXTRACTION.EXTRACTION:claims) AS CLAIM
    WHERE EXTRACTION.EXTRACTION_STATUS = 'success'
      AND CLAIM.INDEX < 100
  ),
  ENTITIES AS (
    SELECT
      EXTRACTION.ORG_ID,
      EXTRACTION.DOC_ID,
      EXTRACTION.DEDUPE_KEY,
      EXTRACTION.FETCHED_AT,
      EXTRACTION.EXTRACTION_TEXT,
      'entity' AS ITEM_KIND,
      ENTITY.INDEX::NUMBER AS ITEM_INDEX,
      ENTITY.VALUE:id::STRING AS LOCAL_ID,
      ENTITY.VALUE:type::STRING AS ITEM_TYPE,
      ENTITY.VALUE:name::STRING AS ITEM_NAME,
      NULL::STRING AS STATEMENT,
      NULL::NUMBER AS QUANTITY_CLAIMED,
      NULL::STRING AS SOURCE_LOCAL_ID,
      NULL::STRING AS TARGET_LOCAL_ID,
      ENTITY.VALUE:evidence_text::STRING AS EVIDENCE_TEXT,
      ENTITY.INDEX < 30 AS WITHIN_PROMOTION_CAP
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION AS EXTRACTION,
      LATERAL FLATTEN(input => EXTRACTION.EXTRACTION:entities) AS ENTITY
    WHERE EXTRACTION.EXTRACTION_STATUS = 'success'
      AND ENTITY.INDEX < 100
  ),
  RELATIONSHIPS AS (
    SELECT
      EXTRACTION.ORG_ID,
      EXTRACTION.DOC_ID,
      EXTRACTION.DEDUPE_KEY,
      EXTRACTION.FETCHED_AT,
      EXTRACTION.EXTRACTION_TEXT,
      'relationship' AS ITEM_KIND,
      RELATIONSHIP.INDEX::NUMBER AS ITEM_INDEX,
      'relationship_' || (RELATIONSHIP.INDEX + 1)::STRING AS LOCAL_ID,
      RELATIONSHIP.VALUE:type::STRING AS ITEM_TYPE,
      NULL::STRING AS ITEM_NAME,
      NULL::STRING AS STATEMENT,
      NULL::NUMBER AS QUANTITY_CLAIMED,
      RELATIONSHIP.VALUE:source::STRING AS SOURCE_LOCAL_ID,
      RELATIONSHIP.VALUE:target::STRING AS TARGET_LOCAL_ID,
      RELATIONSHIP.VALUE:evidence_text::STRING AS EVIDENCE_TEXT,
      RELATIONSHIP.INDEX < 40 AS WITHIN_PROMOTION_CAP
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION AS EXTRACTION,
      LATERAL FLATTEN(input => EXTRACTION.EXTRACTION:relationships)
        AS RELATIONSHIP
    WHERE EXTRACTION.EXTRACTION_STATUS = 'success'
      AND RELATIONSHIP.INDEX < 150
  ),
  COMBINED AS (
    SELECT * FROM CLAIMS
    UNION ALL
    SELECT * FROM ENTITIES
    UNION ALL
    SELECT * FROM RELATIONSHIPS
  ),
  GROUNDED AS (
    SELECT
      *,
      NOCTURNE.RAW.GROUND_EVIDENCE(
        EXTRACTION_TEXT,
        EVIDENCE_TEXT
      ) AS GROUNDING_RESULT
    FROM COMBINED
  )
  SELECT
    ORG_ID,
    DOC_ID,
    DEDUPE_KEY,
    FETCHED_AT,
    ITEM_KIND,
    ITEM_INDEX,
    LOCAL_ID,
    ITEM_TYPE,
    ITEM_NAME,
    STATEMENT,
    QUANTITY_CLAIMED,
    SOURCE_LOCAL_ID,
    TARGET_LOCAL_ID,
    EVIDENCE_TEXT,
    WITHIN_PROMOTION_CAP,
    GROUNDING_RESULT:level::STRING AS GROUNDING_LEVEL,
    GROUNDING_RESULT:start::NUMBER AS EVIDENCE_START,
    GROUNDING_RESULT:end::NUMBER AS EVIDENCE_END,
    GROUNDING_RESULT:selected_window_id::STRING AS SELECTED_WINDOW_ID,
    GROUNDING_RESULT:reason::STRING AS GROUNDING_REASON
  FROM GROUNDED;

CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_CLAIMS
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH COUNTED AS (
    SELECT
      *,
      COUNT(*) OVER (
        PARTITION BY ORG_ID, DEDUPE_KEY, LOCAL_ID
      ) AS LOCAL_ID_COUNT
    FROM NOCTURNE.RAW.DT_L2_GRAPH_ITEMS
    WHERE ITEM_KIND = 'claim'
  ),
  VALIDATED AS (
    SELECT
      *,
      CASE
        WHEN NOT WITHIN_PROMOTION_CAP THEN 'claim_cap_exceeded'
        WHEN LOCAL_ID IS NULL
          OR NOT REGEXP_LIKE(LOCAL_ID, '^claim_[1-9][0-9]*$')
          THEN 'invalid_claim_id'
        WHEN LOCAL_ID_COUNT <> 1 THEN 'duplicate_claim_id'
        WHEN STATEMENT IS NULL OR LENGTH(TRIM(STATEMENT)) = 0
          THEN 'empty_claim_statement'
        WHEN ITEM_TYPE NOT IN ('unverified', 'self_evidenced', 'disputed')
          THEN 'invalid_claim_status'
        WHEN GROUNDING_LEVEL = 'unmatched' THEN 'unmatched_evidence'
        ELSE NULL
      END AS VALIDATION_REASON
    FROM COUNTED
  )
  SELECT
    ORG_ID,
    DOC_ID,
    DEDUPE_KEY,
    FETCHED_AT,
    LOCAL_ID AS CLAIM_LOCAL_ID,
    STATEMENT,
    ITEM_TYPE AS CLAIM_STATUS_EXTRACTED,
    CASE WHEN VALIDATION_REASON IS NULL THEN QUANTITY_CLAIMED END
      AS QUANTITY_CLAIMED,
    EVIDENCE_TEXT,
    GROUNDING_LEVEL,
    EVIDENCE_START,
    EVIDENCE_END,
    SELECTED_WINDOW_ID,
    GROUNDING_LEVEL IN ('exact', 'normalized') AS IS_GROUNDED,
    VALIDATION_REASON IS NULL AS IS_ACCEPTED,
    VALIDATION_REASON,
    SHA2(ORG_ID || '|' || DEDUPE_KEY || '|' || LOCAL_ID) AS CLAIM_KEY,
    'conservative_grounding_v2' AS GROUNDING_METHOD_VERSION
  FROM VALIDATED;

CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_ENTITIES
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  WITH BASE AS (
    SELECT
      ITEM.*,
      NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(ITEM.ITEM_NAME)
        AS NORMALIZED_NAME,
      NOCTURNE.RAW.NORMALIZE_DOMAIN(ITEM.ITEM_NAME)
        AS NORMALIZED_DOMAIN,
      COUNT(*) OVER (
        PARTITION BY ITEM.ORG_ID, ITEM.DEDUPE_KEY, ITEM.LOCAL_ID
      ) AS LOCAL_ID_COUNT,
      INPUT.SOURCE,
      INPUT.URL,
      INPUT.SOURCE_FILE
    FROM NOCTURNE.RAW.DT_L2_GRAPH_ITEMS AS ITEM
    INNER JOIN NOCTURNE.RAW.DT_L2_EXTRACTION AS INPUT
      ON INPUT.ORG_ID = ITEM.ORG_ID
      AND INPUT.DEDUPE_KEY = ITEM.DEDUPE_KEY
    WHERE ITEM.ITEM_KIND = 'entity'
  ),
  STRUCTURED AS (
    SELECT
      *,
      CASE
        WHEN NOT WITHIN_PROMOTION_CAP THEN 'entity_cap_exceeded'
        WHEN LOCAL_ID IS NULL
          OR NOT REGEXP_LIKE(LOCAL_ID, '^entity_[1-9][0-9]*$')
          THEN 'invalid_entity_id'
        WHEN LOCAL_ID_COUNT <> 1 THEN 'duplicate_entity_id'
        WHEN ITEM_TYPE NOT IN (
          'organization', 'domain', 'product', 'actor_alias', 'marketplace',
          'data_asset', 'contact_channel', 'location'
        ) THEN 'invalid_entity_type'
        WHEN ITEM_NAME IS NULL OR LENGTH(TRIM(ITEM_NAME)) = 0
          THEN 'empty_entity_name'
        WHEN NORMALIZED_NAME = '' THEN 'empty_normalized_name'
        WHEN GROUNDING_LEVEL = 'unmatched' THEN 'unmatched_evidence'
        ELSE NULL
      END AS VALIDATION_REASON
    FROM BASE
  ),
  MONITORED_NAMES AS (
    SELECT
      ORG_ID,
      'canonical_name' AS CONFIG_MATCH_SOURCE,
      NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(CANONICAL_NAME)
        AS CONFIG_NORMALIZED_NAME
    FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
    WHERE ENABLED = TRUE
    UNION ALL
    SELECT
      ORGANIZATION.ORG_ID,
      'alias' AS CONFIG_MATCH_SOURCE,
      NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(ALIAS.VALUE::STRING)
        AS CONFIG_NORMALIZED_NAME
    FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS ORGANIZATION,
      LATERAL FLATTEN(input => ORGANIZATION.ALIASES) AS ALIAS
    WHERE ORGANIZATION.ENABLED = TRUE
  ),
  NAME_SCORES AS (
    SELECT
      ENTITY.ORG_ID,
      ENTITY.DEDUPE_KEY,
      ENTITY.LOCAL_ID,
      NAME.CONFIG_MATCH_SOURCE,
      NAME.CONFIG_NORMALIZED_NAME,
      ENTITY.NORMALIZED_NAME = NAME.CONFIG_NORMALIZED_NAME AS IS_EXACT_NAME,
      JAROWINKLER_SIMILARITY(
        ENTITY.NORMALIZED_NAME,
        NAME.CONFIG_NORMALIZED_NAME
      ) AS NAME_SIMILARITY
    FROM STRUCTURED AS ENTITY
    INNER JOIN MONITORED_NAMES AS NAME
      ON NAME.ORG_ID = ENTITY.ORG_ID
    WHERE ENTITY.ITEM_TYPE = 'organization'
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY ENTITY.ORG_ID, ENTITY.DEDUPE_KEY, ENTITY.LOCAL_ID
      ORDER BY
        IS_EXACT_NAME DESC,
        NAME_SIMILARITY DESC,
        IFF(NAME.CONFIG_MATCH_SOURCE = 'canonical_name', 1, 0) DESC
    ) = 1
  ),
  DOMAIN_MATCHES AS (
    SELECT
      ENTITY.ORG_ID,
      ENTITY.DEDUPE_KEY,
      ENTITY.LOCAL_ID,
      COUNT(*) > 0 AS IS_EXACT_DOMAIN
    FROM STRUCTURED AS ENTITY
    INNER JOIN NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS ORGANIZATION
      ON ORGANIZATION.ORG_ID = ENTITY.ORG_ID
      AND ORGANIZATION.ENABLED = TRUE,
      LATERAL FLATTEN(input => ORGANIZATION.DOMAINS) AS DOMAIN
    WHERE ENTITY.ITEM_TYPE = 'domain'
      AND ENTITY.NORMALIZED_DOMAIN =
        NOCTURNE.RAW.NORMALIZE_DOMAIN(DOMAIN.VALUE::STRING)
    GROUP BY ENTITY.ORG_ID, ENTITY.DEDUPE_KEY, ENTITY.LOCAL_ID
  ),
  PRODUCT_MATCHES AS (
    SELECT
      ENTITY.ORG_ID,
      ENTITY.DEDUPE_KEY,
      ENTITY.LOCAL_ID,
      COUNT(*) > 0 AS IS_EXACT_PRODUCT
    FROM STRUCTURED AS ENTITY
    INNER JOIN NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS ORGANIZATION
      ON ORGANIZATION.ORG_ID = ENTITY.ORG_ID
      AND ORGANIZATION.ENABLED = TRUE,
      LATERAL FLATTEN(input => ORGANIZATION.PRODUCTS) AS PRODUCT
    WHERE ENTITY.ITEM_TYPE = 'product'
      AND ENTITY.NORMALIZED_NAME =
        NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(PRODUCT.VALUE::STRING)
    GROUP BY ENTITY.ORG_ID, ENTITY.DEDUPE_KEY, ENTITY.LOCAL_ID
  ),
  RESOLVED AS (
    SELECT
      ENTITY.*,
      NAME.CONFIG_MATCH_SOURCE,
      COALESCE(NAME.IS_EXACT_NAME, FALSE) AS IS_EXACT_NAME,
      COALESCE(NAME.NAME_SIMILARITY, 0) AS NAME_SIMILARITY,
      COALESCE(DOMAIN.IS_EXACT_DOMAIN, FALSE) AS IS_EXACT_DOMAIN,
      COALESCE(PRODUCT.IS_EXACT_PRODUCT, FALSE) AS IS_EXACT_PRODUCT,
      CASE
        WHEN ENTITY.VALIDATION_REASON IS NOT NULL THEN 'unmatched'
        WHEN ENTITY.ITEM_TYPE = 'domain' AND IS_EXACT_DOMAIN
          THEN 'confirmed'
        WHEN ENTITY.ITEM_TYPE = 'organization' AND IS_EXACT_NAME
          THEN 'confirmed'
        WHEN ENTITY.ITEM_TYPE = 'organization'
          AND LENGTH(ENTITY.NORMALIZED_NAME) >= 6
          AND LENGTH(NAME.CONFIG_NORMALIZED_NAME) >= 6
          AND NAME_SIMILARITY >= 92 THEN 'confirmed'
        WHEN ENTITY.ITEM_TYPE = 'organization'
          AND LENGTH(ENTITY.NORMALIZED_NAME) >= 6
          AND LENGTH(NAME.CONFIG_NORMALIZED_NAME) >= 6
          AND NAME_SIMILARITY BETWEEN 85 AND 91 THEN 'ambiguous'
        WHEN ENTITY.ITEM_TYPE = 'product' AND IS_EXACT_PRODUCT
          THEN 'context_only'
        ELSE 'unmatched'
      END AS ENTITY_MATCH_STATUS,
      CASE
        WHEN ENTITY.VALIDATION_REASON IS NOT NULL THEN 'none'
        WHEN ENTITY.ITEM_TYPE = 'domain' AND IS_EXACT_DOMAIN
          THEN 'exact_domain'
        WHEN ENTITY.ITEM_TYPE = 'organization' AND IS_EXACT_NAME
          AND NAME.CONFIG_MATCH_SOURCE = 'canonical_name'
          THEN 'exact_canonical_name'
        WHEN ENTITY.ITEM_TYPE = 'organization' AND IS_EXACT_NAME
          THEN 'exact_alias'
        WHEN ENTITY.ITEM_TYPE = 'organization'
          AND LENGTH(ENTITY.NORMALIZED_NAME) >= 6
          AND LENGTH(NAME.CONFIG_NORMALIZED_NAME) >= 6
          AND NAME_SIMILARITY >= 85 THEN 'fuzzy_name'
        WHEN ENTITY.ITEM_TYPE = 'product' AND IS_EXACT_PRODUCT
          THEN 'product_context'
        ELSE 'none'
      END AS ENTITY_MATCH_METHOD
    FROM STRUCTURED AS ENTITY
    LEFT JOIN NAME_SCORES AS NAME
      ON NAME.ORG_ID = ENTITY.ORG_ID
      AND NAME.DEDUPE_KEY = ENTITY.DEDUPE_KEY
      AND NAME.LOCAL_ID = ENTITY.LOCAL_ID
    LEFT JOIN DOMAIN_MATCHES AS DOMAIN
      ON DOMAIN.ORG_ID = ENTITY.ORG_ID
      AND DOMAIN.DEDUPE_KEY = ENTITY.DEDUPE_KEY
      AND DOMAIN.LOCAL_ID = ENTITY.LOCAL_ID
    LEFT JOIN PRODUCT_MATCHES AS PRODUCT
      ON PRODUCT.ORG_ID = ENTITY.ORG_ID
      AND PRODUCT.DEDUPE_KEY = ENTITY.DEDUPE_KEY
      AND PRODUCT.LOCAL_ID = ENTITY.LOCAL_ID
  )
  SELECT
    ORG_ID,
    DOC_ID,
    DEDUPE_KEY,
    FETCHED_AT,
    LOCAL_ID AS ENTITY_LOCAL_ID,
    ITEM_TYPE AS ENTITY_TYPE,
    ITEM_NAME AS ENTITY_NAME,
    NORMALIZED_NAME,
    EVIDENCE_TEXT,
    GROUNDING_LEVEL,
    EVIDENCE_START,
    EVIDENCE_END,
    SELECTED_WINDOW_ID,
    GROUNDING_LEVEL IN ('exact', 'normalized') AS IS_GROUNDED,
    VALIDATION_REASON IS NULL AS IS_ACCEPTED,
    VALIDATION_REASON,
    ENTITY_MATCH_STATUS,
    CASE
      WHEN ENTITY_MATCH_METHOD IN (
        'exact_domain', 'exact_canonical_name', 'exact_alias',
        'product_context'
      ) THEN 100
      WHEN ITEM_TYPE = 'organization' THEN NAME_SIMILARITY
      ELSE 0
    END AS ENTITY_MATCH_CONFIDENCE,
    ENTITY_MATCH_METHOD,
    CASE WHEN ENTITY_MATCH_STATUS = 'confirmed' THEN ORG_ID END
      AS RESOLVED_ORG_ID,
    CASE WHEN ENTITY_MATCH_STATUS = 'confirmed'
      THEN SHA2(ORG_ID || '|organization|' || ORG_ID)
    END AS RESOLVED_ORG_NODE_KEY,
    ENTITY_MATCH_STATUS = 'confirmed' AS IS_MONITORED_ORG,
    CASE
      WHEN ENTITY_MATCH_STATUS = 'confirmed'
        AND ITEM_TYPE = 'organization'
        THEN SHA2(ORG_ID || '|organization|' || ORG_ID)
      WHEN ITEM_TYPE = 'actor_alias'
        AND NORMALIZED_NAME IN ('admin', 'seller', 'user', 'vendor')
        THEN SHA2(
          ORG_ID || '|' || ITEM_TYPE || '|' || NORMALIZED_NAME || '|'
            || COALESCE(URL, SOURCE, SOURCE_FILE, 'unknown_source')
        )
      WHEN ITEM_TYPE = 'domain'
        THEN SHA2(ORG_ID || '|domain|' || NORMALIZED_DOMAIN)
      ELSE SHA2(ORG_ID || '|' || ITEM_TYPE || '|' || NORMALIZED_NAME)
    END AS NODE_KEY
  FROM RESOLVED;

CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_EDGES
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  WITH ENDPOINT_ROWS AS (
    SELECT
      ORG_ID,
      DEDUPE_KEY,
      CLAIM_LOCAL_ID AS LOCAL_ID,
      'claim' AS ENDPOINT_KIND,
      'claim' AS ENDPOINT_TYPE,
      CLAIM_KEY AS ENDPOINT_KEY,
      IS_ACCEPTED,
      FALSE AS IS_MONITORED_ORG,
      NULL::STRING AS RESOLVED_ORG_NODE_KEY
    FROM NOCTURNE.RAW.DT_L2_CLAIMS
    UNION ALL
    SELECT
      ORG_ID,
      DEDUPE_KEY,
      ENTITY_LOCAL_ID,
      'entity',
      ENTITY_TYPE,
      NODE_KEY,
      IS_ACCEPTED,
      IS_MONITORED_ORG,
      RESOLVED_ORG_NODE_KEY
    FROM NOCTURNE.RAW.DT_L2_ENTITIES
  ),
  ENDPOINTS AS (
    SELECT *
    FROM ENDPOINT_ROWS
    QUALIFY ROW_NUMBER() OVER (
      PARTITION BY ORG_ID, DEDUPE_KEY, LOCAL_ID
      ORDER BY IS_ACCEPTED DESC, ENDPOINT_KIND
    ) = 1
  ),
  BASE AS (
    SELECT
      ITEM.*,
      SOURCE_ENDPOINT.ENDPOINT_KIND AS SOURCE_KIND,
      SOURCE_ENDPOINT.ENDPOINT_TYPE AS SOURCE_TYPE,
      SOURCE_ENDPOINT.ENDPOINT_KEY AS SOURCE_KEY,
      SOURCE_ENDPOINT.IS_ACCEPTED AS SOURCE_IS_ACCEPTED,
      TARGET_ENDPOINT.ENDPOINT_KIND AS TARGET_KIND,
      TARGET_ENDPOINT.ENDPOINT_TYPE AS TARGET_TYPE,
      TARGET_ENDPOINT.ENDPOINT_KEY AS TARGET_KEY,
      TARGET_ENDPOINT.IS_ACCEPTED AS TARGET_IS_ACCEPTED,
      COALESCE(TARGET_ENDPOINT.IS_MONITORED_ORG, FALSE)
        AS TARGET_IS_MONITORED_ORG,
      TARGET_ENDPOINT.RESOLVED_ORG_NODE_KEY
        AS TARGET_RESOLVED_ORG_NODE_KEY
    FROM NOCTURNE.RAW.DT_L2_GRAPH_ITEMS AS ITEM
    LEFT JOIN ENDPOINTS AS SOURCE_ENDPOINT
      ON SOURCE_ENDPOINT.ORG_ID = ITEM.ORG_ID
      AND SOURCE_ENDPOINT.DEDUPE_KEY = ITEM.DEDUPE_KEY
      AND SOURCE_ENDPOINT.LOCAL_ID = ITEM.SOURCE_LOCAL_ID
    LEFT JOIN ENDPOINTS AS TARGET_ENDPOINT
      ON TARGET_ENDPOINT.ORG_ID = ITEM.ORG_ID
      AND TARGET_ENDPOINT.DEDUPE_KEY = ITEM.DEDUPE_KEY
      AND TARGET_ENDPOINT.LOCAL_ID = ITEM.TARGET_LOCAL_ID
    WHERE ITEM.ITEM_KIND = 'relationship'
  ),
  VALIDATED AS (
    SELECT
      *,
      CASE
        WHEN NOT WITHIN_PROMOTION_CAP THEN 'relationship_cap_exceeded'
        WHEN GROUNDING_LEVEL = 'unmatched' THEN 'unmatched_evidence'
        WHEN SOURCE_LOCAL_ID IS NULL
          OR NOT REGEXP_LIKE(SOURCE_LOCAL_ID, '^(claim|entity)_[1-9][0-9]*$')
          THEN 'invalid_source_id'
        WHEN TARGET_LOCAL_ID IS NULL
          OR NOT REGEXP_LIKE(TARGET_LOCAL_ID, '^(claim|entity)_[1-9][0-9]*$')
          THEN 'invalid_target_id'
        WHEN SOURCE_KEY IS NULL THEN 'missing_source_endpoint'
        WHEN TARGET_KEY IS NULL THEN 'missing_target_endpoint'
        WHEN NOT COALESCE(SOURCE_IS_ACCEPTED, FALSE)
          THEN 'invalid_source_endpoint'
        WHEN NOT COALESCE(TARGET_IS_ACCEPTED, FALSE)
          THEN 'invalid_target_endpoint'
        WHEN NOT (
          (ITEM_TYPE = 'MADE_CLAIM'
            AND SOURCE_TYPE = 'actor_alias' AND TARGET_KIND = 'claim')
          OR (ITEM_TYPE = 'ALLEGEDLY_AFFECTS'
            AND SOURCE_KIND = 'claim'
            AND TARGET_TYPE IN ('organization', 'domain'))
          OR (ITEM_TYPE = 'OFFERS_FOR_SALE'
            AND SOURCE_TYPE = 'actor_alias'
            AND (TARGET_KIND = 'claim' OR TARGET_TYPE = 'data_asset'))
          OR (ITEM_TYPE = 'LISTED_ON'
            AND SOURCE_TYPE IN ('actor_alias', 'data_asset')
            AND TARGET_TYPE = 'marketplace')
          OR (ITEM_TYPE = 'CONTACTED_VIA'
            AND SOURCE_TYPE = 'actor_alias'
            AND TARGET_TYPE = 'contact_channel')
          OR (ITEM_TYPE = 'MENTIONS'
            AND SOURCE_KIND = 'claim' AND TARGET_KIND = 'entity')
        ) THEN 'invalid_endpoint_combination'
        ELSE NULL
      END AS VALIDATION_REASON
    FROM BASE
  )
  SELECT
    ORG_ID,
    DOC_ID,
    DEDUPE_KEY,
    FETCHED_AT,
    LOCAL_ID AS RELATIONSHIP_LOCAL_ID,
    ITEM_TYPE AS EDGE_TYPE,
    SOURCE_LOCAL_ID,
    TARGET_LOCAL_ID,
    SOURCE_KIND,
    SOURCE_TYPE,
    SOURCE_KEY,
    TARGET_KIND,
    TARGET_TYPE,
    TARGET_KEY,
    TARGET_IS_MONITORED_ORG,
    TARGET_RESOLVED_ORG_NODE_KEY,
    EVIDENCE_TEXT,
    GROUNDING_LEVEL,
    EVIDENCE_START,
    EVIDENCE_END,
    SELECTED_WINDOW_ID,
    GROUNDING_LEVEL IN ('exact', 'normalized') AS IS_GROUNDED,
    VALIDATION_REASON IS NULL AS IS_ACCEPTED,
    VALIDATION_REASON,
    SHA2(
      ORG_ID || '|' || DEDUPE_KEY || '|' || SOURCE_LOCAL_ID || '|'
        || ITEM_TYPE || '|' || TARGET_LOCAL_ID
    ) AS EDGE_KEY
  FROM VALIDATED;

-- One ownership decision per organization-scoped page. Only target_confirmed
-- receives an L3 green light; other organizations remain auditable in L2.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L2_ROUTING
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  WITH CLAIM_STATS AS (
    SELECT
      ORG_ID,
      DEDUPE_KEY,
      COUNT(*) AS CLAIM_COUNT,
      COUNT_IF(IS_ACCEPTED) AS ACCEPTED_CLAIM_COUNT
    FROM NOCTURNE.RAW.DT_L2_CLAIMS
    GROUP BY ORG_ID, DEDUPE_KEY
  ),
  ENTITY_STATS AS (
    SELECT
      ORG_ID,
      DEDUPE_KEY,
      COUNT(*) AS ENTITY_COUNT,
      COUNT_IF(IS_ACCEPTED) AS ACCEPTED_ENTITY_COUNT,
      COUNT_IF(IS_ACCEPTED AND IS_MONITORED_ORG)
        AS ACCEPTED_TARGET_ENTITY_COUNT
    FROM NOCTURNE.RAW.DT_L2_ENTITIES
    GROUP BY ORG_ID, DEDUPE_KEY
  ),
  EDGE_STATS AS (
    SELECT
      ORG_ID,
      DEDUPE_KEY,
      COUNT(*) AS RELATIONSHIP_COUNT,
      COUNT_IF(IS_ACCEPTED) AS ACCEPTED_RELATIONSHIP_COUNT,
      COUNT_IF(
        IS_ACCEPTED
        AND EDGE_TYPE = 'ALLEGEDLY_AFFECTS'
        AND TARGET_IS_MONITORED_ORG
      ) AS ACCEPTED_TARGET_AFFECTS_COUNT,
      COUNT_IF(
        IS_ACCEPTED
        AND EDGE_TYPE = 'ALLEGEDLY_AFFECTS'
        AND NOT TARGET_IS_MONITORED_ORG
        AND TARGET_TYPE IN ('organization', 'domain')
      ) AS ACCEPTED_OTHER_AFFECTS_COUNT,
      MIN(IFF(
        IS_ACCEPTED
          AND EDGE_TYPE = 'ALLEGEDLY_AFFECTS'
          AND TARGET_IS_MONITORED_ORG,
        TARGET_RESOLVED_ORG_NODE_KEY,
        NULL
      )) AS AFFECTED_ORG_NODE_KEY
    FROM NOCTURNE.RAW.DT_L2_EDGES
    GROUP BY ORG_ID, DEDUPE_KEY
  ),
  SCORED AS (
    SELECT
      EXTRACTION.*,
      COALESCE(CLAIM.CLAIM_COUNT, 0) AS CLAIM_COUNT,
      COALESCE(CLAIM.ACCEPTED_CLAIM_COUNT, 0) AS ACCEPTED_CLAIM_COUNT,
      COALESCE(ENTITY.ENTITY_COUNT, 0) AS ENTITY_COUNT,
      COALESCE(ENTITY.ACCEPTED_ENTITY_COUNT, 0) AS ACCEPTED_ENTITY_COUNT,
      COALESCE(ENTITY.ACCEPTED_TARGET_ENTITY_COUNT, 0)
        AS ACCEPTED_TARGET_ENTITY_COUNT,
      COALESCE(EDGE.RELATIONSHIP_COUNT, 0) AS RELATIONSHIP_COUNT,
      COALESCE(EDGE.ACCEPTED_RELATIONSHIP_COUNT, 0)
        AS ACCEPTED_RELATIONSHIP_COUNT,
      COALESCE(EDGE.ACCEPTED_TARGET_AFFECTS_COUNT, 0)
        AS ACCEPTED_TARGET_AFFECTS_COUNT,
      COALESCE(EDGE.ACCEPTED_OTHER_AFFECTS_COUNT, 0)
        AS ACCEPTED_OTHER_AFFECTS_COUNT,
      EDGE.AFFECTED_ORG_NODE_KEY
    FROM NOCTURNE.RAW.DT_L2_EXTRACTION AS EXTRACTION
    LEFT JOIN CLAIM_STATS AS CLAIM
      ON CLAIM.ORG_ID = EXTRACTION.ORG_ID
      AND CLAIM.DEDUPE_KEY = EXTRACTION.DEDUPE_KEY
    LEFT JOIN ENTITY_STATS AS ENTITY
      ON ENTITY.ORG_ID = EXTRACTION.ORG_ID
      AND ENTITY.DEDUPE_KEY = EXTRACTION.DEDUPE_KEY
    LEFT JOIN EDGE_STATS AS EDGE
      ON EDGE.ORG_ID = EXTRACTION.ORG_ID
      AND EDGE.DEDUPE_KEY = EXTRACTION.DEDUPE_KEY
  ),
  ROUTED AS (
    SELECT
      *,
      CASE
        WHEN EXTRACTION_STATUS <> 'success' THEN 'extraction_error'
        WHEN ACCEPTED_TARGET_AFFECTS_COUNT > 0 THEN 'target_confirmed'
        WHEN ACCEPTED_TARGET_ENTITY_COUNT > 0 THEN 'ambiguous'
        WHEN ACCEPTED_OTHER_AFFECTS_COUNT > 0
          THEN 'other_organization_confirmed'
        WHEN COALESCE(TARGET_MATCH_SCORE, 0) = 0
          AND ACCEPTED_TARGET_ENTITY_COUNT = 0 THEN 'not_relevant'
        ELSE 'ambiguous'
      END AS L2_ROUTE
    FROM SCORED
  )
  SELECT
    *,
    CASE L2_ROUTE
      WHEN 'target_confirmed'
        THEN 'grounded_claim_affects_resolved_target'
      WHEN 'other_organization_confirmed'
        THEN 'grounded_claim_affects_different_organization'
      WHEN 'ambiguous'
        THEN 'target_anchor_or_entity_without_valid_target_ownership_edge'
      WHEN 'not_relevant'
        THEN 'no_full_document_target_anchor_and_no_grounded_target_entity'
      ELSE 'cached_l2_extraction_failed_or_was_invalid'
    END AS ROUTING_REASON,
    CASE L2_ROUTE
      WHEN 'target_confirmed' THEN 'target_incident'
      WHEN 'other_organization_confirmed' THEN 'external_context'
      ELSE NULL
    END AS GRAPH_SCOPE,
    L2_ROUTE = 'target_confirmed' AS L3_ELIGIBLE,
    L2_ROUTE = 'target_confirmed' AS TARGET_ALERT_ELIGIBLE,
    ACCEPTED_TARGET_AFFECTS_COUNT > 0 AS TARGET_LEAK_RELATION_GROUNDED
  FROM ROUTED;

-- Safe audit examples: values and evidence text are deliberately omitted.
-- SELECT ORG_ID, L2_ROUTE, ROUTING_REASON, COUNT(*) AS DOCUMENTS
-- FROM NOCTURNE.RAW.DT_L2_ROUTING
-- GROUP BY ORG_ID, L2_ROUTE, ROUTING_REASON;
--
-- SELECT VALIDATION_REASON, COUNT(*) AS REJECTED_ELEMENTS
-- FROM (
--   SELECT VALIDATION_REASON FROM NOCTURNE.RAW.DT_L2_CLAIMS
--   UNION ALL
--   SELECT VALIDATION_REASON FROM NOCTURNE.RAW.DT_L2_ENTITIES
--   UNION ALL
--   SELECT VALIDATION_REASON FROM NOCTURNE.RAW.DT_L2_EDGES
-- )
-- WHERE VALIDATION_REASON IS NOT NULL
-- GROUP BY VALIDATION_REASON;

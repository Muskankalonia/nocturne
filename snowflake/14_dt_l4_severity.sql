-- =============================================================================
-- Nocturne Pipeline: Step 14 - L4 Final Severity and Leak Insights
-- =============================================================================
-- Delivers what step 9 deferred: "NER/KG receives every component so entity
-- resolution can refine relevance and calculate a separate final severity
-- without overwriting this preliminary score."
--
--   FINAL_SEVERITY = IMPACT x CONFIDENCE x ATTRIBUTION x RECENCY
--                    (0-100)  (0.40-1)    (0.30-1)      (0.60-1)
--
-- Each factor answers a different question and each is sourced from a different
-- layer: IMPACT from L0 indicators and L1 leak types, CONFIDENCE from L2
-- grounding and L3 corroboration, ATTRIBUTION from L1 anchors confirmed by L3
-- entity resolution, RECENCY from crawl time. Floors are deliberate so the
-- product cannot collapse to zero; the achievable range is roughly 7 to 100.
--
-- Two corrections to the preliminary formula, both using data already present:
--
--   1. GREATEST() over leak types means credential + financial + PII scores 90,
--      identical to financial alone. A breach spanning three data classes is
--      materially worse than one spanning a single class, so extra classes now
--      add a damped bonus instead of being discarded by the max.
--
--   2. Step 8 computes TARGET_RELEVANCE_SCORE as GREATEST(70, TARGET_MATCH_SCORE),
--      which collapses a domain match (100) and a product-name match (60) toward
--      the same value. This step reads the raw TARGET_MATCH_SCORE instead:
--      matching bankofbaroda.in is far stronger evidence than matching the word
--      "Baroda", and the builder already scores that distinction precisely.
--
-- Recency is applied in the views, not the dynamic table. A dynamic table that
-- called CURRENT_TIMESTAMP() would freeze "now" at refresh time and drift
-- between refreshes; age belongs to read time. The dynamic table therefore
-- stores the three time-independent factors and the views apply decay on query.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

-- -----------------------------------------------------------------------------
-- Document-level factors (time independent).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = '30 MINUTE'
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH DOC_CLAIM_STATS AS (
    SELECT
      DOC_ID,
      DEDUPE_KEY,
      ORG_ID,
      COUNT(*) AS CLAIM_COUNT,
      COUNT_IF(IS_GROUNDED) AS GROUNDED_CLAIM_COUNT,
      MAX(CORROBORATION_COUNT) AS MAX_CORROBORATION_COUNT,
      MAX(DISPUTE_COUNT) AS MAX_DISPUTE_COUNT,
      -- QUANTITY_CLAIMED is already NULLed in step 12 when its quote failed
      -- verification, so an invented record count cannot reach severity here.
      MAX(QUANTITY_CLAIMED) AS MAX_QUANTITY_CLAIMED,
      ARRAY_AGG(DISTINCT CLAIM_STATUS) AS CLAIM_STATUSES
    FROM NOCTURNE.RAW.DT_L3_CLAIM_CORROBORATION
    GROUP BY DOC_ID, DEDUPE_KEY, ORG_ID
  ),
  DOC_ACTOR AS (
    SELECT
      DOC_ID,
      DEDUPE_KEY,
      ORG_ID,
      MAX(ACTOR_CREDIBILITY_SCORE) AS ACTOR_CREDIBILITY_SCORE,
      MAX_BY(ACTOR_NODE_KEY, ACTOR_CREDIBILITY_SCORE) AS ACTOR_NODE_KEY,
      MAX_BY(ACTOR_NAME, ACTOR_CREDIBILITY_SCORE) AS ACTOR_NAME
    FROM NOCTURNE.RAW.DT_L3_ACTOR_ORG_PATHS
    GROUP BY DOC_ID, DEDUPE_KEY, ORG_ID
  ),
  DOC_GRAPH_ORG AS (
    SELECT
      DOC_ID,
      DEDUPE_KEY,
      ORG_ID,
      BOOLOR_AGG(IS_MONITORED_ORG) AS GRAPH_ORG_RESOLVED
    FROM NOCTURNE.RAW.DT_L2_ENTITIES
    GROUP BY DOC_ID, DEDUPE_KEY, ORG_ID
  ),
  BASE AS (
    SELECT
      PAGE.DOC_ID,
      PAGE.DEDUPE_KEY,
      PAGE.ORG_ID,
      PAGE.URL,
      PAGE.TITLE,
      PAGE.FETCHED_AT,
      PAGE.CANONICAL_NAME,
      PAGE.RELATIONSHIP_LABEL,
      PAGE.EVIDENCE_SCORE,
      PAGE.STRONG_INDICATOR_COUNT,
      PAGE.TARGET_MATCH_SCORE,
      PAGE.TARGET_ANCHOR_TYPE,
      PAGE.PRELIMINARY_SEVERITY_SCORE,
      PAGE.PRELIMINARY_SEVERITY_BAND,
      COALESCE(PAGE.HAS_CREDENTIAL_LEAK, FALSE) AS HAS_CREDENTIAL_LEAK,
      COALESCE(PAGE.HAS_CORPORATE_DATA_LEAK, FALSE) AS HAS_CORPORATE_DATA_LEAK,
      COALESCE(PAGE.HAS_PII_LEAK, FALSE) AS HAS_PII_LEAK,
      COALESCE(PAGE.HAS_FINANCIAL_LEAK, FALSE) AS HAS_FINANCIAL_LEAK,
      COALESCE(PAGE.HAS_MALWARE_EXPLOIT_LEAK, FALSE) AS HAS_MALWARE_EXPLOIT_LEAK,
      COALESCE(CLAIMS.CLAIM_COUNT, 0) AS CLAIM_COUNT,
      COALESCE(CLAIMS.GROUNDED_CLAIM_COUNT, 0) AS GROUNDED_CLAIM_COUNT,
      COALESCE(CLAIMS.MAX_CORROBORATION_COUNT, 1) AS CORROBORATION_COUNT,
      COALESCE(CLAIMS.MAX_DISPUTE_COUNT, 0) AS DISPUTE_COUNT,
      CLAIMS.MAX_QUANTITY_CLAIMED AS QUANTITY_CLAIMED,
      CLAIMS.CLAIM_STATUSES,
      COALESCE(ACTOR.ACTOR_CREDIBILITY_SCORE, 0) AS ACTOR_CREDIBILITY_SCORE,
      ACTOR.ACTOR_NODE_KEY,
      ACTOR.ACTOR_NAME,
      COALESCE(GRAPH_ORG.GRAPH_ORG_RESOLVED, FALSE) AS GRAPH_ORG_RESOLVED
    FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION AS PAGE
    LEFT JOIN DOC_CLAIM_STATS AS CLAIMS
      ON CLAIMS.DOC_ID = PAGE.DOC_ID
      AND CLAIMS.DEDUPE_KEY = PAGE.DEDUPE_KEY
      AND CLAIMS.ORG_ID = PAGE.ORG_ID
    LEFT JOIN DOC_ACTOR AS ACTOR
      ON ACTOR.DOC_ID = PAGE.DOC_ID
      AND ACTOR.DEDUPE_KEY = PAGE.DEDUPE_KEY
      AND ACTOR.ORG_ID = PAGE.ORG_ID
    LEFT JOIN DOC_GRAPH_ORG AS GRAPH_ORG
      ON GRAPH_ORG.DOC_ID = PAGE.DOC_ID
      AND GRAPH_ORG.DEDUPE_KEY = PAGE.DEDUPE_KEY
      AND GRAPH_ORG.ORG_ID = PAGE.ORG_ID
    WHERE PAGE.RELATIONSHIP_AI_STATUS = 'success'
      AND PAGE.RELATIONSHIP_LABEL <> 'no_leak'
  ),
  FACTORS AS (
    SELECT
      *,
      IFF(HAS_CREDENTIAL_LEAK, 1, 0)
        + IFF(HAS_CORPORATE_DATA_LEAK, 1, 0)
        + IFF(HAS_PII_LEAK, 1, 0)
        + IFF(HAS_FINANCIAL_LEAK, 1, 0)
        + IFF(HAS_MALWARE_EXPLOIT_LEAK, 1, 0) AS LEAK_TYPE_COUNT,
      GREATEST(
        IFF(HAS_FINANCIAL_LEAK, 90, 0),
        IFF(HAS_CREDENTIAL_LEAK, 85, 0),
        IFF(HAS_PII_LEAK, 85, 0),
        IFF(HAS_CORPORATE_DATA_LEAK, 75, 0),
        IFF(HAS_MALWARE_EXPLOIT_LEAK, 70, 0)
      ) AS MAX_TYPE_WEIGHT,
      CASE
        WHEN QUANTITY_CLAIMED IS NULL THEN 0
        WHEN QUANTITY_CLAIMED >= 1000000 THEN 10
        WHEN QUANTITY_CLAIMED >= 100000 THEN 7
        WHEN QUANTITY_CLAIMED >= 10000 THEN 4
        WHEN QUANTITY_CLAIMED >= 1000 THEN 2
        ELSE 0
      END AS SCALE_BONUS,
      CASE
        WHEN CLAIM_COUNT = 0 THEN NULL
        ELSE GROUNDED_CLAIM_COUNT / CLAIM_COUNT::FLOAT
      END AS CLAIM_GROUNDING_RATE
    FROM BASE
  ),
  SCORED AS (
    SELECT
      *,
      -- IMPACT: how bad the data is if the claim is true. Additional leak
      -- classes compound rather than being discarded by the max.
      LEAST(100,
        GREATEST(50, COALESCE(EVIDENCE_SCORE, 0), MAX_TYPE_WEIGHT)
        + 5 * GREATEST(0, LEAK_TYPE_COUNT - 1)
        + SCALE_BONUS
      ) AS IMPACT_FACTOR,
      -- CONFIDENCE: whether the claim should be believed. Weights sum to 1.00.
      LEAST(1.00,
          0.40
        + 0.25 * COALESCE(CLAIM_GROUNDING_RATE, 0)
        + 0.15 * LEAST(1.0, (CORROBORATION_COUNT - 1) / 2.0)
        + 0.12 * (ACTOR_CREDIBILITY_SCORE / 100.0)
        + 0.08 * IFF(COALESCE(STRONG_INDICATOR_COUNT, 0) > 0, 1, 0)
      ) AS CONFIDENCE_FACTOR,
      -- ATTRIBUTION: whether the leak is really the monitored organization's.
      -- Raw anchor score, discounted when the extraction model did not
      -- independently name an organization resolving to the monitored one.
      GREATEST(0.30,
        (COALESCE(TARGET_MATCH_SCORE, 0) / 100.0)
        * IFF(GRAPH_ORG_RESOLVED, 1.00, 0.85)
      ) AS ATTRIBUTION_FACTOR
    FROM FACTORS
  )
  SELECT
    DOC_ID,
    DEDUPE_KEY,
    ORG_ID,
    URL,
    TITLE,
    CANONICAL_NAME,
    FETCHED_AT,
    RELATIONSHIP_LABEL,
    PRELIMINARY_SEVERITY_SCORE,
    PRELIMINARY_SEVERITY_BAND,
    IMPACT_FACTOR,
    CONFIDENCE_FACTOR,
    ATTRIBUTION_FACTOR,
    -- Severity before time decay. The views multiply this by RECENCY.
    IMPACT_FACTOR * CONFIDENCE_FACTOR * ATTRIBUTION_FACTOR AS BASE_SEVERITY_SCORE,
    LEAK_TYPE_COUNT,
    MAX_TYPE_WEIGHT,
    SCALE_BONUS,
    QUANTITY_CLAIMED,
    CLAIM_COUNT,
    GROUNDED_CLAIM_COUNT,
    CLAIM_GROUNDING_RATE,
    CORROBORATION_COUNT,
    DISPUTE_COUNT,
    CLAIM_STATUSES,
    ACTOR_NODE_KEY,
    ACTOR_NAME,
    ACTOR_CREDIBILITY_SCORE,
    GRAPH_ORG_RESOLVED,
    TARGET_MATCH_SCORE,
    TARGET_ANCHOR_TYPE,
    EVIDENCE_SCORE,
    STRONG_INDICATOR_COUNT,
    -- An incident is one organization plus one actor. Ten mirrors of a single
    -- credential dump collapse into one incident; ten independent actors do
    -- not. Documents with no identified actor fall back to their content hash,
    -- which keeps them separate rather than silently merging them.
    SHA2(ORG_ID || '|' || COALESCE(ACTOR_NODE_KEY, DEDUPE_KEY)) AS INCIDENT_KEY,
    'severity_v2_graph' AS FINAL_SEVERITY_METHOD_VERSION
  FROM SCORED;

-- -----------------------------------------------------------------------------
-- Document severity with time decay applied at read time.
-- -----------------------------------------------------------------------------
-- 180-day half-life, floored at 0.60: leaks lose urgency but never become
-- irrelevant. FETCHED_AT is crawl time, not publication time, which overstates
-- freshness for old listings discovered late. Stated plainly here because it is
-- a real limitation of crawl-derived data, not something to paper over.
CREATE OR REPLACE VIEW NOCTURNE.RAW.VW_L4_DOCUMENT_SEVERITY AS
  WITH DECAYED AS (
    SELECT
      *,
      LEAST(1.00, 0.60 + 0.40 * EXP(
        -LN(2)
        * GREATEST(0, DATEDIFF('day', FETCHED_AT, CURRENT_TIMESTAMP()))
        / 180.0
      )) AS RECENCY_FACTOR
    FROM NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY
  ),
  FINAL AS (
    SELECT
      *,
      ROUND(BASE_SEVERITY_SCORE * RECENCY_FACTOR) AS FINAL_SEVERITY_SCORE
    FROM DECAYED
  )
  SELECT
    *,
    -- Same thresholds as step 9 so preliminary and final are comparable.
    CASE
      WHEN FINAL_SEVERITY_SCORE <= 19 THEN 'informational'
      WHEN FINAL_SEVERITY_SCORE <= 39 THEN 'low'
      WHEN FINAL_SEVERITY_SCORE <= 59 THEN 'medium'
      WHEN FINAL_SEVERITY_SCORE <= 79 THEN 'high'
      ELSE 'critical'
    END AS FINAL_SEVERITY_BAND,
    FINAL_SEVERITY_SCORE - COALESCE(PRELIMINARY_SEVERITY_SCORE, 0)
      AS SEVERITY_DELTA,
    -- Reason codes make the score auditable rather than a black box, and they
    -- are what turns the dashboard from a number into an explanation.
    ARRAY_COMPACT(ARRAY_CONSTRUCT(
      IFF(CORROBORATION_COUNT >= 3, 'corroborated_by_3_or_more_sources', NULL),
      IFF(CORROBORATION_COUNT = 2, 'partially_corroborated', NULL),
      IFF(CORROBORATION_COUNT <= 1, 'single_source_only', NULL),
      IFF(DISPUTE_COUNT > 0, 'contested_by_another_source', NULL),
      IFF(CLAIM_GROUNDING_RATE IS NOT NULL AND CLAIM_GROUNDING_RATE < 0.5,
          'weak_extraction_grounding', NULL),
      IFF(CLAIM_COUNT = 0, 'no_claims_extracted', NULL),
      IFF(TARGET_MATCH_SCORE >= 100, 'domain_level_attribution', NULL),
      IFF(TARGET_MATCH_SCORE <= 60, 'weak_name_attribution', NULL),
      IFF(NOT GRAPH_ORG_RESOLVED, 'org_not_confirmed_by_extraction', NULL),
      IFF(ACTOR_CREDIBILITY_SCORE = 0, 'unattributed_or_unproven_actor', NULL),
      IFF(ACTOR_CREDIBILITY_SCORE >= 60, 'actor_with_corroborated_history', NULL),
      IFF(COALESCE(STRONG_INDICATOR_COUNT, 0) > 0, 'strong_secret_material_present', NULL),
      IFF(QUANTITY_CLAIMED >= 100000, 'large_claimed_record_volume', NULL)
    )) AS SEVERITY_REASONS
  FROM FINAL;

-- -----------------------------------------------------------------------------
-- Incident rollup.
-- -----------------------------------------------------------------------------
-- The unit an organization actually triages. DOC_COUNT is spread of the same
-- incident; ACTOR_COUNT at org level is the pressure signal.
CREATE OR REPLACE VIEW NOCTURNE.RAW.VW_L4_INCIDENT_SEVERITY AS
  SELECT
    INCIDENT_KEY,
    ORG_ID,
    ANY_VALUE(CANONICAL_NAME) AS CANONICAL_NAME,
    MAX_BY(ACTOR_NAME, FINAL_SEVERITY_SCORE) AS ACTOR_NAME,
    MAX_BY(ACTOR_NODE_KEY, FINAL_SEVERITY_SCORE) AS ACTOR_NODE_KEY,
    MAX(FINAL_SEVERITY_SCORE) AS INCIDENT_SEVERITY_SCORE,
    MAX_BY(FINAL_SEVERITY_BAND, FINAL_SEVERITY_SCORE) AS INCIDENT_SEVERITY_BAND,
    MAX_BY(PRELIMINARY_SEVERITY_SCORE, FINAL_SEVERITY_SCORE)
      AS PRELIMINARY_SEVERITY_SCORE,
    MAX_BY(SEVERITY_REASONS, FINAL_SEVERITY_SCORE) AS SEVERITY_REASONS,
    MAX_BY(URL, FINAL_SEVERITY_SCORE) AS TOP_URL,
    MAX_BY(TITLE, FINAL_SEVERITY_SCORE) AS TOP_TITLE,
    COUNT(DISTINCT DEDUPE_KEY) AS DOC_COUNT,
    MAX(CORROBORATION_COUNT) AS CORROBORATION_COUNT,
    MAX(ACTOR_CREDIBILITY_SCORE) AS ACTOR_CREDIBILITY_SCORE,
    BOOLOR_AGG(GRAPH_ORG_RESOLVED) AS GRAPH_ORG_RESOLVED,
    MIN(FETCHED_AT) AS FIRST_SEEN,
    MAX(FETCHED_AT) AS LAST_SEEN
  FROM NOCTURNE.RAW.VW_L4_DOCUMENT_SEVERITY
  GROUP BY INCIDENT_KEY, ORG_ID;

-- -----------------------------------------------------------------------------
-- Organization posture: the dashboard headline.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW NOCTURNE.RAW.VW_L4_ORG_POSTURE AS
  SELECT
    ORG_ID,
    ANY_VALUE(CANONICAL_NAME) AS CANONICAL_NAME,
    MAX(INCIDENT_SEVERITY_SCORE) AS TOP_SEVERITY_SCORE,
    MAX_BY(INCIDENT_SEVERITY_BAND, INCIDENT_SEVERITY_SCORE) AS TOP_SEVERITY_BAND,
    COUNT(*) AS INCIDENT_COUNT,
    COUNT_IF(INCIDENT_SEVERITY_BAND = 'critical') AS CRITICAL_INCIDENTS,
    COUNT_IF(INCIDENT_SEVERITY_BAND = 'high') AS HIGH_INCIDENTS,
    COUNT(DISTINCT ACTOR_NODE_KEY) AS DISTINCT_ACTORS,
    SUM(DOC_COUNT) AS TOTAL_DOCUMENTS,
    MAX(LAST_SEEN) AS LAST_ACTIVITY
  FROM NOCTURNE.RAW.VW_L4_INCIDENT_SEVERITY
  GROUP BY ORG_ID;

-- =============================================================================
-- Validation.
-- =============================================================================
-- Precision and recall need labels that do not exist yet. These monotonicity
-- assertions are what can be checked without them, and they catch the failure
-- that actually matters: a scoring change that silently inverts the ranking.
-- Each must return zero.
--
-- -- More corroboration must never lower confidence.
-- SELECT COUNT(*) AS VIOLATIONS
-- FROM NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY AS LOWER_CORROBORATION
-- INNER JOIN NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY AS HIGHER_CORROBORATION
--   ON LOWER_CORROBORATION.ORG_ID = HIGHER_CORROBORATION.ORG_ID
--   AND LOWER_CORROBORATION.CLAIM_GROUNDING_RATE
--     = HIGHER_CORROBORATION.CLAIM_GROUNDING_RATE
--   AND LOWER_CORROBORATION.ACTOR_CREDIBILITY_SCORE
--     = HIGHER_CORROBORATION.ACTOR_CREDIBILITY_SCORE
--   AND LOWER_CORROBORATION.STRONG_INDICATOR_COUNT
--     = HIGHER_CORROBORATION.STRONG_INDICATOR_COUNT
-- WHERE HIGHER_CORROBORATION.CORROBORATION_COUNT
--     > LOWER_CORROBORATION.CORROBORATION_COUNT
--   AND HIGHER_CORROBORATION.CONFIDENCE_FACTOR
--     < LOWER_CORROBORATION.CONFIDENCE_FACTOR;
--
-- -- More leak types must never lower impact.
-- SELECT COUNT(*) AS VIOLATIONS
-- FROM NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY AS FEWER_TYPES
-- INNER JOIN NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY AS MORE_TYPES
--   ON FEWER_TYPES.MAX_TYPE_WEIGHT = MORE_TYPES.MAX_TYPE_WEIGHT
--   AND FEWER_TYPES.EVIDENCE_SCORE = MORE_TYPES.EVIDENCE_SCORE
--   AND FEWER_TYPES.SCALE_BONUS = MORE_TYPES.SCALE_BONUS
-- WHERE MORE_TYPES.LEAK_TYPE_COUNT > FEWER_TYPES.LEAK_TYPE_COUNT
--   AND MORE_TYPES.IMPACT_FACTOR < FEWER_TYPES.IMPACT_FACTOR;
--
-- -- Every factor must stay inside its documented range.
-- SELECT COUNT(*) AS VIOLATIONS
-- FROM NOCTURNE.RAW.DT_L4_DOCUMENT_SEVERITY
-- WHERE IMPACT_FACTOR NOT BETWEEN 0 AND 100
--   OR CONFIDENCE_FACTOR NOT BETWEEN 0.40 AND 1.00
--   OR ATTRIBUTION_FACTOR NOT BETWEEN 0.30 AND 1.00;

-- =============================================================================
-- Demo queries.
-- =============================================================================
-- The headline: where the graph moved the score, and why. Large negative
-- deltas are the adversarial-boast case, large positive ones the corroborated
-- campaign that L1 alone underrated.
--
-- SELECT
--   TITLE, PRELIMINARY_SEVERITY_BAND, FINAL_SEVERITY_BAND,
--   PRELIMINARY_SEVERITY_SCORE, FINAL_SEVERITY_SCORE, SEVERITY_DELTA,
--   CORROBORATION_COUNT, ACTOR_NAME, SEVERITY_REASONS
-- FROM NOCTURNE.RAW.VW_L4_DOCUMENT_SEVERITY
-- ORDER BY ABS(SEVERITY_DELTA) DESC
-- LIMIT 20;
--
-- SELECT * FROM NOCTURNE.RAW.VW_L4_ORG_POSTURE;
--
-- SELECT * FROM NOCTURNE.RAW.VW_L4_INCIDENT_SEVERITY
-- ORDER BY INCIDENT_SEVERITY_SCORE DESC LIMIT 10;

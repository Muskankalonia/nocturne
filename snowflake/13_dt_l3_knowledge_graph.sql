-- =============================================================================
-- Nocturne Pipeline: Step 13 - L3 Knowledge Graph
-- =============================================================================
-- Collapses per-document L2 fragments into a single cross-document graph, then
-- derives the three signals that only a graph can produce: how many independent
-- sources corroborate a claim, whether the actor making it has a track record,
-- and which claims therefore deserve a status better than "unverified".
--
-- Entity resolution is the NODE_KEY hash computed in step 12. Nothing here
-- clusters or fuzzy-matches; identical normalized names in the same type are
-- the same node by construction, which makes the graph reproducible and makes
-- a wrong merge traceable to one normalization rule rather than a threshold.
--
-- Corroboration counts DISTINCT DEDUPE_KEY, never DOC_ID. DEDUPE_KEY is the
-- content hash, so a page mirrored across five .onion addresses corroborates
-- itself exactly zero times. Counting DOC_ID would manufacture confidence from
-- duplication, which is the most common way a threat-intel feed lies to itself.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

-- -----------------------------------------------------------------------------
-- Nodes.
-- -----------------------------------------------------------------------------
-- One row per resolved entity across the whole corpus. GROUNDED_MENTION_COUNT
-- is kept beside MENTION_COUNT rather than filtering ungrounded mentions out:
-- an entity extracted without a verbatim quote is weak evidence, not absent
-- evidence, and step 14 prices that in through the grounding rate instead of
-- deleting the node and hiding the uncertainty.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DIM_GRAPH_NODE
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  SELECT
    NODE_KEY,
    ENTITY_TYPE AS NODE_TYPE,
    NORMALIZED_NAME,
    -- Most frequent surface form, so the dashboard shows "NightFox" rather
    -- than whichever casing happened to sort last.
    MODE(ENTITY_NAME) AS DISPLAY_NAME,
    ORG_ID,
    COUNT(*) AS MENTION_COUNT,
    COUNT_IF(IS_GROUNDED) AS GROUNDED_MENTION_COUNT,
    COUNT(DISTINCT DEDUPE_KEY) AS DOC_COUNT,
    BOOLOR_AGG(IS_MONITORED_ORG) AS IS_MONITORED_ORG,
    MIN(FETCHED_AT) AS FIRST_SEEN,
    MAX(FETCHED_AT) AS LAST_SEEN
  FROM NOCTURNE.RAW.DT_L2_ENTITIES
  GROUP BY NODE_KEY, ENTITY_TYPE, NORMALIZED_NAME, ORG_ID;

-- -----------------------------------------------------------------------------
-- Edges.
-- -----------------------------------------------------------------------------
-- One row per distinct (source, type, target) with provenance aggregated.
-- DT_L2_EDGES remains the per-document record; this is the graph view of it.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.FCT_GRAPH_EDGE
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  SELECT
    SHA2(ORG_ID || '|' || SOURCE_KEY || '|' || EDGE_TYPE || '|' || TARGET_KEY)
      AS GRAPH_EDGE_KEY,
    ORG_ID,
    SOURCE_KEY,
    EDGE_TYPE,
    TARGET_KEY,
    MODE(SOURCE_KIND) AS SOURCE_KIND,
    MODE(TARGET_KIND) AS TARGET_KIND,
    COUNT(DISTINCT DEDUPE_KEY) AS DOC_COUNT,
    COUNT_IF(IS_GROUNDED) AS GROUNDED_COUNT,
    -- One representative quote so the UI can justify the edge without a
    -- second round trip to the per-document table.
    MAX(CASE WHEN IS_GROUNDED THEN EVIDENCE_TEXT END) AS SAMPLE_EVIDENCE_TEXT,
    ARRAY_AGG(DISTINCT DEDUPE_KEY) AS SOURCE_DEDUPE_KEYS,
    MIN(FETCHED_AT) AS FIRST_SEEN,
    MAX(FETCHED_AT) AS LAST_SEEN
  FROM NOCTURNE.RAW.DT_L2_EDGES
  GROUP BY ORG_ID, SOURCE_KEY, EDGE_TYPE, TARGET_KEY;

-- -----------------------------------------------------------------------------
-- Claim corroboration.
-- -----------------------------------------------------------------------------
-- A claim's subject is the entity it ALLEGEDLY_AFFECTS. Two claims in different
-- documents that point at the same subject node are two independent sources
-- alleging the same thing, which is precisely what a per-document pipeline
-- cannot observe.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L3_CLAIM_CORROBORATION
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH CLAIM_SUBJECT AS (
    SELECT
      EDGE.ORG_ID,
      EDGE.DEDUPE_KEY,
      EDGE.SOURCE_KEY AS CLAIM_KEY,
      EDGE.TARGET_KEY AS SUBJECT_NODE_KEY
    FROM NOCTURNE.RAW.DT_L2_EDGES AS EDGE
    WHERE EDGE.EDGE_TYPE = 'ALLEGEDLY_AFFECTS'
      AND EDGE.SOURCE_KIND = 'claim'
      AND EDGE.TARGET_KIND = 'entity'
  ),
  SUBJECT_TOTALS AS (
    SELECT
      ORG_ID,
      SUBJECT_NODE_KEY,
      COUNT(DISTINCT DEDUPE_KEY) AS CORROBORATION_COUNT
    FROM CLAIM_SUBJECT
    GROUP BY ORG_ID, SUBJECT_NODE_KEY
  ),
  -- A subject is contested when at least one document explicitly disputes a
  -- claim about it. Contested subjects must not be promoted on volume alone.
  SUBJECT_DISPUTES AS (
    SELECT
      SUBJECT.ORG_ID,
      SUBJECT.SUBJECT_NODE_KEY,
      COUNT_IF(CLAIM.CLAIM_STATUS_EXTRACTED = 'disputed') AS DISPUTE_COUNT
    FROM CLAIM_SUBJECT AS SUBJECT
    INNER JOIN NOCTURNE.RAW.DT_L2_CLAIMS AS CLAIM
      ON CLAIM.CLAIM_KEY = SUBJECT.CLAIM_KEY
    GROUP BY SUBJECT.ORG_ID, SUBJECT.SUBJECT_NODE_KEY
  )
  SELECT
    CLAIM.CLAIM_KEY,
    CLAIM.DOC_ID,
    CLAIM.DEDUPE_KEY,
    CLAIM.ORG_ID,
    CLAIM.STATEMENT,
    CLAIM.CLAIM_STATUS_EXTRACTED,
    CLAIM.QUANTITY_CLAIMED,
    CLAIM.IS_GROUNDED,
    CLAIM.EVIDENCE_TEXT,
    CLAIM.EVIDENCE_START,
    CLAIM.EVIDENCE_END,
    SUBJECT.SUBJECT_NODE_KEY,
    NODE.DISPLAY_NAME AS SUBJECT_NAME,
    NODE.NODE_TYPE AS SUBJECT_TYPE,
    COALESCE(NODE.IS_MONITORED_ORG, FALSE) AS SUBJECT_IS_MONITORED_ORG,
    COALESCE(TOTALS.CORROBORATION_COUNT, 1) AS CORROBORATION_COUNT,
    COALESCE(DISPUTES.DISPUTE_COUNT, 0) AS DISPUTE_COUNT,
    -- The status the graph earns, replacing the single-document guess. This is
    -- the one output in the pipeline that provably cannot be produced without
    -- cross-document resolution.
    CASE
      WHEN COALESCE(DISPUTES.DISPUTE_COUNT, 0) > 0 THEN 'disputed'
      WHEN COALESCE(TOTALS.CORROBORATION_COUNT, 1) >= 3 THEN 'corroborated'
      WHEN COALESCE(TOTALS.CORROBORATION_COUNT, 1) = 2
        THEN 'partially_corroborated'
      WHEN CLAIM.CLAIM_STATUS_EXTRACTED = 'self_evidenced' THEN 'self_evidenced'
      ELSE 'unverified'
    END AS CLAIM_STATUS,
    'graph_corroboration_v1' AS CORROBORATION_METHOD_VERSION
  FROM NOCTURNE.RAW.DT_L2_CLAIMS AS CLAIM
  LEFT JOIN CLAIM_SUBJECT AS SUBJECT
    ON SUBJECT.CLAIM_KEY = CLAIM.CLAIM_KEY
  LEFT JOIN SUBJECT_TOTALS AS TOTALS
    ON TOTALS.ORG_ID = SUBJECT.ORG_ID
    AND TOTALS.SUBJECT_NODE_KEY = SUBJECT.SUBJECT_NODE_KEY
  LEFT JOIN SUBJECT_DISPUTES AS DISPUTES
    ON DISPUTES.ORG_ID = SUBJECT.ORG_ID
    AND DISPUTES.SUBJECT_NODE_KEY = SUBJECT.SUBJECT_NODE_KEY
  LEFT JOIN NOCTURNE.RAW.DIM_GRAPH_NODE AS NODE
    ON NODE.NODE_KEY = SUBJECT.SUBJECT_NODE_KEY
    AND NODE.ORG_ID = SUBJECT.ORG_ID;

-- -----------------------------------------------------------------------------
-- Actor credibility.
-- -----------------------------------------------------------------------------
-- A first-time alias asserting a catastrophic breach and a known actor with a
-- corroborated history are not equally believable. Reach across marketplaces
-- matters too: an alias posting on three venues is harder to fabricate than one
-- posting once.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L3_ACTOR_CREDIBILITY
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  WITH CLAIM_AUTHOR AS (
    SELECT
      EDGE.ORG_ID,
      EDGE.DEDUPE_KEY,
      EDGE.SOURCE_KEY AS ACTOR_NODE_KEY,
      EDGE.TARGET_KEY AS CLAIM_KEY
    FROM NOCTURNE.RAW.DT_L2_EDGES AS EDGE
    WHERE EDGE.EDGE_TYPE = 'MADE_CLAIM'
      AND EDGE.SOURCE_ENTITY_TYPE = 'actor_alias'
      AND EDGE.TARGET_KIND = 'claim'
  ),
  ACTOR_VENUES AS (
    SELECT
      EDGE.ORG_ID,
      EDGE.SOURCE_KEY AS ACTOR_NODE_KEY,
      COUNT(DISTINCT EDGE.TARGET_KEY) AS MARKETPLACE_COUNT
    FROM NOCTURNE.RAW.DT_L2_EDGES AS EDGE
    WHERE EDGE.EDGE_TYPE = 'LISTED_ON'
      AND EDGE.SOURCE_ENTITY_TYPE = 'actor_alias'
      AND EDGE.TARGET_ENTITY_TYPE = 'marketplace'
    GROUP BY EDGE.ORG_ID, EDGE.SOURCE_KEY
  ),
  ACTOR_CLAIMS AS (
    SELECT
      AUTHOR.ORG_ID,
      AUTHOR.ACTOR_NODE_KEY,
      COUNT(DISTINCT AUTHOR.CLAIM_KEY) AS TOTAL_CLAIM_COUNT,
      COUNT(DISTINCT AUTHOR.DEDUPE_KEY) AS DOC_COUNT,
      COUNT(DISTINCT CASE
        WHEN CORROBORATION.CORROBORATION_COUNT >= 2
          AND CORROBORATION.DISPUTE_COUNT = 0
        THEN AUTHOR.CLAIM_KEY
      END) AS CORROBORATED_CLAIM_COUNT,
      COUNT(DISTINCT CASE
        WHEN CORROBORATION.DISPUTE_COUNT > 0 THEN AUTHOR.CLAIM_KEY
      END) AS DISPUTED_CLAIM_COUNT
    FROM CLAIM_AUTHOR AS AUTHOR
    LEFT JOIN NOCTURNE.RAW.DT_L3_CLAIM_CORROBORATION AS CORROBORATION
      ON CORROBORATION.CLAIM_KEY = AUTHOR.CLAIM_KEY
    GROUP BY AUTHOR.ORG_ID, AUTHOR.ACTOR_NODE_KEY
  )
  SELECT
    CLAIMS.ORG_ID,
    CLAIMS.ACTOR_NODE_KEY,
    NODE.DISPLAY_NAME AS ACTOR_NAME,
    CLAIMS.TOTAL_CLAIM_COUNT,
    CLAIMS.CORROBORATED_CLAIM_COUNT,
    CLAIMS.DISPUTED_CLAIM_COUNT,
    CLAIMS.DOC_COUNT,
    COALESCE(VENUES.MARKETPLACE_COUNT, 0) AS MARKETPLACE_COUNT,
    NODE.FIRST_SEEN,
    NODE.LAST_SEEN,
    -- 0-100, consumed by step 14. Corroborated history dominates; venue reach
    -- and repeat sightings contribute; explicit disputes subtract.
    GREATEST(0, LEAST(100,
        40 * LEAST(1.0, CLAIMS.CORROBORATED_CLAIM_COUNT / 3.0)
      + 25 * LEAST(1.0, COALESCE(VENUES.MARKETPLACE_COUNT, 0) / 3.0)
      + 20 * LEAST(1.0, CLAIMS.DOC_COUNT / 3.0)
      + 15
      - 20 * LEAST(1.0, CLAIMS.DISPUTED_CLAIM_COUNT / 2.0)
    )) AS ACTOR_CREDIBILITY_SCORE,
    'actor_credibility_v1' AS ACTOR_METHOD_VERSION
  FROM ACTOR_CLAIMS AS CLAIMS
  LEFT JOIN ACTOR_VENUES AS VENUES
    ON VENUES.ORG_ID = CLAIMS.ORG_ID
    AND VENUES.ACTOR_NODE_KEY = CLAIMS.ACTOR_NODE_KEY
  LEFT JOIN NOCTURNE.RAW.DIM_GRAPH_NODE AS NODE
    ON NODE.NODE_KEY = CLAIMS.ACTOR_NODE_KEY
    AND NODE.ORG_ID = CLAIMS.ORG_ID;

-- -----------------------------------------------------------------------------
-- Actor to organization paths.
-- -----------------------------------------------------------------------------
-- The two-hop traversal the dashboard and step 14 both need: which actor,
-- through which claim, allegedly affects which organization. Written as an
-- explicit join rather than a recursive CTE because the hop count is fixed and
-- known; see the commented query at the end of this file for the general
-- variable-depth traversal.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L3_ACTOR_ORG_PATHS
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = AUTO
  INITIALIZE = ON_CREATE
AS
  SELECT
    AUTHOR_EDGE.ORG_ID,
    AUTHOR_EDGE.DOC_ID,
    AUTHOR_EDGE.DEDUPE_KEY,
    AUTHOR_EDGE.SOURCE_KEY AS ACTOR_NODE_KEY,
    ACTOR_NODE.DISPLAY_NAME AS ACTOR_NAME,
    CORROBORATION.CLAIM_KEY,
    CORROBORATION.STATEMENT,
    CORROBORATION.CLAIM_STATUS,
    CORROBORATION.CORROBORATION_COUNT,
    CORROBORATION.SUBJECT_NODE_KEY AS ORG_NODE_KEY,
    CORROBORATION.SUBJECT_NAME AS ORG_NAME,
    CORROBORATION.SUBJECT_IS_MONITORED_ORG,
    COALESCE(ACTOR.ACTOR_CREDIBILITY_SCORE, 0) AS ACTOR_CREDIBILITY_SCORE
  FROM NOCTURNE.RAW.DT_L2_EDGES AS AUTHOR_EDGE
  INNER JOIN NOCTURNE.RAW.DT_L3_CLAIM_CORROBORATION AS CORROBORATION
    ON CORROBORATION.CLAIM_KEY = AUTHOR_EDGE.TARGET_KEY
  LEFT JOIN NOCTURNE.RAW.DIM_GRAPH_NODE AS ACTOR_NODE
    ON ACTOR_NODE.NODE_KEY = AUTHOR_EDGE.SOURCE_KEY
    AND ACTOR_NODE.ORG_ID = AUTHOR_EDGE.ORG_ID
  LEFT JOIN NOCTURNE.RAW.DT_L3_ACTOR_CREDIBILITY AS ACTOR
    ON ACTOR.ACTOR_NODE_KEY = AUTHOR_EDGE.SOURCE_KEY
    AND ACTOR.ORG_ID = AUTHOR_EDGE.ORG_ID
  WHERE AUTHOR_EDGE.EDGE_TYPE = 'MADE_CLAIM'
    AND AUTHOR_EDGE.SOURCE_ENTITY_TYPE = 'actor_alias'
    AND AUTHOR_EDGE.TARGET_KIND = 'claim'
    AND CORROBORATION.SUBJECT_NODE_KEY IS NOT NULL;

-- =============================================================================
-- Ad hoc: variable-depth traversal.
-- =============================================================================
-- Run directly in Snowsight to explore an actor's neighbourhood to any depth.
-- Kept out of the deployed objects because the pipeline only needs fixed hops,
-- and an unbounded recursion is a foot-gun in a scheduled refresh.
--
-- WITH RECURSIVE TRAVERSAL AS (
--   SELECT
--     NODE_KEY AS FROM_KEY,
--     NODE_KEY AS TO_KEY,
--     0 AS DEPTH,
--     ARRAY_CONSTRUCT(NODE_KEY) AS VISITED
--   FROM NOCTURNE.RAW.DIM_GRAPH_NODE
--   WHERE DISPLAY_NAME = 'NightFox'          -- start node
--
--   UNION ALL
--
--   SELECT
--     TRAVERSAL.FROM_KEY,
--     EDGE.TARGET_KEY,
--     TRAVERSAL.DEPTH + 1,
--     ARRAY_APPEND(TRAVERSAL.VISITED, EDGE.TARGET_KEY)
--   FROM TRAVERSAL
--   INNER JOIN NOCTURNE.RAW.FCT_GRAPH_EDGE AS EDGE
--     ON EDGE.SOURCE_KEY = TRAVERSAL.TO_KEY
--   WHERE TRAVERSAL.DEPTH < 3                -- bound the recursion
--     AND NOT ARRAY_CONTAINS(EDGE.TARGET_KEY::VARIANT, TRAVERSAL.VISITED)
-- )
-- SELECT
--   TRAVERSAL.DEPTH,
--   NODE.NODE_TYPE,
--   NODE.DISPLAY_NAME,
--   NODE.DOC_COUNT
-- FROM TRAVERSAL
-- LEFT JOIN NOCTURNE.RAW.DIM_GRAPH_NODE AS NODE
--   ON NODE.NODE_KEY = TRAVERSAL.TO_KEY
-- ORDER BY TRAVERSAL.DEPTH, NODE.DISPLAY_NAME;

-- Safe operational checks.
-- SELECT NODE_TYPE, COUNT(*) AS NODES, SUM(DOC_COUNT) AS TOTAL_SIGHTINGS
-- FROM NOCTURNE.RAW.DIM_GRAPH_NODE GROUP BY NODE_TYPE ORDER BY NODES DESC;
--
-- -- Entities resolved across more than one document prove the graph is working.
-- SELECT COUNT(*) AS MULTI_DOC_ENTITIES
-- FROM NOCTURNE.RAW.DIM_GRAPH_NODE WHERE DOC_COUNT > 1;
--
-- SELECT CLAIM_STATUS, COUNT(*) AS CLAIMS
-- FROM NOCTURNE.RAW.DT_L3_CLAIM_CORROBORATION GROUP BY CLAIM_STATUS;

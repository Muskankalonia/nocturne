-- =============================================================================
-- Nocturne regression test: deterministic L2 grounding and target routing
-- =============================================================================
-- Prerequisite: 10_dt_l2_grounding_routing.sql has been deployed.
--
-- This test never calls Cortex and never mutates pipeline tables. It uses mocked
-- extraction JSON to exercise the same grounding, name-resolution, endpoint,
-- and routing rules used by step 10. Every returned row must show PASS.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

-- Formatting differences are tolerated, but unsupported quotes are rejected.
WITH CASES AS (
  SELECT
    'exact_evidence' AS TEST_CASE,
    'Bank of Baroda logs can be purchased here.' AS DOCUMENT_TEXT,
    'Bank of Baroda logs can be purchased here.' AS EVIDENCE_TEXT,
    'exact' AS EXPECTED_LEVEL
  UNION ALL
  SELECT
    'normalized_unicode_and_whitespace',
    'Bank of Baroda’s logs  can be purchased here.',
    'Bank of Baroda''s logs can be purchased here.',
    'normalized'
  UNION ALL
  SELECT
    'unsupported_evidence',
    'This page contains no sale or breach statement.',
    'Bank of Baroda customer database is for sale.',
    'unmatched'
), RESULTS AS (
  SELECT
    TEST_CASE,
    EXPECTED_LEVEL,
    NOCTURNE.RAW.GROUND_EVIDENCE(
      DOCUMENT_TEXT,
      EVIDENCE_TEXT
    ):level::STRING AS ACTUAL_LEVEL
  FROM CASES
)
SELECT
  TEST_CASE,
  EXPECTED_LEVEL,
  ACTUAL_LEVEL,
  IFF(ACTUAL_LEVEL = EXPECTED_LEVEL, 'PASS', 'FAIL') AS TEST_RESULT
FROM RESULTS
ORDER BY TEST_CASE;

-- Target-name thresholds: exact short aliases are allowed, approximate short
-- aliases are not, and products cannot establish organization ownership.
WITH CASES AS (
  SELECT
    'exact_canonical_name' AS TEST_CASE,
    'organization' AS ENTITY_TYPE,
    'Bank of Baroda' AS OBSERVED_NAME,
    'confirmed' AS EXPECTED_STATUS
  UNION ALL
  SELECT 'exact_short_alias', 'organization', 'BOB', 'confirmed'
  UNION ALL
  SELECT 'approximate_short_alias', 'organization', 'BOBB', 'unmatched'
  UNION ALL
  SELECT
    'high_confidence_misspelling',
    'organization',
    'Bank of Barodaa',
    'confirmed'
  UNION ALL
  SELECT
    'generic_indian_bank',
    'organization',
    'Indian bank',
    'unmatched'
  UNION ALL
  SELECT
    'exact_target_domain',
    'domain',
    'https://www.bankofbaroda.in/',
    'confirmed'
  UNION ALL
  SELECT
    'configured_product_is_context_only',
    'product',
    'bob World',
    'context_only'
), TARGET_NAMES AS (
  SELECT
    'canonical_name' AS MATCH_SOURCE,
    NOCTURNE.RAW.NORMALIZE_ENTITY_NAME('Bank of Baroda') AS TARGET_NAME
  UNION ALL
  SELECT 'alias', NOCTURNE.RAW.NORMALIZE_ENTITY_NAME('BOB')
  UNION ALL
  SELECT 'alias', NOCTURNE.RAW.NORMALIZE_ENTITY_NAME('Bank Baroda')
), NAME_SCORES AS (
  SELECT
    CASES.*,
    TARGET_NAMES.MATCH_SOURCE,
    TARGET_NAMES.TARGET_NAME,
    NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(CASES.OBSERVED_NAME)
      AS OBSERVED_NORMALIZED_NAME,
    OBSERVED_NORMALIZED_NAME = TARGET_NAMES.TARGET_NAME AS IS_EXACT,
    JAROWINKLER_SIMILARITY(
      OBSERVED_NORMALIZED_NAME,
      TARGET_NAMES.TARGET_NAME
    ) AS SIMILARITY
  FROM CASES
  INNER JOIN TARGET_NAMES
    ON CASES.ENTITY_TYPE = 'organization'
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY CASES.TEST_CASE
    ORDER BY
      IS_EXACT DESC,
      SIMILARITY DESC,
      IFF(TARGET_NAMES.MATCH_SOURCE = 'canonical_name', 1, 0) DESC
  ) = 1
), RESOLVED AS (
  SELECT
    CASES.TEST_CASE,
    CASES.EXPECTED_STATUS,
    CASES.ENTITY_TYPE,
    CASES.OBSERVED_NAME,
    COALESCE(NAME_SCORES.SIMILARITY, 0) AS SIMILARITY,
    CASE
      WHEN CASES.ENTITY_TYPE = 'domain'
        AND NOCTURNE.RAW.NORMALIZE_DOMAIN(CASES.OBSERVED_NAME)
          = NOCTURNE.RAW.NORMALIZE_DOMAIN('bankofbaroda.in')
        THEN 'confirmed'
      WHEN CASES.ENTITY_TYPE = 'product'
        AND NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(CASES.OBSERVED_NAME)
          = NOCTURNE.RAW.NORMALIZE_ENTITY_NAME('bob World')
        THEN 'context_only'
      WHEN CASES.ENTITY_TYPE = 'organization'
        AND NAME_SCORES.IS_EXACT THEN 'confirmed'
      WHEN CASES.ENTITY_TYPE = 'organization'
        AND LENGTH(NAME_SCORES.OBSERVED_NORMALIZED_NAME) >= 6
        AND LENGTH(NAME_SCORES.TARGET_NAME) >= 6
        AND NAME_SCORES.SIMILARITY >= 92 THEN 'confirmed'
      WHEN CASES.ENTITY_TYPE = 'organization'
        AND LENGTH(NAME_SCORES.OBSERVED_NORMALIZED_NAME) >= 6
        AND LENGTH(NAME_SCORES.TARGET_NAME) >= 6
        AND NAME_SCORES.SIMILARITY BETWEEN 85 AND 91 THEN 'ambiguous'
      ELSE 'unmatched'
    END AS ACTUAL_STATUS
  FROM CASES
  LEFT JOIN NAME_SCORES
    ON NAME_SCORES.TEST_CASE = CASES.TEST_CASE
)
SELECT
  TEST_CASE,
  OBSERVED_NAME,
  SIMILARITY,
  EXPECTED_STATUS,
  ACTUAL_STATUS,
  IFF(ACTUAL_STATUS = EXPECTED_STATUS, 'PASS', 'FAIL') AS TEST_RESULT
FROM RESOLVED
ORDER BY TEST_CASE;

-- End-to-end deterministic routing over mocked AI_COMPLETE output. The positive
-- marketplace statement must pass without requiring a leaked sample. A generic
-- bank listing and every malformed extraction must remain out of L3.
WITH FIXTURES AS (
  SELECT
    'explicit_bank_of_baroda_listing' AS TEST_CASE,
    'Bank of Baroda logs can be purchased here.' AS DOCUMENT_TEXT,
    90 AS TARGET_MATCH_SCORE,
    'target_confirmed' AS EXPECTED_ROUTE,
    TRUE AS EXPECTED_L3_ELIGIBLE,
    PARSE_JSON(
      '{
        "claims": [{
          "id": "claim_1",
          "statement": "Bank of Baroda logs are offered for purchase",
          "claim_status": "unverified",
          "quantity_claimed": null,
          "evidence_text": "Bank of Baroda logs can be purchased here."
        }],
        "entities": [{
          "id": "entity_1",
          "type": "organization",
          "name": "Bank of Baroda",
          "evidence_text": "Bank of Baroda"
        }],
        "relationships": [{
          "source": "claim_1",
          "type": "ALLEGEDLY_AFFECTS",
          "target": "entity_1",
          "evidence_text": "Bank of Baroda logs can be purchased here."
        }]
      }'
    ) AS EXTRACTION
  UNION ALL
  SELECT
    'generic_indian_bank_listing',
    'Indian bank logs can be purchased here.',
    0,
    'other_organization_confirmed',
    FALSE,
    PARSE_JSON(
      '{
        "claims": [{
          "id": "claim_1",
          "statement": "An unspecified Indian bank listing is offered",
          "claim_status": "unverified",
          "quantity_claimed": null,
          "evidence_text": "Indian bank logs can be purchased here."
        }],
        "entities": [{
          "id": "entity_1",
          "type": "organization",
          "name": "Indian bank",
          "evidence_text": "Indian bank"
        }],
        "relationships": [{
          "source": "claim_1",
          "type": "ALLEGEDLY_AFFECTS",
          "target": "entity_1",
          "evidence_text": "Indian bank logs can be purchased here."
        }]
      }'
    )
  UNION ALL
  SELECT
    'normalized_misspelled_target',
    'Bank of Barodaa’s logs  can be purchased here.',
    80,
    'target_confirmed',
    TRUE,
    PARSE_JSON(
      '{
        "claims": [{
          "id": "claim_1",
          "statement": "Bank of Barodaa logs are offered",
          "claim_status": "unverified",
          "quantity_claimed": null,
          "evidence_text": "Bank of Barodaa''s logs can be purchased here."
        }],
        "entities": [{
          "id": "entity_1",
          "type": "organization",
          "name": "Bank of Barodaa",
          "evidence_text": "Bank of Barodaa"
        }],
        "relationships": [{
          "source": "claim_1",
          "type": "ALLEGEDLY_AFFECTS",
          "target": "entity_1",
          "evidence_text": "Bank of Barodaa''s logs can be purchased here."
        }]
      }'
    )
  UNION ALL
  SELECT
    'target_only_in_navigation',
    'Navigation: Bank of Baroda. Listing: Other Bank customer database for sale.',
    90,
    'ambiguous',
    FALSE,
    PARSE_JSON(
      '{
        "claims": [{
          "id": "claim_1",
          "statement": "Other Bank customer database is for sale",
          "claim_status": "unverified",
          "quantity_claimed": null,
          "evidence_text": "Other Bank customer database for sale."
        }],
        "entities": [
          {
            "id": "entity_1",
            "type": "organization",
            "name": "Bank of Baroda",
            "evidence_text": "Bank of Baroda"
          },
          {
            "id": "entity_2",
            "type": "organization",
            "name": "Other Bank",
            "evidence_text": "Other Bank"
          }
        ],
        "relationships": [{
          "source": "claim_1",
          "type": "ALLEGEDLY_AFFECTS",
          "target": "entity_2",
          "evidence_text": "Other Bank customer database for sale."
        }]
      }'
    )
  UNION ALL
  SELECT
    'unsupported_target_relationship',
    'Bank of Baroda is listed in the site navigation.',
    90,
    'ambiguous',
    FALSE,
    PARSE_JSON(
      '{
        "claims": [{
          "id": "claim_1",
          "statement": "A customer database is for sale",
          "claim_status": "unverified",
          "quantity_claimed": null,
          "evidence_text": "A customer database is for sale"
        }],
        "entities": [{
          "id": "entity_1",
          "type": "organization",
          "name": "Bank of Baroda",
          "evidence_text": "Bank of Baroda"
        }],
        "relationships": [{
          "source": "claim_1",
          "type": "ALLEGEDLY_AFFECTS",
          "target": "entity_1",
          "evidence_text": "Bank of Baroda customer database is for sale"
        }]
      }'
    )
  UNION ALL
  SELECT
    'reversed_target_relationship',
    'Bank of Baroda database is for sale.',
    90,
    'ambiguous',
    FALSE,
    PARSE_JSON(
      '{
        "claims": [{
          "id": "claim_1",
          "statement": "Bank of Baroda database is for sale",
          "claim_status": "unverified",
          "quantity_claimed": null,
          "evidence_text": "Bank of Baroda database is for sale."
        }],
        "entities": [{
          "id": "entity_1",
          "type": "organization",
          "name": "Bank of Baroda",
          "evidence_text": "Bank of Baroda"
        }],
        "relationships": [{
          "source": "entity_1",
          "type": "ALLEGEDLY_AFFECTS",
          "target": "claim_1",
          "evidence_text": "Bank of Baroda database is for sale."
        }]
      }'
    )
  UNION ALL
  SELECT
    'dangling_target_relationship',
    'Bank of Baroda database is for sale.',
    90,
    'ambiguous',
    FALSE,
    PARSE_JSON(
      '{
        "claims": [{
          "id": "claim_1",
          "statement": "Bank of Baroda database is for sale",
          "claim_status": "unverified",
          "quantity_claimed": null,
          "evidence_text": "Bank of Baroda database is for sale."
        }],
        "entities": [{
          "id": "entity_1",
          "type": "organization",
          "name": "Bank of Baroda",
          "evidence_text": "Bank of Baroda"
        }],
        "relationships": [{
          "source": "claim_99",
          "type": "ALLEGEDLY_AFFECTS",
          "target": "entity_1",
          "evidence_text": "Bank of Baroda database is for sale."
        }]
      }'
    )
  UNION ALL
  SELECT
    'duplicate_claim_ids',
    'Bank of Baroda database is for sale.',
    90,
    'ambiguous',
    FALSE,
    PARSE_JSON(
      '{
        "claims": [
          {
            "id": "claim_1",
            "statement": "Bank of Baroda database is for sale",
            "claim_status": "unverified",
            "quantity_claimed": null,
            "evidence_text": "Bank of Baroda database is for sale."
          },
          {
            "id": "claim_1",
            "statement": "Duplicate local identifier",
            "claim_status": "unverified",
            "quantity_claimed": null,
            "evidence_text": "Bank of Baroda database is for sale."
          }
        ],
        "entities": [{
          "id": "entity_1",
          "type": "organization",
          "name": "Bank of Baroda",
          "evidence_text": "Bank of Baroda"
        }],
        "relationships": [{
          "source": "claim_1",
          "type": "ALLEGEDLY_AFFECTS",
          "target": "entity_1",
          "evidence_text": "Bank of Baroda database is for sale."
        }]
      }'
    )
  UNION ALL
  SELECT
    'target_and_other_organization',
    'Bank of Baroda logs are for sale. Other Bank records are also for sale.',
    90,
    'target_confirmed',
    TRUE,
    PARSE_JSON(
      '{
        "claims": [
          {
            "id": "claim_1",
            "statement": "Bank of Baroda logs are for sale",
            "claim_status": "unverified",
            "quantity_claimed": null,
            "evidence_text": "Bank of Baroda logs are for sale."
          },
          {
            "id": "claim_2",
            "statement": "Other Bank records are for sale",
            "claim_status": "unverified",
            "quantity_claimed": null,
            "evidence_text": "Other Bank records are also for sale."
          }
        ],
        "entities": [
          {
            "id": "entity_1",
            "type": "organization",
            "name": "Bank of Baroda",
            "evidence_text": "Bank of Baroda"
          },
          {
            "id": "entity_2",
            "type": "organization",
            "name": "Other Bank",
            "evidence_text": "Other Bank"
          }
        ],
        "relationships": [
          {
            "source": "claim_1",
            "type": "ALLEGEDLY_AFFECTS",
            "target": "entity_1",
            "evidence_text": "Bank of Baroda logs are for sale."
          },
          {
            "source": "claim_2",
            "type": "ALLEGEDLY_AFFECTS",
            "target": "entity_2",
            "evidence_text": "Other Bank records are also for sale."
          }
        ]
      }'
    )
), CLAIMS AS (
  SELECT
    FIXTURE.TEST_CASE,
    CLAIM.VALUE:id::STRING AS LOCAL_ID,
    CLAIM.VALUE:evidence_text::STRING AS EVIDENCE_TEXT,
    NOCTURNE.RAW.GROUND_EVIDENCE(
      FIXTURE.DOCUMENT_TEXT,
      CLAIM.VALUE:evidence_text::STRING
    ):level::STRING AS GROUNDING_LEVEL,
    COUNT(*) OVER (
      PARTITION BY FIXTURE.TEST_CASE, CLAIM.VALUE:id::STRING
    ) AS LOCAL_ID_COUNT
  FROM FIXTURES AS FIXTURE,
    LATERAL FLATTEN(input => FIXTURE.EXTRACTION:claims) AS CLAIM
), VALID_CLAIMS AS (
  SELECT
    *,
    LOCAL_ID_COUNT = 1
      AND REGEXP_LIKE(LOCAL_ID, '^claim_[1-9][0-9]*$')
      AND GROUNDING_LEVEL IN ('exact', 'normalized') AS IS_ACCEPTED
  FROM CLAIMS
), ENTITIES AS (
  SELECT
    FIXTURE.TEST_CASE,
    ENTITY.VALUE:id::STRING AS LOCAL_ID,
    ENTITY.VALUE:type::STRING AS ENTITY_TYPE,
    ENTITY.VALUE:name::STRING AS ENTITY_NAME,
    NOCTURNE.RAW.GROUND_EVIDENCE(
      FIXTURE.DOCUMENT_TEXT,
      ENTITY.VALUE:evidence_text::STRING
    ):level::STRING AS GROUNDING_LEVEL,
    COUNT(*) OVER (
      PARTITION BY FIXTURE.TEST_CASE, ENTITY.VALUE:id::STRING
    ) AS LOCAL_ID_COUNT
  FROM FIXTURES AS FIXTURE,
    LATERAL FLATTEN(input => FIXTURE.EXTRACTION:entities) AS ENTITY
), ENTITY_SCORES AS (
  SELECT
    ENTITIES.*,
    TARGET_NAME.VALUE::STRING AS TARGET_NAME,
    NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(ENTITIES.ENTITY_NAME)
      AS OBSERVED_NORMALIZED_NAME,
    NOCTURNE.RAW.NORMALIZE_ENTITY_NAME(TARGET_NAME.VALUE::STRING)
      AS TARGET_NORMALIZED_NAME,
    OBSERVED_NORMALIZED_NAME = TARGET_NORMALIZED_NAME AS IS_EXACT_TARGET,
    JAROWINKLER_SIMILARITY(
      OBSERVED_NORMALIZED_NAME,
      TARGET_NORMALIZED_NAME
    ) AS TARGET_SIMILARITY
  FROM ENTITIES,
    LATERAL FLATTEN(
      input => ARRAY_CONSTRUCT('Bank of Baroda', 'BOB', 'Bank Baroda')
    ) AS TARGET_NAME
  WHERE ENTITIES.ENTITY_TYPE = 'organization'
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY ENTITIES.TEST_CASE, ENTITIES.LOCAL_ID
    ORDER BY IS_EXACT_TARGET DESC, TARGET_SIMILARITY DESC
  ) = 1
), VALID_ENTITIES AS (
  SELECT
    ENTITIES.*,
    COALESCE(SCORE.IS_EXACT_TARGET, FALSE)
      OR (
        LENGTH(SCORE.OBSERVED_NORMALIZED_NAME) >= 6
        AND LENGTH(SCORE.TARGET_NORMALIZED_NAME) >= 6
        AND SCORE.TARGET_SIMILARITY >= 92
      ) AS IS_TARGET,
    ENTITIES.LOCAL_ID_COUNT = 1
      AND REGEXP_LIKE(ENTITIES.LOCAL_ID, '^entity_[1-9][0-9]*$')
      AND ENTITIES.ENTITY_TYPE IN ('organization', 'domain')
      AND ENTITIES.GROUNDING_LEVEL IN ('exact', 'normalized')
      AS IS_ACCEPTED
  FROM ENTITIES
  LEFT JOIN ENTITY_SCORES AS SCORE
    ON SCORE.TEST_CASE = ENTITIES.TEST_CASE
    AND SCORE.LOCAL_ID = ENTITIES.LOCAL_ID
), RELATIONSHIPS AS (
  SELECT
    FIXTURE.TEST_CASE,
    RELATIONSHIP.VALUE:source::STRING AS SOURCE_LOCAL_ID,
    RELATIONSHIP.VALUE:type::STRING AS EDGE_TYPE,
    RELATIONSHIP.VALUE:target::STRING AS TARGET_LOCAL_ID,
    NOCTURNE.RAW.GROUND_EVIDENCE(
      FIXTURE.DOCUMENT_TEXT,
      RELATIONSHIP.VALUE:evidence_text::STRING
    ):level::STRING AS GROUNDING_LEVEL
  FROM FIXTURES AS FIXTURE,
    LATERAL FLATTEN(input => FIXTURE.EXTRACTION:relationships) AS RELATIONSHIP
), VALID_EDGES AS (
  SELECT
    EDGE.TEST_CASE,
    EDGE.EDGE_TYPE,
    COALESCE(SOURCE_CLAIM.IS_ACCEPTED, FALSE) AS SOURCE_CLAIM_ACCEPTED,
    COALESCE(TARGET_ENTITY.IS_ACCEPTED, FALSE) AS TARGET_ENTITY_ACCEPTED,
    COALESCE(TARGET_ENTITY.IS_TARGET, FALSE) AS TARGET_IS_MONITORED_ORG,
    EDGE.GROUNDING_LEVEL IN ('exact', 'normalized')
      AND EDGE.EDGE_TYPE = 'ALLEGEDLY_AFFECTS'
      AND SOURCE_CLAIM.LOCAL_ID IS NOT NULL
      AND TARGET_ENTITY.LOCAL_ID IS NOT NULL
      AND SOURCE_CLAIM_ACCEPTED
      AND TARGET_ENTITY_ACCEPTED AS IS_ACCEPTED
  FROM RELATIONSHIPS AS EDGE
  LEFT JOIN VALID_CLAIMS AS SOURCE_CLAIM
    ON SOURCE_CLAIM.TEST_CASE = EDGE.TEST_CASE
    AND SOURCE_CLAIM.LOCAL_ID = EDGE.SOURCE_LOCAL_ID
  LEFT JOIN VALID_ENTITIES AS TARGET_ENTITY
    ON TARGET_ENTITY.TEST_CASE = EDGE.TEST_CASE
    AND TARGET_ENTITY.LOCAL_ID = EDGE.TARGET_LOCAL_ID
), AGGREGATED AS (
  SELECT
    FIXTURE.TEST_CASE,
    FIXTURE.TARGET_MATCH_SCORE,
    FIXTURE.EXPECTED_ROUTE,
    FIXTURE.EXPECTED_L3_ELIGIBLE,
    COUNT_IF(
      EDGE.IS_ACCEPTED AND EDGE.TARGET_IS_MONITORED_ORG
    ) AS TARGET_AFFECTS_COUNT,
    COUNT_IF(
      EDGE.IS_ACCEPTED AND NOT EDGE.TARGET_IS_MONITORED_ORG
    ) AS OTHER_AFFECTS_COUNT,
    COUNT_IF(
      ENTITY.IS_ACCEPTED AND ENTITY.IS_TARGET
    ) AS TARGET_ENTITY_COUNT
  FROM FIXTURES AS FIXTURE
  LEFT JOIN VALID_EDGES AS EDGE
    ON EDGE.TEST_CASE = FIXTURE.TEST_CASE
  LEFT JOIN VALID_ENTITIES AS ENTITY
    ON ENTITY.TEST_CASE = FIXTURE.TEST_CASE
  GROUP BY
    FIXTURE.TEST_CASE,
    FIXTURE.TARGET_MATCH_SCORE,
    FIXTURE.EXPECTED_ROUTE,
    FIXTURE.EXPECTED_L3_ELIGIBLE
), ROUTED AS (
  SELECT
    *,
    CASE
      WHEN TARGET_AFFECTS_COUNT > 0 THEN 'target_confirmed'
      WHEN TARGET_ENTITY_COUNT > 0 THEN 'ambiguous'
      WHEN OTHER_AFFECTS_COUNT > 0 THEN 'other_organization_confirmed'
      WHEN TARGET_MATCH_SCORE = 0 THEN 'not_relevant'
      ELSE 'ambiguous'
    END AS ACTUAL_ROUTE
  FROM AGGREGATED
)
SELECT
  TEST_CASE,
  EXPECTED_ROUTE,
  ACTUAL_ROUTE,
  EXPECTED_L3_ELIGIBLE,
  ACTUAL_ROUTE = 'target_confirmed' AS ACTUAL_L3_ELIGIBLE,
  IFF(
    ACTUAL_ROUTE = EXPECTED_ROUTE
      AND (ACTUAL_ROUTE = 'target_confirmed') = EXPECTED_L3_ELIGIBLE,
    'PASS',
    'FAIL'
  ) AS TEST_RESULT
FROM ROUTED
ORDER BY TEST_CASE;

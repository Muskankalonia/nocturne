-- =============================================================================
-- Nocturne Pipeline: Step 9 - Leak Types and Preliminary Severity
-- =============================================================================
-- Runs multi-label leak-type classification only for confirmed target_data_leak
-- rows, then produces the complete L1 output consumed by NER/KG.
--
-- Scores are deterministic prioritization heuristics, not probabilities.
-- NER/KG receives every component so entity resolution can refine relevance and
-- calculate a separate final severity without overwriting this preliminary score.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

-- Materialize exactly one type-classification call for each successful target
-- leak. Other relationship labels never incur this Cortex call.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_L1_LEAK_TYPE_AI
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = DOWNSTREAM
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  SELECT
    RELATIONSHIP.DOC_ID,
    RELATIONSHIP.DEDUPE_KEY,
    RELATIONSHIP.ORG_ID,
    AI_CLASSIFY(
      CLASSIFICATION_INPUT.CLASSIFICATION_INPUT,
      [
        {
          'label': 'credential',
          'description': 'Passwords, usernames, authentication tokens, API keys, private keys, session material, or account access are leaked.'
        },
        {
          'label': 'corporate_data',
          'description': 'Internal documents, source code, customer or employee databases, contracts, strategy, or trade secrets are leaked.'
        },
        {
          'label': 'pii',
          'description': 'Personal identity, contact, government identifier, health, or other individual records are leaked.'
        },
        {
          'label': 'financial',
          'description': 'Payment cards, bank details, financial transactions, payment data, or cryptocurrency private material are leaked.'
        },
        {
          'label': 'malware_exploit',
          'description': 'Malware, ransomware tooling, exploit code, vulnerabilities used for compromise, or unauthorized access tooling are offered.'
        }
      ],
      {
        'task_description': 'Identify every leaked-data type present in this confirmed target-organization leak. Use document evidence and indicator summary. Select all applicable labels; do not infer a type from the organization name alone.',
        'output_mode': 'multi',
        'examples': [
          {
            'input': 'Employee usernames, passwords, VPN tokens, and session cookies are downloadable.',
            'labels': ['credential'],
            'explanation': 'The evidence consists of authentication and account-access material.'
          },
          {
            'input': 'An internal source-code repository and confidential product roadmaps were published.',
            'labels': ['corporate_data'],
            'explanation': 'Source code and internal strategy are corporate data.'
          },
          {
            'input': 'The dump contains customer names, addresses, phone numbers, and government IDs.',
            'labels': ['pii'],
            'explanation': 'The exposed records contain personal identifying information.'
          },
          {
            'input': 'Credit-card records, bank account numbers, and payment histories are for sale.',
            'labels': ['financial'],
            'explanation': 'The evidence is financial and payment data.'
          },
          {
            'input': 'The listing includes ransomware tooling and exploit code used to enter the target network.',
            'labels': ['malware_exploit'],
            'explanation': 'The material contains malicious tooling and exploit code.'
          },
          {
            'input': 'Employee credentials accompany an internal HR database containing names, salaries, and tax identifiers.',
            'labels': ['credential', 'corporate_data', 'pii'],
            'explanation': 'Authentication data, an internal database, and personal records are all present.'
          }
        ]
      },
      TRUE
    ) AS LEAK_TYPE_AI_RESULT
  FROM NOCTURNE.RAW.DT_PAGE_RELATIONSHIP_CLASSIFICATION AS RELATIONSHIP
  INNER JOIN NOCTURNE.RAW.DT_L1_CLASSIFICATION_INPUT AS CLASSIFICATION_INPUT
    ON RELATIONSHIP.DEDUPE_KEY = CLASSIFICATION_INPUT.DEDUPE_KEY
    AND RELATIONSHIP.ORG_ID = CLASSIFICATION_INPUT.ORG_ID
    AND RELATIONSHIP.DOC_ID = CLASSIFICATION_INPUT.DOC_ID
  WHERE RELATIONSHIP.RELATIONSHIP_AI_STATUS = 'success'
    AND RELATIONSHIP.RELATIONSHIP_LABEL = 'target_data_leak';

-- Keep every relationship-classified row. Leak-type fields are not applicable
-- for non-target leaks, target mentions without leaks, and no-leak pages.
CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = '30 MINUTE'
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  WITH PARSED_TYPES AS (
    SELECT
      RELATIONSHIP.*,
      TYPE_AI.LEAK_TYPE_AI_RESULT AS LEAK_TYPE_AI_RAW,
      TYPE_AI.LEAK_TYPE_AI_RESULT:value AS LEAK_TYPE_CLASSIFICATION_RAW,
      TYPE_AI.LEAK_TYPE_AI_RESULT:value:labels::ARRAY AS LEAK_TYPE_LABELS,
      TYPE_AI.LEAK_TYPE_AI_RESULT:error::STRING AS LEAK_TYPE_AI_ERROR
    FROM NOCTURNE.RAW.DT_PAGE_RELATIONSHIP_CLASSIFICATION AS RELATIONSHIP
    LEFT JOIN NOCTURNE.RAW.DT_L1_LEAK_TYPE_AI AS TYPE_AI
      ON RELATIONSHIP.DOC_ID = TYPE_AI.DOC_ID
      AND RELATIONSHIP.DEDUPE_KEY = TYPE_AI.DEDUPE_KEY
      AND RELATIONSHIP.ORG_ID = TYPE_AI.ORG_ID
  ),
  VALIDATED_TYPES AS (
    SELECT
      *,
      CASE
        WHEN RELATIONSHIP_AI_STATUS <> 'success'
          OR RELATIONSHIP_LABEL <> 'target_data_leak'
          THEN 'not_applicable'
        WHEN LEAK_TYPE_AI_ERROR IS NOT NULL THEN 'error'
        WHEN LEAK_TYPE_LABELS IS NULL OR ARRAY_SIZE(LEAK_TYPE_LABELS) = 0
          THEN 'invalid_response'
        ELSE 'success'
      END AS LEAK_TYPE_AI_STATUS
    FROM PARSED_TYPES
  ),
  TYPE_FLAGS AS (
    SELECT
      *,
      CASE WHEN LEAK_TYPE_AI_STATUS = 'success'
        THEN ARRAY_CONTAINS('credential'::VARIANT, LEAK_TYPE_LABELS)
        ELSE NULL
      END AS HAS_CREDENTIAL_LEAK,
      CASE WHEN LEAK_TYPE_AI_STATUS = 'success'
        THEN ARRAY_CONTAINS('corporate_data'::VARIANT, LEAK_TYPE_LABELS)
        ELSE NULL
      END AS HAS_CORPORATE_DATA_LEAK,
      CASE WHEN LEAK_TYPE_AI_STATUS = 'success'
        THEN ARRAY_CONTAINS('pii'::VARIANT, LEAK_TYPE_LABELS)
        ELSE NULL
      END AS HAS_PII_LEAK,
      CASE WHEN LEAK_TYPE_AI_STATUS = 'success'
        THEN ARRAY_CONTAINS('financial'::VARIANT, LEAK_TYPE_LABELS)
        ELSE NULL
      END AS HAS_FINANCIAL_LEAK,
      CASE WHEN LEAK_TYPE_AI_STATUS = 'success'
        THEN ARRAY_CONTAINS('malware_exploit'::VARIANT, LEAK_TYPE_LABELS)
        ELSE NULL
      END AS HAS_MALWARE_EXPLOIT_LEAK
    FROM VALIDATED_TYPES
  ),
  IMPACT_SCORES AS (
    SELECT
      *,
      CASE
        WHEN RELATIONSHIP_AI_STATUS <> 'success' THEN NULL
        WHEN RELATIONSHIP_LABEL <> 'target_data_leak' THEN 0
        ELSE GREATEST(
          50,
          COALESCE(EVIDENCE_SCORE, 0),
          CASE WHEN HAS_CREDENTIAL_LEAK THEN 85 ELSE 0 END,
          CASE WHEN HAS_CORPORATE_DATA_LEAK THEN 75 ELSE 0 END,
          CASE WHEN HAS_PII_LEAK THEN 85 ELSE 0 END,
          CASE WHEN HAS_FINANCIAL_LEAK THEN 90 ELSE 0 END,
          CASE WHEN HAS_MALWARE_EXPLOIT_LEAK THEN 70 ELSE 0 END
        )
      END AS IMPACT_SCORE
    FROM TYPE_FLAGS
  ),
  PRELIMINARY_SCORES AS (
    SELECT
      *,
      CASE
        WHEN IMPACT_SCORE IS NULL OR TARGET_RELEVANCE_SCORE IS NULL THEN NULL
        ELSE ROUND(IMPACT_SCORE * TARGET_RELEVANCE_SCORE / 100)
      END AS PRELIMINARY_SEVERITY_SCORE
    FROM IMPACT_SCORES
  )
  SELECT
    *,
    CASE
      WHEN PRELIMINARY_SEVERITY_SCORE IS NULL THEN NULL
      WHEN PRELIMINARY_SEVERITY_SCORE <= 19 THEN 'informational'
      WHEN PRELIMINARY_SEVERITY_SCORE <= 39 THEN 'low'
      WHEN PRELIMINARY_SEVERITY_SCORE <= 59 THEN 'medium'
      WHEN PRELIMINARY_SEVERITY_SCORE <= 79 THEN 'high'
      ELSE 'critical'
    END AS PRELIMINARY_SEVERITY_BAND,
    CASE
      WHEN RELATIONSHIP_AI_STATUS <> 'success' THEN FALSE
      WHEN RELATIONSHIP_LABEL <> 'target_data_leak' THEN TRUE
      ELSE LEAK_TYPE_AI_STATUS = 'success'
    END AS SEVERITY_INPUT_COMPLETE,
    'ai_classify_leak_type_v1' AS LEAK_TYPE_METHOD_VERSION,
    'heuristic_v1' AS SCORE_METHOD_VERSION
  FROM PRELIMINARY_SCORES;

-- Safe operational checks; exact page and indicator values are not selected.
-- SELECT
--   RELATIONSHIP_LABEL,
--   LEAK_TYPE_AI_STATUS,
--   PRELIMINARY_SEVERITY_BAND,
--   COUNT(*) AS PAGE_COUNT
-- FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
-- GROUP BY
--   RELATIONSHIP_LABEL,
--   LEAK_TYPE_AI_STATUS,
--   PRELIMINARY_SEVERITY_BAND;
--
-- SELECT COUNT(*) AS UNEXPECTED_TYPE_CALLS
-- FROM NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
-- WHERE RELATIONSHIP_LABEL <> 'target_data_leak'
--   AND LEAK_TYPE_AI_RAW IS NOT NULL;

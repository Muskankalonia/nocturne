-- =============================================================================
-- Nocturne regression test: target-aware and evidence-only AI inputs
-- =============================================================================
-- Prerequisites:
--   * 04_detect_indicators_udf.sql has been deployed.
--   * 06_build_classification_input_udf.sql has been deployed.
--
-- This query creates a synthetic document longer than MAX_INPUT_LENGTH. The
-- target, leak language, and fake credentials occur after the first 12,000
-- characters and before the final 4,000 characters. A passing result therefore
-- demonstrates that the builder selected an evidence-centered window instead
-- of relying on prefix/suffix fallback text.
--
-- A second synthetic document has no ranked target/leak window and verifies that
-- the masked prefix/suffix fallback is also target-profile-free for L2.
--
-- All values are synthetic. The card number is a published Luhn-valid test
-- number, and the password is an explicit non-secret fixture value.
-- =============================================================================

USE ROLE ACCOUNTADMIN;
USE SCHEMA NOCTURNE.RAW;

WITH fixture_parts AS (
  SELECT
    LEFT(
      REPEAT(
        'Neutral synthetic padding for deterministic window placement. '
        || 'This paragraph contains no target or leak indicators. ',
        200
      ),
      12500
    ) AS prefix_text,
    '\nMIDDLE_EVIDENCE_BEGIN\n'
      || 'Synthetic regression fixture only. Palo Alto Networks employee '
      || 'credentials for sale are alleged in this controlled test record.\n'
      || 'account=nocturne-fixture-do-not-use@paloaltonetworks.com\n'
      || 'password=SYNTHETIC_TEST_PASSWORD_DO_NOT_USE\n'
      || 'card=4532015112830366\n'
      || 'MIDDLE_EVIDENCE_END\n' AS evidence_text,
    LEFT(
      REPEAT(
        'Neutral closing padding for deterministic window placement. '
        || 'This paragraph contains no target or leak indicators. ',
        100
      ),
      5000
    ) AS suffix_text
),
fixture AS (
  SELECT
    prefix_text || evidence_text || suffix_text AS raw_text,
    'Synthetic middle-window classification test' AS title
  FROM fixture_parts
),
detected AS (
  SELECT
    raw_text,
    title,
    NOCTURNE.RAW.DETECT_INDICATORS(raw_text) AS indicators
  FROM fixture
),
built AS (
  SELECT
    raw_text,
    indicators,
    NOCTURNE.RAW.BUILD_CLASSIFICATION_INPUT(
      raw_text,
      title,
      indicators,
      'Palo Alto Networks',
      ARRAY_CONSTRUCT('PANW', 'CONFIG_ONLY_ALIAS'),
      ARRAY_CONSTRUCT('paloaltonetworks.com'),
      ARRAY_CONSTRUCT(
        'Cortex',
        'Prisma Cloud',
        'Strata',
        'CONFIG_ONLY_PRODUCT'
      )
    ) AS build_result
  FROM detected
),
fallback_fixture AS (
  SELECT
    'fixture_fallback_user@example.net\n'
      || LEFT(
        REPEAT(
          'Neutral filler sentence for deterministic fallback validation. ',
          500
        ),
        20000
      ) AS raw_text,
    'Synthetic fallback input test' AS title
),
fallback_detected AS (
  SELECT
    raw_text,
    title,
    NOCTURNE.RAW.DETECT_INDICATORS(raw_text) AS indicators
  FROM fallback_fixture
),
fallback_built AS (
  SELECT
    NOCTURNE.RAW.BUILD_CLASSIFICATION_INPUT(
      raw_text,
      title,
      indicators,
      'Configuration Only Organization',
      ARRAY_CONSTRUCT('CONFIG_ONLY_ALIAS'),
      ARRAY_CONSTRUCT('config-only.example'),
      ARRAY_CONSTRUCT('CONFIG_ONLY_PRODUCT')
    ) AS fallback_result
  FROM fallback_detected
),
checks AS (
  SELECT
    POSITION('MIDDLE_EVIDENCE_BEGIN' IN raw_text) > 12000
      AND POSITION('MIDDLE_EVIDENCE_END' IN raw_text)
        < LENGTH(raw_text) - 4000
      AS evidence_is_outside_fallback_slices,
    LENGTH(raw_text) > 16000 AS source_exceeds_input_limit,
    COALESCE(indicators:counts:password_assignment::NUMBER, 0) = 1
      AS detected_password_assignment,
    COALESCE(indicators:counts:validated_credit_card::NUMBER, 0) = 1
      AS detected_validated_test_card,
    COALESCE(indicators:counts:email::NUMBER, 0) = 1
      AS detected_synthetic_email,
    build_result:input_method_version::STRING = 'evidence_windows_v2'
      AS used_evidence_window_method,
    build_result:fallback_used::BOOLEAN = FALSE AS avoided_fallback,
    (
      build_result:builder_error IS NULL
      OR COALESCE(IS_NULL_VALUE(build_result:builder_error), FALSE)
    ) AS builder_completed_without_error,
    ARRAY_SIZE(build_result:selected_windows) >= 1 AS selected_ranked_window,
    build_result:indicator_spans_reused::NUMBER >= 2
      AS reused_strong_indicator_spans,
    build_result:target_match_score::NUMBER = 100
      AS matched_configured_target_domain,
    CONTAINS(
      build_result:classification_input::STRING,
      'MIDDLE_EVIDENCE_BEGIN'
    ) AS included_middle_evidence,
    CONTAINS(
      build_result:evidence_input::STRING,
      'MIDDLE_EVIDENCE_BEGIN'
    ) AS evidence_input_included_middle_evidence,
    CONTAINS(
      build_result:classification_input::STRING,
      'TARGET PROFILE'
    ) AS classification_input_has_target_profile,
    CONTAINS(
      build_result:classification_input::STRING,
      'CONFIG_ONLY_PRODUCT'
    ) AS classification_input_has_config_values,
    NOT CONTAINS(
      build_result:evidence_input::STRING,
      'TARGET PROFILE'
    )
      AND NOT CONTAINS(
        build_result:evidence_input::STRING,
        'canonical_name='
      )
      AND NOT CONTAINS(
        build_result:evidence_input::STRING,
        'aliases='
      )
      AND NOT CONTAINS(
        build_result:evidence_input::STRING,
        'domains='
      )
      AND NOT CONTAINS(
        build_result:evidence_input::STRING,
        'products='
      )
      AND NOT CONTAINS(
        build_result:evidence_input::STRING,
        'DETECTED INDICATOR SUMMARY'
      )
      AND NOT CONTAINS(
        build_result:evidence_input::STRING,
        'CONFIG_ONLY_ALIAS'
      )
      AND NOT CONTAINS(
        build_result:evidence_input::STRING,
        'CONFIG_ONLY_PRODUCT'
      ) AS evidence_input_excludes_target_configuration,
    SUBSTR(
      build_result:classification_input::STRING,
      POSITION(
        'DOCUMENT INTRODUCTION'
        IN build_result:classification_input::STRING
      )
    ) = SUBSTR(
      build_result:evidence_input::STRING,
      POSITION(
        'DOCUMENT INTRODUCTION'
        IN build_result:evidence_input::STRING
      )
    ) AS both_inputs_reuse_same_evidence_body,
    CONTAINS(
      build_result:classification_input::STRING,
      '[REDACTED_PASSWORD_ASSIGNMENT]'
    ) AS masked_password,
    CONTAINS(
      build_result:classification_input::STRING,
      '[REDACTED_VALIDATED_CREDIT_CARD]'
    ) AS masked_test_card,
    CONTAINS(
      build_result:classification_input::STRING,
      '[REDACTED_EMAIL_LOCAL_PART]@paloaltonetworks.com'
    ) AS masked_email_local_part,
    CONTAINS(
      build_result:evidence_input::STRING,
      '[REDACTED_PASSWORD_ASSIGNMENT]'
    )
      AND CONTAINS(
        build_result:evidence_input::STRING,
        '[REDACTED_VALIDATED_CREDIT_CARD]'
      )
      AND CONTAINS(
        build_result:evidence_input::STRING,
        '[REDACTED_EMAIL_LOCAL_PART]@paloaltonetworks.com'
      ) AS evidence_input_masked_sensitive_values,
    NOT CONTAINS(
      build_result:classification_input::STRING,
      'SYNTHETIC_TEST_PASSWORD_DO_NOT_USE'
    ) AS excluded_raw_password,
    NOT CONTAINS(
      build_result:classification_input::STRING,
      '4532015112830366'
    ) AS excluded_raw_test_card,
    build_result:classification_input_length::NUMBER <= 16000
      AS respected_input_length_limit,
    build_result:evidence_input_length::NUMBER <= 16000
      AS respected_evidence_input_length_limit,
    build_result:input_truncated::BOOLEAN = TRUE
      AS reported_source_truncation,
    fallback_result:fallback_used::BOOLEAN = TRUE
      AS fallback_path_used,
    (
      fallback_result:builder_error IS NULL
      OR COALESCE(IS_NULL_VALUE(fallback_result:builder_error), FALSE)
    ) AS fallback_builder_completed_without_error,
    CONTAINS(
      fallback_result:evidence_input::STRING,
      '[REDACTED_EMAIL_LOCAL_PART]@example.net'
    ) AS fallback_evidence_is_masked,
    NOT CONTAINS(
      fallback_result:evidence_input::STRING,
      'TARGET PROFILE'
    )
      AND NOT CONTAINS(
        fallback_result:evidence_input::STRING,
        'Configuration Only Organization'
      )
      AND NOT CONTAINS(
        fallback_result:evidence_input::STRING,
        'CONFIG_ONLY_ALIAS'
      )
      AND NOT CONTAINS(
        fallback_result:evidence_input::STRING,
        'config-only.example'
      )
      AND NOT CONTAINS(
        fallback_result:evidence_input::STRING,
        'CONFIG_ONLY_PRODUCT'
      ) AS fallback_evidence_excludes_target_configuration,
    indicators:summary_text::STRING AS indicator_summary,
    build_result:selected_windows AS selected_windows,
    build_result:classification_input::STRING AS masked_classification_input,
    build_result:evidence_input::STRING AS masked_evidence_input
  FROM built
  CROSS JOIN fallback_built
)
SELECT
  IFF(
    evidence_is_outside_fallback_slices
    AND source_exceeds_input_limit
    AND detected_password_assignment
    AND detected_validated_test_card
    AND detected_synthetic_email
    AND used_evidence_window_method
    AND avoided_fallback
    AND builder_completed_without_error
    AND selected_ranked_window
    AND reused_strong_indicator_spans
    AND matched_configured_target_domain
    AND included_middle_evidence
    AND evidence_input_included_middle_evidence
    AND classification_input_has_target_profile
    AND classification_input_has_config_values
    AND evidence_input_excludes_target_configuration
    AND both_inputs_reuse_same_evidence_body
    AND masked_password
    AND masked_test_card
    AND masked_email_local_part
    AND evidence_input_masked_sensitive_values
    AND excluded_raw_password
    AND excluded_raw_test_card
    AND respected_input_length_limit
    AND respected_evidence_input_length_limit
    AND reported_source_truncation
    AND fallback_path_used
    AND fallback_builder_completed_without_error
    AND fallback_evidence_is_masked
    AND fallback_evidence_excludes_target_configuration,
    'PASS',
    'FAIL'
  ) AS overall_status,
  evidence_is_outside_fallback_slices,
  source_exceeds_input_limit,
  detected_password_assignment,
  detected_validated_test_card,
  detected_synthetic_email,
  used_evidence_window_method,
  avoided_fallback,
  builder_completed_without_error,
  selected_ranked_window,
  reused_strong_indicator_spans,
  matched_configured_target_domain,
  included_middle_evidence,
  evidence_input_included_middle_evidence,
  classification_input_has_target_profile,
  classification_input_has_config_values,
  evidence_input_excludes_target_configuration,
  both_inputs_reuse_same_evidence_body,
  masked_password,
  masked_test_card,
  masked_email_local_part,
  evidence_input_masked_sensitive_values,
  excluded_raw_password,
  excluded_raw_test_card,
  respected_input_length_limit,
  respected_evidence_input_length_limit,
  reported_source_truncation,
  fallback_path_used,
  fallback_builder_completed_without_error,
  fallback_evidence_is_masked,
  fallback_evidence_excludes_target_configuration,
  indicator_summary,
  selected_windows,
  masked_classification_input,
  masked_evidence_input
FROM checks;

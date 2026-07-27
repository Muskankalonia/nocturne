-- =============================================================================
-- Nocturne Pipeline: Step 5 - Layer 1: AI Classification Dynamic Table
-- =============================================================================
-- Reads ENRICHED_TEXT from Layer 0 (raw_text + appended indicators) and
-- classifies each page for data leak detection using Cortex AI_CLASSIFY.
--
-- Categories:
--   credential_leak - leaked passwords, API keys, tokens, SSH keys
--   data_breach     - stolen corporate data, source code, customer DBs
--   pii_exposure    - SSNs, passports, medical records, bulk identity data
--   financial_leak  - credit cards, bank accounts, wallet keys
--   benign          - news, research, forums (no actual leaked data)
--
-- REFRESH_MODE = INCREMENTAL: AI runs only on new pages, not the entire corpus.
-- TARGET_LAG = 30 MINUTE: refreshes at most every 30 minutes.
--
-- Cost: AI_CLASSIFY is billed per input token from trial credits.
--   Check rates: https://docs.snowflake.com/en/user-guide/snowflake-cortex/aisql-cost
-- =============================================================================

USE SCHEMA NOCTURNE.RAW;

CREATE OR REPLACE DYNAMIC TABLE NOCTURNE.RAW.DT_PAGE_CLASSIFICATION
  WAREHOUSE = COMPUTE_WH
  TARGET_LAG = '30 MINUTE'
  REFRESH_MODE = INCREMENTAL
  INITIALIZE = ON_CREATE
AS
  SELECT
    DOC_ID,
    DEDUPE_KEY,
    URL,
    TITLE,
    RAW_TEXT,
    INDICATORS_FOUND,
    ENRICHED_TEXT,
    _INGESTED_AT,
    AI_CLASSIFY(
      ENRICHED_TEXT,
      ['credential_leak', 'data_breach', 'pii_exposure', 'financial_leak', 'benign'],
      {
        'task_description': 'Classify dark web page content for data leak detection. credential_leak = pages containing or selling leaked usernames, passwords, API keys, tokens, SSH keys, database connection strings, or authentication credentials for any organization. data_breach = pages containing or advertising stolen corporate data such as internal documents, source code, customer databases, employee records, trade secrets, or intellectual property dumps. pii_exposure = pages exposing personally identifiable information such as SSNs, passport numbers, driver licenses, medical records, or bulk identity data not tied to credentials. financial_leak = pages containing or selling stolen credit card numbers, bank account details, payment processor data, cryptocurrency wallet keys, or financial transaction records. benign = security news, research, forums discussing breaches without exposing actual data, educational content, or pages with no leaked confidential information. The DETECTED INDICATORS section lists regex-matched patterns — treat detected credentials, credit cards, SSNs, and crypto wallets as strong evidence of a leak. Pages that merely DISCUSS breaches without containing actual leaked data are benign.'
      }
    ):labels[0]::VARCHAR AS CATEGORY,
    AI_CLASSIFY(
      ENRICHED_TEXT,
      ['credential_leak', 'data_breach', 'pii_exposure', 'financial_leak', 'benign'],
      {
        'task_description': 'Classify dark web page content for data leak detection. credential_leak = pages containing or selling leaked usernames, passwords, API keys, tokens, SSH keys, database connection strings, or authentication credentials for any organization. data_breach = pages containing or advertising stolen corporate data such as internal documents, source code, customer databases, employee records, trade secrets, or intellectual property dumps. pii_exposure = pages exposing personally identifiable information such as SSNs, passport numbers, driver licenses, medical records, or bulk identity data not tied to credentials. financial_leak = pages containing or selling stolen credit card numbers, bank account details, payment processor data, cryptocurrency wallet keys, or financial transaction records. benign = security news, research, forums discussing breaches without exposing actual data, educational content, or pages with no leaked confidential information. The DETECTED INDICATORS section lists regex-matched patterns — treat detected credentials, credit cards, SSNs, and crypto wallets as strong evidence of a leak. Pages that merely DISCUSS breaches without containing actual leaked data are benign.'
      }
    ) AS CLASSIFICATION_RAW
  FROM NOCTURNE.RAW.DT_REGEX_INDICATORS;

-- =============================================================================
-- Nocturne Pipeline: Step 3 - Monitored Organization Configuration
-- =============================================================================
-- L0 remains organization-agnostic. L1 reads enabled rows from this table to
-- decide whether a page describes leaked data belonging to a monitored target.
-- Exact names, aliases, and domains support deterministic matching; the later
-- NER/KG layer is responsible for fuzzy entity resolution.
-- =============================================================================

USE ROLE ACCOUNTADMIN;

CREATE SCHEMA IF NOT EXISTS NOCTURNE.CONFIG;
USE SCHEMA NOCTURNE.CONFIG;

CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS (
  ORG_ID STRING NOT NULL,
  CANONICAL_NAME STRING NOT NULL,
  ALIASES ARRAY DEFAULT ARRAY_CONSTRUCT() NOT NULL,
  DOMAINS ARRAY DEFAULT ARRAY_CONSTRUCT() NOT NULL,
  PRODUCTS ARRAY DEFAULT ARRAY_CONSTRUCT() NOT NULL,
  ENABLED BOOLEAN DEFAULT TRUE NOT NULL,
  CREATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  UPDATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_MONITORED_ORGANIZATIONS PRIMARY KEY (ORG_ID)
);

-- Seed the hackathon target only when it is absent. Re-running deployment does
-- not overwrite aliases, domains, products, or enabled state maintained later.
--TODO Add support for multiple monitored organizations and a more robust configuration management process.
MERGE INTO NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS TARGET
USING (
  SELECT
    'palo_alto_networks' AS ORG_ID,
    'Palo Alto Networks' AS CANONICAL_NAME,
    ARRAY_CONSTRUCT('PANW') AS ALIASES,
    ARRAY_CONSTRUCT('paloaltonetworks.com') AS DOMAINS,
    ARRAY_CONSTRUCT() AS PRODUCTS,
    TRUE AS ENABLED
) AS SOURCE
ON TARGET.ORG_ID = SOURCE.ORG_ID
WHEN NOT MATCHED THEN
  INSERT (
    ORG_ID,
    CANONICAL_NAME,
    ALIASES,
    DOMAINS,
    PRODUCTS,
    ENABLED
  )
  VALUES (
    SOURCE.ORG_ID,
    SOURCE.CANONICAL_NAME,
    SOURCE.ALIASES,
    SOURCE.DOMAINS,
    SOURCE.PRODUCTS,
    SOURCE.ENABLED
  );

SELECT
  ORG_ID,
  CANONICAL_NAME,
  ALIASES,
  DOMAINS,
  PRODUCTS,
  ENABLED
FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
ORDER BY ORG_ID;

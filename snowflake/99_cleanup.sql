-- =============================================================================
-- Nocturne Pipeline: Destructive Snowflake Cleanup
-- =============================================================================
-- WARNING: This permanently removes all Nocturne data and pipeline objects from
-- Snowflake. There is no backup or recovery step in this hackathon cleanup.
--
-- Run manually in Snowsight or with a SQL client. This file is intentionally
-- excluded from deploy_pipeline.py and must never be part of normal deployment.
--
-- Removed:
--   * All objects inside the NOCTURNE database, including raw pages, AI result
--     caches, dynamic tables, views, functions, procedures, streams, and tasks.
--   * The account-level NOCTURNE_GCS_INT storage integration.
--
-- Not removed:
--   * The shared COMPUTE_WH warehouse.
--   * Account-level Cortex roles or CORTEX_ENABLED_CROSS_REGION configuration.
--   * The GCS bucket, its objects, or its IAM policy bindings.
--
-- Dropping the storage integration removes its Snowflake-generated GCS identity.
-- A later recreation can generate a different identity that must be granted GCS
-- read/list access before the external stage can be used.
-- =============================================================================

USE ROLE ACCOUNTADMIN;

-- Stop scheduled work before removing the database. The future AI tasks are
-- included now so this cleanup remains valid after the L1/L2 cache work lands.
ALTER TASK IF EXISTS NOCTURNE.RAW.CRAWL_INGEST_TASK SUSPEND;
ALTER TASK IF EXISTS NOCTURNE.RAW.RELATIONSHIP_AI_TASK SUSPEND;
ALTER TASK IF EXISTS NOCTURNE.RAW.LEAK_TYPE_AI_TASK SUSPEND;
ALTER TASK IF EXISTS NOCTURNE.RAW.L2_EXTRACTION_AI_TASK SUSPEND;

-- Dropping the database removes every schema and pipeline object beneath it.
DROP DATABASE IF EXISTS NOCTURNE;

-- This is account-scoped and therefore is not removed by DROP DATABASE.
DROP STORAGE INTEGRATION IF EXISTS NOCTURNE_GCS_INT;

-- Both SHOW statements should return zero rows after a successful cleanup.
SHOW DATABASES LIKE 'NOCTURNE';
SHOW INTEGRATIONS LIKE 'NOCTURNE_GCS_INT';


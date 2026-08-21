-- =============================================================================
-- Nocturne Pipeline: Step 1 - GCS Storage Integration
-- =============================================================================
-- Requires: ACCOUNTADMIN
--
-- This step deliberately stops before creating the external stage. Snowflake
-- must first generate its GCS service account, and that identity must be granted
-- read/list access to the crawler bucket in GCP. Run step 2 only after completing
-- the IAM commands printed below.
-- =============================================================================

USE ROLE ACCOUNTADMIN;

CREATE DATABASE IF NOT EXISTS NOCTURNE;
CREATE SCHEMA IF NOT EXISTS NOCTURNE.RAW;

CREATE OR REPLACE STORAGE INTEGRATION NOCTURNE_GCS_INT
  TYPE = EXTERNAL_STAGE
  STORAGE_PROVIDER = 'GCS'
  ENABLED = TRUE
  STORAGE_ALLOWED_LOCATIONS = (
    'gcs://nocturne-502617-nocturne-raw/raw/crawls/',
    -- Originals of analyst paste-dump uploads. Snowflake reads these directly
    -- so AI_PARSE_DOCUMENT and AI_COMPLETE can extract text from a PDF, DOCX,
    -- or screenshot without the console shipping the bytes back through a
    -- query. Kept as its own prefix rather than folded into raw/crawls/ so the
    -- ingestion COPY's file pattern and this never have to reason about each
    -- other's objects.
    'gcs://nocturne-502617-nocturne-raw/uploads/originals/'
  );

-- Copy the PROPERTY_VALUE from the STORAGE_GCP_SERVICE_ACCOUNT row.
DESC STORAGE INTEGRATION NOCTURNE_GCS_INT;

-- Pause deployment here and grant that service account bucket-scoped read access:
--
-- gcloud storage buckets add-iam-policy-binding \
--   gs://nocturne-502617-nocturne-raw \
--   --member="serviceAccount:<STORAGE_GCP_SERVICE_ACCOUNT>" \
--   --role="roles/storage.objectViewer"
--
-- gcloud storage buckets add-iam-policy-binding \
--   gs://nocturne-502617-nocturne-raw \
--   --member="serviceAccount:<STORAGE_GCP_SERVICE_ACCOUNT>" \
--   --role="roles/storage.legacyBucketReader"
--
-- Do not grant storage.objects.delete during testing. Step 2 contains a
-- commented PURGE option and a TODO for enabling deletion after validation.

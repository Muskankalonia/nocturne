-- =============================================================================
-- Nocturne Pipeline: Step 1 - GCS Storage Integration & External Stage
-- =============================================================================
-- Requires: ACCOUNTADMIN role
-- After running: Grant the STORAGE_GCP_SERVICE_ACCOUNT from DESC INTEGRATION
--   roles/storage.objectViewer AND roles/storage.legacyBucketReader on the bucket
-- =============================================================================

USE ROLE ACCOUNTADMIN;

CREATE OR REPLACE STORAGE INTEGRATION NOCTURNE_GCS_INT
  TYPE = EXTERNAL_STAGE
  STORAGE_PROVIDER = 'GCS'
  ENABLED = TRUE
  STORAGE_ALLOWED_LOCATIONS = ('gcs://nocturne-502617-nocturne-raw/raw/crawls/');

-- Retrieve the GCP service account to grant bucket access
DESC STORAGE INTEGRATION NOCTURNE_GCS_INT;
-- Look for STORAGE_GCP_SERVICE_ACCOUNT -> grant it in GCP IAM:
--   gcloud storage buckets add-iam-policy-binding gs://nocturne-502617-nocturne-raw \
--     --member=serviceAccount:<SERVICE_ACCOUNT> --role=roles/storage.objectViewer
--   gcloud storage buckets add-iam-policy-binding gs://nocturne-502617-nocturne-raw \
--     --member=serviceAccount:<SERVICE_ACCOUNT> --role=roles/storage.legacyBucketReader

CREATE DATABASE IF NOT EXISTS NOCTURNE;
CREATE SCHEMA IF NOT EXISTS NOCTURNE.RAW;

CREATE OR REPLACE FILE FORMAT NOCTURNE.RAW.JSONL_GZ_FORMAT
  TYPE = 'JSON'
  COMPRESSION = 'GZIP'
  STRIP_OUTER_ARRAY = FALSE;

CREATE OR REPLACE STAGE NOCTURNE.RAW.GCS_CRAWL_STAGE
  STORAGE_INTEGRATION = NOCTURNE_GCS_INT
  URL = 'gcs://nocturne-502617-nocturne-raw/raw/crawls/'
  DIRECTORY = (ENABLE = TRUE)
  FILE_FORMAT = (TYPE = 'JSON' COMPRESSION = 'GZIP');

-- Verify connectivity
LIST @NOCTURNE.RAW.GCS_CRAWL_STAGE;

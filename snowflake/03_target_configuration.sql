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

-- Seed the hackathon organizations only when they are absent. These rows match
-- the dashboard's tenant list in nocturne_dashboard/src/mocks/organizations.ts.
-- Re-running deployment does not overwrite aliases, domains, products, or
-- enabled state maintained later.
--
-- Note that this MERGE only inserts. Retiring a tenant means deleting its row
-- here explicitly; removing it from this list leaves the deployed row in place
-- along with every incident already keyed to its ORG_ID.
MERGE INTO NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS TARGET
USING (
  SELECT
    'european_commission' AS ORG_ID,
    'European Commission' AS CANONICAL_NAME,
    ARRAY_CONSTRUCT('European Commission', 'EC') AS ALIASES,
    ARRAY_CONSTRUCT('ec.europa.eu') AS DOMAINS,
    ARRAY_CONSTRUCT() AS PRODUCTS,
    TRUE AS ENABLED
  UNION ALL
  SELECT
    'odido',
    'Odido',
    ARRAY_CONSTRUCT('Ben.nl', 'T-Mobile Netherlands'),
    ARRAY_CONSTRUCT('odido.nl', 'ben.nl'),
    ARRAY_CONSTRUCT(),
    TRUE
  UNION ALL
  SELECT
    'demo_org',
    'Demo Organization',
    ARRAY_CONSTRUCT('Demo'),
    ARRAY_CONSTRUCT('demo-org.example'),
    ARRAY_CONSTRUCT(),
    TRUE
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

-- -----------------------------------------------------------------------------
-- Dashboard access.
--
-- Everything else the console touches is SELECT-only against NOCTURNE.DASHBOARD
-- views. This one config table is the single exception: Monitored Assets in the
-- UI writes aliases, domains, products, and the enabled flag straight back here,
-- because this table is what L1 ownership resolution reads. Adding a domain in
-- the UI is what flips pages from "Needs Review" to "Confirmed Breach".
--
-- Change this to the least-privileged role the dashboard connects with — it
-- must match SNOWFLAKE_ROLE in the dashboard's .env.local.
-- -----------------------------------------------------------------------------
SET NOCTURNE_DASHBOARD_ROLE = 'ACCOUNTADMIN';

GRANT USAGE ON DATABASE NOCTURNE
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);

GRANT USAGE ON SCHEMA NOCTURNE.CONFIG
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);

-- SELECT + UPDATE only. The console never creates or deletes monitored
-- organizations; onboarding a tenant stays a deliberate deployment step.
GRANT SELECT, UPDATE ON TABLE NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);

-- =============================================================================
-- User profiles.
--
-- The account directory (who may sign in, with what role and tenant) is not
-- here — it is the demo scheme in the dashboard's mocks, and replacing it with
-- a real identity provider is a separate job. This table holds only the
-- presentation profile a signed-in user may edit about themselves: their
-- display name, contact address, and job title.
--
-- Deliberately absent: ROLE and ORG_ID. Access level and tenant come from the
-- session, never from a field the user can type into. A profile row can change
-- what the sidebar renders; it can never change what the user may read.
-- =============================================================================
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.USER_PROFILES (
  USERNAME STRING NOT NULL,
  DISPLAY_NAME STRING,
  EMAIL STRING,
  POSITION STRING,
  -- Severity bands this user wants emailed. Empty array = alerts off, which is
  -- distinct from NULL (never configured) so a new user can inherit a default
  -- without silently opting an existing one back in.
  ALERT_BANDS ARRAY,
  WEEKLY_DIGEST BOOLEAN,
  UPDATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_USER_PROFILES PRIMARY KEY (USERNAME)
);

-- Deployments that predate alerting already have the table; add the columns.
ALTER TABLE NOCTURNE.CONFIG.USER_PROFILES ADD COLUMN IF NOT EXISTS ALERT_BANDS ARRAY;
ALTER TABLE NOCTURNE.CONFIG.USER_PROFILES ADD COLUMN IF NOT EXISTS WEEKLY_DIGEST BOOLEAN;

-- =============================================================================
-- Alert deliveries.
--
-- The exactly-once guard for breach emails. Both the pipeline and the scheduled
-- sweep call the same dispatch endpoint, and a retry of either must not resend.
-- The primary key is the guard: a delivery row is claimed *before* the mail is
-- queued, so a concurrent second dispatcher collides on the key and skips.
--
-- Rows are the audit trail of what was actually sent to whom, and are never
-- deleted by the console.
-- =============================================================================
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.ALERT_DELIVERIES (
  INCIDENT_KEY STRING NOT NULL,
  USERNAME STRING NOT NULL,
  ORG_ID STRING NOT NULL,
  EMAIL STRING NOT NULL,
  SEVERITY_BAND STRING,
  QUEUED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_ALERT_DELIVERIES PRIMARY KEY (INCIDENT_KEY, USERNAME)
);

GRANT SELECT, INSERT ON TABLE NOCTURNE.CONFIG.ALERT_DELIVERIES
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);

-- SELECT, INSERT and UPDATE: a profile row is created the first time someone
-- saves, so there is nothing to seed. No DELETE — clearing a field is an
-- UPDATE to NULL, and rows outliving a demo account are harmless.
GRANT SELECT, INSERT, UPDATE ON TABLE NOCTURNE.CONFIG.USER_PROFILES
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);

SELECT
  ORG_ID,
  CANONICAL_NAME,
  ALIASES,
  DOMAINS,
  PRODUCTS,
  ENABLED
FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
ORDER BY ORG_ID;

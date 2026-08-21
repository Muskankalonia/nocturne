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

-- =============================================================================
-- Triage and mitigation state.
--
-- Everything below is analyst-authored workflow, not pipeline output. It lives
-- in CONFIG rather than RAW for exactly that reason: the detection cascade is
-- deterministic and reproducible from the crawled pages, and a human deciding
-- "we have handled this" is neither. Keeping the two apart means a full pipeline
-- rebuild never silently discards a mitigation decision.
--
-- These tables are declared here, before step 16, because the dashboard views
-- join them. A view cannot be created ahead of the table it reads.
-- =============================================================================

-- Current remediation state for one incident. One row per incident, updated in
-- place; the history lives in INCIDENT_ACTION_AUDIT next to it.
--
-- STATUS is deliberately open text rather than an enum: Snowflake has no
-- enforced enum, and a CHECK constraint here would mean a UI-side vocabulary
-- change needs a migration. The console normalizes before writing, and the
-- views below coalesce anything unrecognized back to 'new'.
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.INCIDENT_REMEDIATION (
  ORG_ID STRING NOT NULL,
  INCIDENT_KEY STRING NOT NULL,
  REMEDIATION_STATUS STRING NOT NULL,
  -- Set when the status becomes 'mitigated', cleared when it is unmarked, so
  -- "when was this closed out" survives a later status change.
  MITIGATED_AT TIMESTAMP_TZ,
  MITIGATED_BY STRING,
  NOTE STRING,
  -- 'console' or 'jira'. The Jira webhook and the UI write the same row, and
  -- without this the two loops cannot tell whose change they are observing —
  -- which is how a close-sync turns into an infinite ping-pong.
  UPDATED_VIA STRING DEFAULT 'console' NOT NULL,
  UPDATED_BY STRING,
  UPDATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_INCIDENT_REMEDIATION PRIMARY KEY (ORG_ID, INCIDENT_KEY)
);

-- Append-only trail of every triage action taken, including the ones that
-- changed no state. This is the audit record the Snowflake requirement asks
-- for: who dispatched what, who mitigated what, and when.
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.INCIDENT_ACTION_AUDIT (
  ACTION_ID STRING DEFAULT UUID_STRING() NOT NULL,
  ORG_ID STRING NOT NULL,
  -- Null for actions that are not incident-scoped, such as a period export.
  INCIDENT_KEY STRING,
  ACTION STRING NOT NULL,
  ACTOR STRING NOT NULL,
  OUTCOME STRING NOT NULL,
  DETAIL VARIANT,
  CREATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_INCIDENT_ACTION_AUDIT PRIMARY KEY (ACTION_ID)
);

-- One row per (incident, channel) delivery to an external system. The primary
-- key is the idempotency guard, the same shape as ALERT_DELIVERIES: dispatching
-- twice must not open a second Jira ticket.
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.INCIDENT_INTEGRATIONS (
  ORG_ID STRING NOT NULL,
  INCIDENT_KEY STRING NOT NULL,
  -- 'jira' | 'slack' | 'email'
  CHANNEL STRING NOT NULL,
  -- Jira issue key, Slack message ts, or null for email fan-out.
  EXTERNAL_ID STRING,
  EXTERNAL_URL STRING,
  -- 'open' | 'closed' | 'failed' | 'sent'
  STATE STRING DEFAULT 'open' NOT NULL,
  LAST_ERROR STRING,
  CREATED_BY STRING,
  CREATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  UPDATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_INCIDENT_INTEGRATIONS PRIMARY KEY (ORG_ID, INCIDENT_KEY, CHANNEL)
);

-- Headless-browser captures of needs-review pages, so an admin can look at the
-- actual page before deciding whether it is a breach.
--
-- The image itself never lands here. Only its GCS location does: a screenshot
-- of a dark-web listing is unmasked source material, and the whole interface
-- contract of NOCTURNE.DASHBOARD is that raw page content does not cross it.
-- Access is mediated by a signed URL minted per request instead.
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.PAGE_SCREENSHOTS (
  ORG_ID STRING NOT NULL,
  -- MONITOR_KEY from VW_BREACH_MONITOR, which is stable for both incident rows
  -- and the document-level rows that never became incidents.
  MONITOR_KEY STRING NOT NULL,
  DEDUPE_KEY STRING,
  URL STRING NOT NULL,
  -- 'requested' | 'capturing' | 'captured' | 'failed'
  STATUS STRING DEFAULT 'requested' NOT NULL,
  OBJECT_URI STRING,
  PAGE_TITLE STRING,
  CAPTURE_ERROR STRING,
  REQUESTED_BY STRING NOT NULL,
  REQUESTED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CAPTURED_AT TIMESTAMP_TZ,
  -- When a worker took this row, as distinct from when the console asked for
  -- it. The reaper needs the difference: a row requested twenty minutes ago and
  -- claimed one minute ago is healthy, and reaping on REQUESTED_AT would cancel
  -- a capture that is happily in progress.
  CLAIMED_AT TIMESTAMP_TZ,
  -- Claims made against this row, so a page that reliably kills its worker
  -- fails honestly instead of being requeued forever. A crash loop that stays
  -- invisible is worse than a failure that is written down.
  CAPTURE_ATTEMPTS NUMBER DEFAULT 0 NOT NULL,
  CONSTRAINT PK_PAGE_SCREENSHOTS PRIMARY KEY (ORG_ID, MONITOR_KEY)
);

-- The admin's verdict on a needs-review row after looking at the capture.
-- Kept separate from INCIDENT_REMEDIATION because it answers a different
-- question: not "has this been handled" but "is this ours at all".
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.REVIEW_DECISIONS (
  ORG_ID STRING NOT NULL,
  MONITOR_KEY STRING NOT NULL,
  -- 'confirmed_breach' | 'not_a_breach'
  DECISION STRING NOT NULL,
  NOTE STRING,
  DECIDED_BY STRING NOT NULL,
  DECIDED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_REVIEW_DECISIONS PRIMARY KEY (ORG_ID, MONITOR_KEY)
);

-- Generated evidence and weekly reports. The artifact is not stored; this is
-- the record that one was produced, for whom, over what window.
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.REPORT_RUNS (
  REPORT_ID STRING DEFAULT UUID_STRING() NOT NULL,
  ORG_ID STRING,
  -- 'evidence_pdf' | 'evidence_csv' | 'weekly_pdf'
  KIND STRING NOT NULL,
  PERIOD_START TIMESTAMP_TZ NOT NULL,
  PERIOD_END TIMESTAMP_TZ NOT NULL,
  INCIDENT_COUNT NUMBER,
  DELIVERY STRING NOT NULL,
  RECIPIENTS ARRAY,
  GENERATED_BY STRING NOT NULL,
  GENERATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_REPORT_RUNS PRIMARY KEY (REPORT_ID)
);

-- Cached natural-language readings of the knowledge graph.
--
-- Persisted rather than held in memory because the console runs on Cloud Run
-- and scales to zero: an in-process cache would be cold on most requests, and
-- every cold hit is a Cortex call billed again for a graph that has not
-- changed. GRAPH_FINGERPRINT is a hash of the node and edge identities the
-- summary was written from, so a graph that gains an actor or an edge misses
-- the cache and is re-read, while a page refresh does not.
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.GRAPH_SUMMARIES (
  ORG_ID STRING NOT NULL,
  -- 'incident' | 'actors'
  VIEW_KIND STRING NOT NULL,
  -- Incident key for the incident view, '' for the org-wide actor view.
  SCOPE_KEY STRING NOT NULL,
  GRAPH_FINGERPRINT STRING NOT NULL,
  SUMMARY STRING NOT NULL,
  NODE_COUNT NUMBER,
  EDGE_COUNT NUMBER,
  MODEL_NAME STRING,
  GENERATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_GRAPH_SUMMARIES PRIMARY KEY (ORG_ID, VIEW_KIND, SCOPE_KEY)
);

-- =============================================================================
-- Integration credentials.
--
-- Jira and Slack were originally configured from the environment, which made
-- them a deployment concern and identical for every tenant. They are neither:
-- each organization has its own Jira project and its own Slack channel, and the
-- person who knows those values is an analyst, not whoever last edited the
-- Cloud Run service.
--
-- SETTINGS holds the non-secret half (base URL, project key, channel) and is
-- read back to the browser. SECRETS holds API tokens, encrypted with AES-256-GCM
-- by the console before they ever reach Snowflake — a warehouse admin reading
-- this table sees ciphertext, and the key lives only in the app's environment.
-- Nothing here is ever returned to a client in plaintext.
-- =============================================================================
CREATE TABLE IF NOT EXISTS NOCTURNE.CONFIG.INTEGRATION_SETTINGS (
  ORG_ID STRING NOT NULL,
  -- 'jira' | 'slack'
  PROVIDER STRING NOT NULL,
  ENABLED BOOLEAN DEFAULT TRUE NOT NULL,
  SETTINGS VARIANT,
  SECRETS VARIANT,
  UPDATED_BY STRING,
  UPDATED_AT TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  CONSTRAINT PK_INTEGRATION_SETTINGS PRIMARY KEY (ORG_ID, PROVIDER)
);

-- DELETE is granted here, unlike the tables above: disconnecting an integration
-- should remove the stored credential rather than leave ciphertext behind.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE NOCTURNE.CONFIG.INTEGRATION_SETTINGS
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);

-- The console owns this workflow state end to end, so it needs write access.
-- DELETE is granted nowhere: unmarking a mitigation is an UPDATE that clears
-- MITIGATED_AT, and the audit row for it stays.
GRANT SELECT, INSERT, UPDATE ON TABLE NOCTURNE.CONFIG.INCIDENT_REMEDIATION
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);
GRANT SELECT, INSERT ON TABLE NOCTURNE.CONFIG.INCIDENT_ACTION_AUDIT
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);
GRANT SELECT, INSERT, UPDATE ON TABLE NOCTURNE.CONFIG.INCIDENT_INTEGRATIONS
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);
GRANT SELECT, INSERT, UPDATE ON TABLE NOCTURNE.CONFIG.PAGE_SCREENSHOTS
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);
GRANT SELECT, INSERT, UPDATE ON TABLE NOCTURNE.CONFIG.REVIEW_DECISIONS
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);
GRANT SELECT, INSERT ON TABLE NOCTURNE.CONFIG.REPORT_RUNS
  TO ROLE IDENTIFIER($NOCTURNE_DASHBOARD_ROLE);
-- UPDATE as well as INSERT: a row is replaced in place when the fingerprint
-- changes, so one graph keeps one summary rather than accumulating history.
GRANT SELECT, INSERT, UPDATE ON TABLE NOCTURNE.CONFIG.GRAPH_SUMMARIES
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

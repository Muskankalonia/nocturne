-- =============================================================================
-- Nocturne Pipeline: Step 17 - Triage & Mitigation Interface
-- =============================================================================
-- The read boundary for everything an analyst *does* to an incident, as opposed
-- to everything the cascade concluded about it. The tables behind these views
-- are declared in step 03 (NOCTURNE.CONFIG), because step 16's incident view
-- already joins the remediation table and a view cannot precede its source.
--
-- Same rules as step 16 apply here. No raw page text, no exact indicator
-- values, no prompts. A screenshot of a dark-web page is unmasked source
-- material, so only its storage location crosses this boundary — never the
-- image, and never a URL that grants access on its own.
-- =============================================================================

USE ROLE ACCOUNTADMIN;

CREATE SCHEMA IF NOT EXISTS NOCTURNE.DASHBOARD;
USE SCHEMA NOCTURNE.DASHBOARD;

-- Everything the console needs to render one incident's action bar: what state
-- it is in, which external systems already know about it, and where those
-- records live. One row per incident that has an entry in VW_INCIDENTS, whether
-- or not anyone has acted on it — an untouched incident reads as 'new' with
-- null tickets, which is what the buttons need in order to decide their labels.
CREATE OR REPLACE VIEW NOCTURNE.DASHBOARD.VW_INCIDENT_ACTION_STATE AS
  SELECT
    INCIDENT.ORG_ID,
    INCIDENT.INCIDENT_KEY,
    INCIDENT.ORGANIZATION_NAME,
    INCIDENT.TOP_TITLE,
    INCIDENT.IMPACT_SEVERITY_BAND,
    INCIDENT.REMEDIATION_STATUS,
    INCIDENT.MITIGATED_AT,
    INCIDENT.MITIGATED_BY,
    INCIDENT.REMEDIATION_NOTE,
    INCIDENT.REMEDIATION_UPDATED_VIA,
    INCIDENT.REMEDIATION_UPDATED_AT,
    JIRA.EXTERNAL_ID AS JIRA_ISSUE_KEY,
    JIRA.EXTERNAL_URL AS JIRA_ISSUE_URL,
    JIRA.STATE AS JIRA_STATE,
    JIRA.LAST_ERROR AS JIRA_LAST_ERROR,
    JIRA.CREATED_AT AS JIRA_CREATED_AT,
    -- The Slack message timestamp, which is also its thread anchor: an
    -- all-clear reply belongs under the alarm, not loose in the channel.
    SLACK.EXTERNAL_ID AS SLACK_MESSAGE_TS,
    SLACK.EXTERNAL_URL AS SLACK_MESSAGE_URL,
    SLACK.STATE AS SLACK_STATE,
    SLACK.LAST_ERROR AS SLACK_LAST_ERROR,
    SLACK.CREATED_AT AS SLACK_CREATED_AT,
    EMAIL.STATE AS SOC_EMAIL_STATE,
    EMAIL.CREATED_AT AS SOC_EMAIL_SENT_AT,
    -- A dispatch is "done" only when every configured channel succeeded. The
    -- console uses this to keep offering the button after a partial failure.
    COALESCE(JIRA.CREATED_AT, SLACK.CREATED_AT, EMAIL.CREATED_AT) IS NOT NULL
      AS HAS_BEEN_DISPATCHED
  FROM NOCTURNE.DASHBOARD.VW_INCIDENTS AS INCIDENT
  LEFT JOIN NOCTURNE.CONFIG.INCIDENT_INTEGRATIONS AS JIRA
    ON JIRA.ORG_ID = INCIDENT.ORG_ID
    AND JIRA.INCIDENT_KEY = INCIDENT.INCIDENT_KEY
    AND JIRA.CHANNEL = 'jira'
  LEFT JOIN NOCTURNE.CONFIG.INCIDENT_INTEGRATIONS AS SLACK
    ON SLACK.ORG_ID = INCIDENT.ORG_ID
    AND SLACK.INCIDENT_KEY = INCIDENT.INCIDENT_KEY
    AND SLACK.CHANNEL = 'slack'
  LEFT JOIN NOCTURNE.CONFIG.INCIDENT_INTEGRATIONS AS EMAIL
    ON EMAIL.ORG_ID = INCIDENT.ORG_ID
    AND EMAIL.INCIDENT_KEY = INCIDENT.INCIDENT_KEY
    AND EMAIL.CHANNEL = 'email';

-- The action trail, most recent first, with the organization name attached so
-- the fleet view does not have to join it back on. DETAIL is deliberately not
-- exposed as a whole: it is a free-form VARIANT written by the dispatchers and
-- may carry recipient addresses, which do not belong in a shared audit panel.
CREATE OR REPLACE VIEW NOCTURNE.DASHBOARD.VW_TRIAGE_AUDIT AS
  SELECT
    AUDIT.ACTION_ID,
    AUDIT.ORG_ID,
    -- LEFT, not INNER. A fleet-scope action — an export covering every tenant —
    -- is attributed to the caller rather than to an organization, so an inner
    -- join here would silently drop exactly the rows an auditor came for.
    COALESCE(ORGANIZATION.CANONICAL_NAME, AUDIT.ORG_ID) AS ORGANIZATION_NAME,
    AUDIT.INCIDENT_KEY,
    INCIDENT.TOP_TITLE AS INCIDENT_TITLE,
    AUDIT.ACTION,
    AUDIT.ACTOR,
    AUDIT.OUTCOME,
    AUDIT.DETAIL:summary::STRING AS SUMMARY,
    AUDIT.CREATED_AT
  FROM NOCTURNE.CONFIG.INCIDENT_ACTION_AUDIT AS AUDIT
  LEFT JOIN NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS AS ORGANIZATION
    ON ORGANIZATION.ORG_ID = AUDIT.ORG_ID
  LEFT JOIN NOCTURNE.DASHBOARD.VW_INCIDENTS AS INCIDENT
    ON INCIDENT.ORG_ID = AUDIT.ORG_ID
    AND INCIDENT.INCIDENT_KEY = AUDIT.INCIDENT_KEY;

-- The flat projection behind evidence exports and the weekly report. One row
-- per incident, every column printable, no arrays needing client-side shaping
-- beyond the two that are genuinely lists.
--
-- FIRST_SEEN is the window column on purpose: an export for "the last 24 hours"
-- means incidents that surfaced in that window, not incidents whose severity
-- happened to be recomputed in it.
CREATE OR REPLACE VIEW NOCTURNE.DASHBOARD.VW_REPORT_INCIDENTS AS
  SELECT
    INCIDENT.ORG_ID,
    INCIDENT.ORGANIZATION_NAME,
    INCIDENT.INCIDENT_KEY,
    INCIDENT.TOP_TITLE AS TITLE,
    INCIDENT.TOP_URL AS URL,
    INCIDENT.SOURCE,
    INCIDENT.FIRST_SEEN,
    INCIDENT.LAST_SEEN,
    INCIDENT.L2_ROUTE,
    INCIDENT.LEAK_TYPE_LABELS,
    INCIDENT.QUANTITY_CLAIMED,
    INCIDENT.IMPACT_SEVERITY_SCORE,
    INCIDENT.IMPACT_SEVERITY_BAND,
    INCIDENT.EVIDENCE_CONFIDENCE_SCORE,
    INCIDENT.EVIDENCE_CONFIDENCE_BAND,
    INCIDENT.TRIAGE_PRIORITY_SCORE,
    INCIDENT.TRIAGE_PRIORITY_BAND,
    INCIDENT.ACTOR_NAME,
    INCIDENT.ACTOR_CREDIBILITY_SCORE,
    INCIDENT.GROUNDING_LEVEL,
    INCIDENT.CORROBORATION_COUNT,
    INCIDENT.SIGHTING_COUNT,
    INCIDENT.INSIGHT_HEADLINE,
    INCIDENT.EXECUTIVE_SUMMARY,
    INCIDENT.BUSINESS_IMPACT,
    INCIDENT.RECOMMENDED_ACTIONS,
    INCIDENT.REMEDIATION_STATUS,
    INCIDENT.MITIGATED_AT,
    INCIDENT.MITIGATED_BY,
    ACTION.JIRA_ISSUE_KEY,
    ACTION.JIRA_ISSUE_URL,
    ACTION.HAS_BEEN_DISPATCHED
  FROM NOCTURNE.DASHBOARD.VW_INCIDENTS AS INCIDENT
  LEFT JOIN NOCTURNE.DASHBOARD.VW_INCIDENT_ACTION_STATE AS ACTION
    ON ACTION.ORG_ID = INCIDENT.ORG_ID
    AND ACTION.INCIDENT_KEY = INCIDENT.INCIDENT_KEY
  WHERE COALESCE(INCIDENT.SOURCE, '') <> 'manual_upload';

-- The work queue the Tor capture worker drains. Rows leave it when the worker
-- claims them by moving STATUS to 'capturing', so a second worker on the same
-- schedule does not fetch the same .onion page twice.
--
-- Requests older than a day are dropped from the queue rather than retried
-- forever: a page that could not be reached in 24 hours is usually gone, and an
-- unbounded retry loop against Tor is a good way to get an exit rate-limited.
CREATE OR REPLACE VIEW NOCTURNE.DASHBOARD.VW_SCREENSHOT_QUEUE AS
  SELECT
    ORG_ID,
    MONITOR_KEY,
    DEDUPE_KEY,
    URL,
    REQUESTED_BY,
    REQUESTED_AT
  FROM NOCTURNE.CONFIG.PAGE_SCREENSHOTS
  WHERE STATUS = 'requested'
    AND REQUESTED_AT >= DATEADD(hour, -24, CURRENT_TIMESTAMP())
  ORDER BY REQUESTED_AT;

-- Readiness checks. Metadata and aggregate counts only.
SELECT TABLE_NAME
FROM NOCTURNE.INFORMATION_SCHEMA.VIEWS
WHERE TABLE_SCHEMA = 'DASHBOARD'
  AND TABLE_NAME IN (
    'VW_INCIDENT_ACTION_STATE',
    'VW_TRIAGE_AUDIT',
    'VW_REPORT_INCIDENTS',
    'VW_SCREENSHOT_QUEUE'
  )
ORDER BY TABLE_NAME;

SELECT
  REMEDIATION_STATUS,
  COUNT(*) AS INCIDENTS
FROM NOCTURNE.DASHBOARD.VW_INCIDENT_ACTION_STATE
GROUP BY REMEDIATION_STATUS
ORDER BY REMEDIATION_STATUS;

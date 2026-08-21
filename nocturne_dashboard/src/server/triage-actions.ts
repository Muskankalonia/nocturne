import { executeQuery } from "@/server/nocturne-backend";
import type { DataScope, LeakType, RemediationStatus, SeverityBand } from "@/types";
import type { PendingAlert } from "@/types/dashboard";
import type {
  IncidentActionState,
  IntegrationChannel,
  IntegrationState,
  PageScreenshot,
  ReportIncident,
  ReportPeriod,
  ReviewDecision,
  ScreenshotStatus,
  TriageAction,
  TriageAuditEntry,
  TriageOutcome,
} from "@/types/triage";

if (typeof window !== "undefined") {
  throw new Error("Nocturne triage actions may only run on the server.");
}

/**
 * Writes against NOCTURNE.CONFIG for analyst-authored triage state, and the
 * reads that back them.
 *
 * Every write here is bound, never interpolated. That matters more than usual:
 * these statements carry analyst-typed notes and Jira issue keys from an
 * inbound webhook, which is the least trusted string in the application.
 */

type SnowflakeRow = Record<string, unknown>;

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const asString = String(value);
  // The Snowflake driver hands back nullable expressions as the literal
  // "NULL" when fetchAsString is on. Treat that as absent, as the read path
  // already does, or every empty column renders the word NULL in the UI.
  return asString.trim().toUpperCase() === "NULL" ? null : asString;
}

function textOr(value: unknown, fallback: string): string {
  return text(value) ?? fallback;
}

function num(value: unknown): number | null {
  const raw = text(value);
  if (raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const raw = text(value);
  return raw === "true" || raw === "TRUE" || raw === "1";
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** ISO-8601 with offset, so a report period is unambiguous across regions. */
const TS = `'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'`;

/* ── remediation state ─────────────────────────────────────────────────────── */

const ACTION_STATE_COLUMNS = `
  ORG_ID,
  INCIDENT_KEY,
  ORGANIZATION_NAME,
  TOP_TITLE,
  IMPACT_SEVERITY_BAND,
  REMEDIATION_STATUS,
  TO_VARCHAR(MITIGATED_AT, ${TS}) AS MITIGATED_AT,
  MITIGATED_BY,
  REMEDIATION_NOTE,
  REMEDIATION_UPDATED_VIA,
  TO_VARCHAR(REMEDIATION_UPDATED_AT, ${TS}) AS REMEDIATION_UPDATED_AT,
  JIRA_ISSUE_KEY,
  JIRA_ISSUE_URL,
  JIRA_STATE,
  SLACK_MESSAGE_TS,
  SLACK_MESSAGE_URL,
  SLACK_STATE,
  SOC_EMAIL_STATE,
  TO_VARCHAR(SOC_EMAIL_SENT_AT, ${TS}) AS SOC_EMAIL_SENT_AT,
  HAS_BEEN_DISPATCHED,
  REVIEW_DECISION,
  REVIEW_DECIDED_BY,
  REVIEW_NOTE
`;

function mapActionState(row: SnowflakeRow): IncidentActionState {
  return {
    orgId: textOr(row.ORG_ID, ""),
    incidentKey: textOr(row.INCIDENT_KEY, ""),
    organizationName: textOr(row.ORGANIZATION_NAME, ""),
    title: textOr(row.TOP_TITLE, ""),
    impactSeverityBand: text(row.IMPACT_SEVERITY_BAND) as SeverityBand | null,
    remediationStatus: textOr(row.REMEDIATION_STATUS, "new") as RemediationStatus,
    mitigatedAt: text(row.MITIGATED_AT),
    mitigatedBy: text(row.MITIGATED_BY),
    remediationNote: text(row.REMEDIATION_NOTE),
    remediationUpdatedVia: text(row.REMEDIATION_UPDATED_VIA),
    remediationUpdatedAt: text(row.REMEDIATION_UPDATED_AT),
    jiraIssueKey: text(row.JIRA_ISSUE_KEY),
    jiraIssueUrl: text(row.JIRA_ISSUE_URL),
    jiraState: text(row.JIRA_STATE) as IntegrationState | null,
    slackMessageTs: text(row.SLACK_MESSAGE_TS),
    slackMessageUrl: text(row.SLACK_MESSAGE_URL),
    slackState: text(row.SLACK_STATE) as IntegrationState | null,
    socEmailState: text(row.SOC_EMAIL_STATE) as IntegrationState | null,
    socEmailSentAt: text(row.SOC_EMAIL_SENT_AT),
    hasBeenDispatched: bool(row.HAS_BEEN_DISPATCHED),
    reviewDecision: text(row.REVIEW_DECISION) as IncidentActionState["reviewDecision"],
    reviewDecidedBy: text(row.REVIEW_DECIDED_BY),
    reviewNote: text(row.REVIEW_NOTE),
  };
}

/**
 * One incident's action state, or null when the incident does not exist for
 * this organization. Routes turn null into a 404 without distinguishing
 * "missing" from "another tenant's", so incident keys stay unprobeable.
 */
export async function getIncidentActionState(
  orgId: string,
  incidentKey: string,
): Promise<IncidentActionState | null> {
  const rows = await executeQuery(
    `SELECT ${ACTION_STATE_COLUMNS}
     FROM NOCTURNE.DASHBOARD.VW_INCIDENT_ACTION_STATE
     WHERE ORG_ID = ? AND INCIDENT_KEY = ?`,
    [orgId, incidentKey],
  );
  return rows.length ? mapActionState(rows[0]!) : null;
}

export interface RemediationWrite {
  orgId: string;
  incidentKey: string;
  status: RemediationStatus;
  actor: string;
  note?: string | null;
  /** 'console' when a person clicked; 'jira' when a ticket transition drove it. */
  via: "console" | "jira";
}

/**
 * Upserts remediation state.
 *
 * MITIGATED_AT is set only on the transition into 'mitigated' and cleared on
 * the way out, so "when was this closed" is not silently rewritten every time
 * someone re-saves a note. MERGE rather than INSERT/UPDATE keeps the first
 * write on an incident and every later one on the same path.
 */
export async function setIncidentRemediation(write: RemediationWrite): Promise<void> {
  const isMitigated = write.status === "mitigated";
  await executeQuery(
    `MERGE INTO NOCTURNE.CONFIG.INCIDENT_REMEDIATION AS TARGET
     USING (SELECT ? AS ORG_ID, ? AS INCIDENT_KEY) AS SOURCE
       ON TARGET.ORG_ID = SOURCE.ORG_ID
      AND TARGET.INCIDENT_KEY = SOURCE.INCIDENT_KEY
     WHEN MATCHED THEN UPDATE SET
       REMEDIATION_STATUS = ?,
       MITIGATED_AT = IFF(?, COALESCE(TARGET.MITIGATED_AT, CURRENT_TIMESTAMP()), NULL),
       MITIGATED_BY = IFF(?, COALESCE(TARGET.MITIGATED_BY, ?), NULL),
       NOTE = ?,
       UPDATED_VIA = ?,
       UPDATED_BY = ?,
       UPDATED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT
       (ORG_ID, INCIDENT_KEY, REMEDIATION_STATUS, MITIGATED_AT, MITIGATED_BY,
        NOTE, UPDATED_VIA, UPDATED_BY)
       VALUES (
         SOURCE.ORG_ID,
         SOURCE.INCIDENT_KEY,
         ?,
         IFF(?, CURRENT_TIMESTAMP(), NULL),
         IFF(?, ?, NULL),
         ?,
         ?,
         ?
       )`,
    [
      write.orgId,
      write.incidentKey,
      write.status,
      isMitigated,
      isMitigated,
      write.actor,
      write.note ?? null,
      write.via,
      write.actor,
      write.status,
      isMitigated,
      isMitigated,
      write.actor,
      write.note ?? null,
      write.via,
      write.actor,
    ],
  );
}

/* ── audit trail ───────────────────────────────────────────────────────────── */

export interface ActionAuditWrite {
  orgId: string;
  incidentKey?: string | null;
  action: TriageAction;
  actor: string;
  outcome: TriageOutcome;
  /** Rendered into DETAIL:summary and shown in the audit panel. */
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * Appends one audit row.
 *
 * Deliberately swallows its own failure. The audit trail matters, but an
 * unavailable warehouse must not turn a successful mitigation into a 503 the
 * user retries — which would then re-dispatch the integrations. The action is
 * the source of truth; this is its record, and a lost record is logged loudly.
 */
export async function recordAction(entry: ActionAuditWrite): Promise<void> {
  try {
    await executeQuery(
      `INSERT INTO NOCTURNE.CONFIG.INCIDENT_ACTION_AUDIT
         (ORG_ID, INCIDENT_KEY, ACTION, ACTOR, OUTCOME, DETAIL)
       SELECT ?, ?, ?, ?, ?, PARSE_JSON(?)`,
      [
        entry.orgId,
        entry.incidentKey ?? null,
        entry.action,
        entry.actor,
        entry.outcome,
        JSON.stringify({ summary: entry.summary, ...(entry.detail ?? {}) }),
      ],
    );
  } catch (error) {
    console.error(
      "[nocturne-triage] audit write failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

export async function listTriageAudit(
  scope: DataScope,
  limit = 50,
): Promise<TriageAuditEntry[]> {
  const scoped = scope.kind === "org";
  const rows = await executeQuery(
    `SELECT
       ACTION_ID,
       ORG_ID,
       ORGANIZATION_NAME,
       INCIDENT_KEY,
       INCIDENT_TITLE,
       ACTION,
       ACTOR,
       OUTCOME,
       SUMMARY,
       TO_VARCHAR(CREATED_AT, ${TS}) AS CREATED_AT
     FROM NOCTURNE.DASHBOARD.VW_TRIAGE_AUDIT
     ${scoped ? "WHERE ORG_ID = ?" : ""}
     ORDER BY CREATED_AT DESC
     LIMIT ?`,
    scoped ? [scope.orgId, limit] : [limit],
  );
  return rows.map((row) => ({
    actionId: textOr(row.ACTION_ID, ""),
    orgId: textOr(row.ORG_ID, ""),
    organizationName: textOr(row.ORGANIZATION_NAME, ""),
    incidentKey: text(row.INCIDENT_KEY),
    incidentTitle: text(row.INCIDENT_TITLE),
    action: textOr(row.ACTION, ""),
    actor: textOr(row.ACTOR, ""),
    outcome: textOr(row.OUTCOME, ""),
    summary: text(row.SUMMARY),
    createdAt: textOr(row.CREATED_AT, ""),
  }));
}

/* ── external integration records ──────────────────────────────────────────── */

export interface IntegrationWrite {
  orgId: string;
  incidentKey: string;
  channel: IntegrationChannel;
  externalId?: string | null;
  externalUrl?: string | null;
  state: IntegrationState;
  error?: string | null;
  actor: string;
}

/** Upserts the record of what one channel knows about one incident. */
export async function recordIntegration(write: IntegrationWrite): Promise<void> {
  await executeQuery(
    `MERGE INTO NOCTURNE.CONFIG.INCIDENT_INTEGRATIONS AS TARGET
     USING (SELECT ? AS ORG_ID, ? AS INCIDENT_KEY, ? AS CHANNEL) AS SOURCE
       ON TARGET.ORG_ID = SOURCE.ORG_ID
      AND TARGET.INCIDENT_KEY = SOURCE.INCIDENT_KEY
      AND TARGET.CHANNEL = SOURCE.CHANNEL
     WHEN MATCHED THEN UPDATE SET
       -- A retry that fails must not erase the ticket a previous success
       -- created, so identifiers are only ever filled in, never blanked.
       EXTERNAL_ID = COALESCE(?, TARGET.EXTERNAL_ID),
       EXTERNAL_URL = COALESCE(?, TARGET.EXTERNAL_URL),
       STATE = ?,
       LAST_ERROR = ?,
       UPDATED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT
       (ORG_ID, INCIDENT_KEY, CHANNEL, EXTERNAL_ID, EXTERNAL_URL, STATE,
        LAST_ERROR, CREATED_BY)
       VALUES (SOURCE.ORG_ID, SOURCE.INCIDENT_KEY, SOURCE.CHANNEL, ?, ?, ?, ?, ?)`,
    [
      write.orgId,
      write.incidentKey,
      write.channel,
      write.externalId ?? null,
      write.externalUrl ?? null,
      write.state,
      write.error ?? null,
      write.externalId ?? null,
      write.externalUrl ?? null,
      write.state,
      write.error ?? null,
      write.actor,
    ],
  );
}

/**
 * Resolves a Jira issue key back to the incident it tracks.
 *
 * This is the inbound half of the close-sync. The issue key arrives from a
 * webhook, so it is bound as a parameter and matched exactly — a lookup is the
 * only authority on which incident a ticket belongs to, and the webhook body's
 * own claim about that is not consulted.
 */
export async function findIncidentByJiraIssue(
  issueKey: string,
): Promise<{ orgId: string; incidentKey: string } | null> {
  const rows = await executeQuery(
    `SELECT ORG_ID, INCIDENT_KEY
     FROM NOCTURNE.CONFIG.INCIDENT_INTEGRATIONS
     WHERE CHANNEL = 'jira' AND EXTERNAL_ID = ?
     LIMIT 1`,
    [issueKey],
  );
  if (!rows.length) return null;
  return {
    orgId: textOr(rows[0]!.ORG_ID, ""),
    incidentKey: textOr(rows[0]!.INCIDENT_KEY, ""),
  };
}

/* ── SOC alert payloads ────────────────────────────────────────────────────── */

/**
 * The incident-level columns every outbound alert renders. Shared so the
 * recipient-joined query and the recipient-free one cannot drift: a Slack
 * message and an email must describe the same incident the same way.
 */
const INCIDENT_ALERT_COLUMNS = `
       i.INCIDENT_KEY,
       i.ORG_ID,
       i.ORGANIZATION_NAME,
       i.TOP_TITLE,
       i.TOP_URL,
       i.IMPACT_SEVERITY_BAND,
       i.IMPACT_SEVERITY_SCORE,
       i.LEAK_TYPE_LABELS,
       i.QUANTITY_CLAIMED,
       i.EVIDENCE_CONFIDENCE_SCORE,
       i.TRIAGE_PRIORITY_SCORE,
       i.ACTOR_NAME,
       i.INSIGHT_HEADLINE,
       i.EXECUTIVE_SUMMARY,
       i.RECOMMENDED_ACTIONS,
       TO_VARCHAR(i.FIRST_SEEN, ${TS}) AS FIRST_SEEN`;

/** Everything about the incident itself; nothing about who is being told. */
export type IncidentAlertFacts = Omit<
  PendingAlert,
  "username" | "email" | "displayName"
>;

function mapIncidentAlertFacts(row: SnowflakeRow): IncidentAlertFacts {
  return {
    incidentKey: textOr(row.INCIDENT_KEY, ""),
    orgId: textOr(row.ORG_ID, ""),
    organizationName: textOr(row.ORGANIZATION_NAME, ""),
    title: textOr(row.TOP_TITLE, ""),
    sourceUrl: textOr(row.TOP_URL, ""),
    severityBand: textOr(row.IMPACT_SEVERITY_BAND, "informational") as SeverityBand,
    severityScore: num(row.IMPACT_SEVERITY_SCORE),
    firstSeen: text(row.FIRST_SEEN),
    leakTypes: list(row.LEAK_TYPE_LABELS) as LeakType[],
    quantityClaimed: num(row.QUANTITY_CLAIMED),
    evidenceConfidenceScore: num(row.EVIDENCE_CONFIDENCE_SCORE),
    triagePriorityScore: num(row.TRIAGE_PRIORITY_SCORE),
    actorName: text(row.ACTOR_NAME),
    insightHeadline: text(row.INSIGHT_HEADLINE),
    executiveSummary: text(row.EXECUTIVE_SUMMARY),
    recommendedActions: list(row.RECOMMENDED_ACTIONS),
  };
}

/**
 * Builds the alert payload for one incident and every recipient configured for
 * its organization.
 *
 * Unlike the scheduled sweep in `findPendingAlerts`, this ignores severity-band
 * preferences and the ALERT_DELIVERIES anti-join: an analyst who clicks
 * "Dispatch SOC alert" is making an explicit decision to page the team about
 * this specific incident, and silently dropping it because the band is below
 * someone's threshold would make the button lie.
 *
 * Returns an empty array when no profile carries an email — which is a
 * statement about the mailing list, not about the incident. Callers that
 * describe the incident somewhere other than an inbox want
 * `getIncidentAlertFacts` instead.
 */
export async function getIncidentAlertPayloads(
  orgId: string,
  incidentKey: string,
): Promise<PendingAlert[]> {
  const rows = await executeQuery(
    `SELECT ${INCIDENT_ALERT_COLUMNS},
       p.USERNAME,
       p.EMAIL,
       COALESCE(p.DISPLAY_NAME, p.USERNAME) AS DISPLAY_NAME
     FROM NOCTURNE.DASHBOARD.VW_INCIDENTS i
     JOIN NOCTURNE.CONFIG.USER_PROFILES p
       ON p.EMAIL IS NOT NULL
      AND (p.USERNAME = i.ORG_ID OR p.USERNAME = 'admin')
     WHERE i.ORG_ID = ? AND i.INCIDENT_KEY = ?`,
    [orgId, incidentKey],
  );

  return rows.map((row) => ({
    ...mapIncidentAlertFacts(row),
    username: textOr(row.USERNAME, ""),
    email: textOr(row.EMAIL, ""),
    displayName: textOr(row.DISPLAY_NAME, ""),
  }));
}

/**
 * The same incident facts with no recipient attached.
 *
 * Jira and Slack describe the incident to a channel, not to a mailing list, so
 * they must not inherit the email path's inner join. They previously did, by
 * borrowing the first recipient row as a representative — which meant an
 * organization with no email on file got a ticket and a Slack post built from a
 * placeholder: no severity score, no confidence, no exposed-data types, no
 * actor, no summary. The alert looked like the cascade had concluded nothing,
 * when in fact it had concluded everything and nobody had filled in an address.
 */
export async function getIncidentAlertFacts(
  orgId: string,
  incidentKey: string,
): Promise<IncidentAlertFacts | null> {
  const rows = await executeQuery(
    `SELECT ${INCIDENT_ALERT_COLUMNS}
     FROM NOCTURNE.DASHBOARD.VW_INCIDENTS i
     WHERE i.ORG_ID = ? AND i.INCIDENT_KEY = ?`,
    [orgId, incidentKey],
  );
  return rows.length ? mapIncidentAlertFacts(rows[0]) : null;
}

/* ── report data ───────────────────────────────────────────────────────────── */

function mapReportIncident(row: SnowflakeRow): ReportIncident {
  return {
    orgId: textOr(row.ORG_ID, ""),
    organizationName: textOr(row.ORGANIZATION_NAME, ""),
    incidentKey: textOr(row.INCIDENT_KEY, ""),
    title: textOr(row.TITLE, ""),
    url: textOr(row.URL, ""),
    source: text(row.SOURCE),
    firstSeen: textOr(row.FIRST_SEEN, ""),
    lastSeen: text(row.LAST_SEEN),
    leakTypes: list(row.LEAK_TYPE_LABELS) as LeakType[],
    quantityClaimed: num(row.QUANTITY_CLAIMED),
    impactSeverityScore: num(row.IMPACT_SEVERITY_SCORE),
    impactSeverityBand: text(row.IMPACT_SEVERITY_BAND) as SeverityBand | null,
    evidenceConfidenceScore: num(row.EVIDENCE_CONFIDENCE_SCORE),
    triagePriorityScore: num(row.TRIAGE_PRIORITY_SCORE),
    triagePriorityBand: text(row.TRIAGE_PRIORITY_BAND) as SeverityBand | null,
    actorName: text(row.ACTOR_NAME),
    actorCredibilityScore: num(row.ACTOR_CREDIBILITY_SCORE),
    groundingLevel: text(row.GROUNDING_LEVEL),
    corroborationCount: num(row.CORROBORATION_COUNT),
    sightingCount: num(row.SIGHTING_COUNT),
    insightHeadline: text(row.INSIGHT_HEADLINE),
    executiveSummary: text(row.EXECUTIVE_SUMMARY),
    businessImpact: text(row.BUSINESS_IMPACT),
    recommendedActions: list(row.RECOMMENDED_ACTIONS),
    remediationStatus: textOr(row.REMEDIATION_STATUS, "new") as RemediationStatus,
    mitigatedAt: text(row.MITIGATED_AT),
    mitigatedBy: text(row.MITIGATED_BY),
    jiraIssueKey: text(row.JIRA_ISSUE_KEY),
    jiraIssueUrl: text(row.JIRA_ISSUE_URL),
  };
}

/**
 * Incidents first seen inside the period, most severe first.
 *
 * The bound is half-open — `>= start AND < end` — so consecutive weekly reports
 * partition the timeline exactly, with no incident appearing in two of them and
 * none falling between.
 */
export async function listReportIncidents(
  scope: DataScope,
  period: ReportPeriod,
): Promise<ReportIncident[]> {
  const scoped = scope.kind === "org";
  const rows = await executeQuery(
    `SELECT
       ORG_ID,
       ORGANIZATION_NAME,
       INCIDENT_KEY,
       TITLE,
       URL,
       SOURCE,
       TO_VARCHAR(FIRST_SEEN, ${TS}) AS FIRST_SEEN,
       TO_VARCHAR(LAST_SEEN, ${TS}) AS LAST_SEEN,
       LEAK_TYPE_LABELS,
       QUANTITY_CLAIMED,
       IMPACT_SEVERITY_SCORE,
       IMPACT_SEVERITY_BAND,
       EVIDENCE_CONFIDENCE_SCORE,
       TRIAGE_PRIORITY_SCORE,
       TRIAGE_PRIORITY_BAND,
       ACTOR_NAME,
       ACTOR_CREDIBILITY_SCORE,
       GROUNDING_LEVEL,
       CORROBORATION_COUNT,
       SIGHTING_COUNT,
       INSIGHT_HEADLINE,
       EXECUTIVE_SUMMARY,
       BUSINESS_IMPACT,
       RECOMMENDED_ACTIONS,
       REMEDIATION_STATUS,
       TO_VARCHAR(MITIGATED_AT, ${TS}) AS MITIGATED_AT,
       MITIGATED_BY,
       JIRA_ISSUE_KEY,
       JIRA_ISSUE_URL
     FROM NOCTURNE.DASHBOARD.VW_REPORT_INCIDENTS
     WHERE FIRST_SEEN >= TO_TIMESTAMP_TZ(?)
       AND FIRST_SEEN < TO_TIMESTAMP_TZ(?)
       ${scoped ? "AND ORG_ID = ?" : ""}
     ORDER BY IMPACT_SEVERITY_SCORE DESC NULLS LAST, FIRST_SEEN DESC`,
    scoped
      ? [period.startsAt, period.endsAt, scope.orgId]
      : [period.startsAt, period.endsAt],
  );
  return rows.map(mapReportIncident);
}

export interface ReportRunWrite {
  orgId: string | null;
  kind: "evidence_pdf" | "evidence_csv" | "weekly_pdf";
  period: ReportPeriod;
  incidentCount: number;
  delivery: "download" | "email";
  recipients: string[];
  generatedBy: string;
}

/** Records that a report was produced. Non-fatal, for the same reason as the audit. */
export async function recordReportRun(run: ReportRunWrite): Promise<void> {
  try {
    await executeQuery(
      `INSERT INTO NOCTURNE.CONFIG.REPORT_RUNS
         (ORG_ID, KIND, PERIOD_START, PERIOD_END, INCIDENT_COUNT, DELIVERY,
          RECIPIENTS, GENERATED_BY)
       SELECT ?, ?, TO_TIMESTAMP_TZ(?), TO_TIMESTAMP_TZ(?), ?, ?,
              CAST(PARSE_JSON(?) AS ARRAY), ?`,
      [
        run.orgId,
        run.kind,
        run.period.startsAt,
        run.period.endsAt,
        run.incidentCount,
        run.delivery,
        JSON.stringify(run.recipients),
        run.generatedBy,
      ],
    );
  } catch (error) {
    console.error(
      "[nocturne-triage] report run write failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

/** Recipients for a scheduled weekly digest, from the profile switch. */
export async function listWeeklyDigestRecipients(): Promise<
  Array<{ username: string; email: string; displayName: string; orgId: string | null }>
> {
  const rows = await executeQuery(
    `SELECT
       USERNAME,
       EMAIL,
       COALESCE(DISPLAY_NAME, USERNAME) AS DISPLAY_NAME
     FROM NOCTURNE.CONFIG.USER_PROFILES
     WHERE EMAIL IS NOT NULL
       AND COALESCE(WEEKLY_DIGEST, FALSE) = TRUE
     ORDER BY USERNAME`,
  );
  return rows.map((row) => {
    const username = textOr(row.USERNAME, "");
    return {
      username,
      email: textOr(row.EMAIL, ""),
      displayName: textOr(row.DISPLAY_NAME, username),
      // The demo directory keys an org user's profile by their org id, and the
      // fleet admin by the literal "admin". Same convention as the alert sweep.
      orgId: username === "admin" ? null : username,
    };
  });
}

/* ── needs-review screenshots ──────────────────────────────────────────────── */

function mapScreenshot(row: SnowflakeRow): PageScreenshot {
  return {
    orgId: textOr(row.ORG_ID, ""),
    monitorKey: textOr(row.MONITOR_KEY, ""),
    url: textOr(row.URL, ""),
    status: textOr(row.STATUS, "requested") as ScreenshotStatus,
    // Filled in by the route, which is where signing credentials live.
    viewUrl: null,
    pageTitle: text(row.PAGE_TITLE),
    captureError: text(row.CAPTURE_ERROR),
    requestedBy: textOr(row.REQUESTED_BY, ""),
    requestedAt: textOr(row.REQUESTED_AT, ""),
    capturedAt: text(row.CAPTURED_AT),
  };
}

const SCREENSHOT_COLUMNS = `
  ORG_ID,
  MONITOR_KEY,
  URL,
  STATUS,
  OBJECT_URI,
  PAGE_TITLE,
  CAPTURE_ERROR,
  REQUESTED_BY,
  TO_VARCHAR(REQUESTED_AT, ${TS}) AS REQUESTED_AT,
  TO_VARCHAR(CAPTURED_AT, ${TS}) AS CAPTURED_AT
`;

/**
 * Queues a capture for one monitor row, or re-queues a failed one.
 *
 * A capture already in flight is left alone: re-requesting would hand a second
 * worker the same .onion page, and Tor circuits are the scarce resource in this
 * whole system. A completed capture is likewise kept — the admin asked to see
 * the page, and the page as it looked when it was found is the more useful
 * artifact than a fresh fetch of a listing that may since have been pulled.
 */
export async function requestScreenshot(input: {
  orgId: string;
  monitorKey: string;
  dedupeKey: string | null;
  url: string;
  requestedBy: string;
  /** Forces a re-capture of a row that already has one. */
  refresh?: boolean;
}): Promise<void> {
  await executeQuery(
    `MERGE INTO NOCTURNE.CONFIG.PAGE_SCREENSHOTS AS TARGET
     USING (SELECT ? AS ORG_ID, ? AS MONITOR_KEY) AS SOURCE
       ON TARGET.ORG_ID = SOURCE.ORG_ID
      AND TARGET.MONITOR_KEY = SOURCE.MONITOR_KEY
     WHEN MATCHED AND (TARGET.STATUS = 'failed' OR ?) THEN UPDATE SET
       STATUS = 'requested',
       URL = ?,
       DEDUPE_KEY = ?,
       CAPTURE_ERROR = NULL,
       REQUESTED_BY = ?,
       REQUESTED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT
       (ORG_ID, MONITOR_KEY, DEDUPE_KEY, URL, STATUS, REQUESTED_BY)
       VALUES (SOURCE.ORG_ID, SOURCE.MONITOR_KEY, ?, ?, 'requested', ?)`,
    [
      input.orgId,
      input.monitorKey,
      input.refresh ?? false,
      input.url,
      input.dedupeKey,
      input.requestedBy,
      input.dedupeKey,
      input.url,
      input.requestedBy,
    ],
  );
}

export async function getScreenshot(
  orgId: string,
  monitorKey: string,
): Promise<(PageScreenshot & { objectUri: string | null }) | null> {
  const rows = await executeQuery(
    `SELECT ${SCREENSHOT_COLUMNS}
     FROM NOCTURNE.CONFIG.PAGE_SCREENSHOTS
     WHERE ORG_ID = ? AND MONITOR_KEY = ?`,
    [orgId, monitorKey],
  );
  if (!rows.length) return null;
  return {
    ...mapScreenshot(rows[0]!),
    objectUri: text(rows[0]!.OBJECT_URI),
  };
}

/* ── analyst verdicts on needs-review rows ─────────────────────────────────── */

export async function recordReviewDecision(input: {
  orgId: string;
  monitorKey: string;
  decision: ReviewDecision;
  note: string | null;
  decidedBy: string;
}): Promise<void> {
  await executeQuery(
    `MERGE INTO NOCTURNE.CONFIG.REVIEW_DECISIONS AS TARGET
     USING (SELECT ? AS ORG_ID, ? AS MONITOR_KEY) AS SOURCE
       ON TARGET.ORG_ID = SOURCE.ORG_ID
      AND TARGET.MONITOR_KEY = SOURCE.MONITOR_KEY
     WHEN MATCHED THEN UPDATE SET
       DECISION = ?,
       NOTE = ?,
       DECIDED_BY = ?,
       DECIDED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT
       (ORG_ID, MONITOR_KEY, DECISION, NOTE, DECIDED_BY)
       VALUES (SOURCE.ORG_ID, SOURCE.MONITOR_KEY, ?, ?, ?)`,
    [
      input.orgId,
      input.monitorKey,
      input.decision,
      input.note,
      input.decidedBy,
      input.decision,
      input.note,
      input.decidedBy,
    ],
  );
}

/** Clears a verdict, returning the row to whatever the cascade concluded. */
export async function clearReviewDecision(
  orgId: string,
  monitorKey: string,
): Promise<void> {
  await executeQuery(
    `DELETE FROM NOCTURNE.CONFIG.REVIEW_DECISIONS
     WHERE ORG_ID = ? AND MONITOR_KEY = ?`,
    [orgId, monitorKey],
  );
}

/**
 * Confirms one monitor row belongs to the organization it claims to, and
 * returns the URL to capture.
 *
 * A screenshot request names a monitor key and the console trusts it no further
 * than that. Without this lookup a caller could point the Tor worker at any URL
 * they liked, which is a server-side request forgery with a bespoke anonymity
 * network attached.
 */
/**
 * Where a capture request gets its URL.
 *
 * `capturable` is false for a target that exists but has no page a browser
 * could open. Manual paste-dump uploads are the case that matters: their
 * incident URL is a `manual-upload://<uuid>` receipt, not a location. Handing
 * that to the Tor worker produces a failed capture and an error the analyst
 * cannot act on, so it is refused here with the actual reason.
 */
export interface CaptureTarget {
  url: string;
  dedupeKey: string | null;
  title: string;
  incidentKey: string | null;
  capturable: boolean;
  reason: string | null;
}

/**
 * Only a page an ordinary browser can open. This is a security boundary as
 * much as a usability one: the URL reaches a headless browser sitting behind
 * Tor, and schemes like `file:` or `manual-upload:` have no business being
 * dereferenced there. The URL always comes from the warehouse rather than the
 * request, so this guards against bad *stored* data, not a hostile caller.
 */
function captureRefusal(url: string): string | null {
  if (!url) return "That row has no source URL to capture.";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That row's source URL could not be parsed.";
  }
  if (parsed.protocol === "manual-upload:") {
    return (
      "This incident came from a manual paste-dump upload, so there is no live "
      + "page to capture. The uploaded file is the evidence."
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `Pages served over ${parsed.protocol} cannot be captured.`;
  }
  return null;
}

/**
 * Resolves a capture target from either half of the console's vocabulary.
 *
 * VW_BREACH_MONITOR is tried first because it is the richer row and covers
 * every page the cascade saw, decided or not. An incident raised from a source
 * the monitor view no longer carries still has its URL in VW_INCIDENTS, and
 * captures were previously unreachable for those rows purely because the
 * lookup stopped at the first view — which is why the capture button only ever
 * appeared on "Needs Review".
 */
export async function findCaptureTarget(
  orgId: string,
  key: string,
): Promise<CaptureTarget | null> {
  const monitor = await findMonitorRow(orgId, key);
  if (monitor) {
    return {
      url: monitor.url,
      dedupeKey: monitor.dedupeKey,
      title: monitor.title,
      incidentKey: monitor.incidentKey,
      capturable: captureRefusal(monitor.url) === null,
      reason: captureRefusal(monitor.url),
    };
  }

  const rows = await executeQuery(
    `SELECT TOP_URL, TOP_TITLE, INCIDENT_KEY
     FROM NOCTURNE.DASHBOARD.VW_INCIDENTS
     WHERE ORG_ID = ? AND INCIDENT_KEY = ?`,
    [orgId, key],
  );
  if (!rows.length) return null;

  const url = textOr(rows[0]!.TOP_URL, "");
  return {
    url,
    // VW_INCIDENTS carries no dedupe key; the capture is keyed by the incident
    // key alone, which is unique per organization.
    dedupeKey: null,
    title: textOr(rows[0]!.TOP_TITLE, ""),
    incidentKey: textOr(rows[0]!.INCIDENT_KEY, key),
    capturable: captureRefusal(url) === null,
    reason: captureRefusal(url),
  };
}

export async function findMonitorRow(
  orgId: string,
  monitorKey: string,
): Promise<{
  url: string;
  dedupeKey: string | null;
  title: string;
  monitorStatus: string;
  incidentKey: string | null;
} | null> {
  const rows = await executeQuery(
    `SELECT URL, DEDUPE_KEY, TITLE, MONITOR_STATUS, INCIDENT_KEY
     FROM NOCTURNE.DASHBOARD.VW_BREACH_MONITOR
     WHERE ORG_ID = ? AND MONITOR_KEY = ?`,
    [orgId, monitorKey],
  );
  if (!rows.length) return null;
  return {
    url: textOr(rows[0]!.URL, ""),
    dedupeKey: text(rows[0]!.DEDUPE_KEY),
    title: textOr(rows[0]!.TITLE, ""),
    monitorStatus: textOr(rows[0]!.MONITOR_STATUS, ""),
    incidentKey: text(rows[0]!.INCIDENT_KEY),
  };
}

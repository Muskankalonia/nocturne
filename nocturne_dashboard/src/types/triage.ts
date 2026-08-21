import type { LeakType, RemediationStatus, SeverityBand } from "@/types";

/**
 * Contract for executable triage: the actions an analyst takes on an incident,
 * their record in Snowflake, and the external systems they reach.
 *
 * Kept apart from `@/types/dashboard` on purpose. That file describes what the
 * detection cascade concluded and is read-only by construction; everything here
 * is a write, and the two have different failure modes worth not conflating.
 */

/** The action verbs written to NOCTURNE.CONFIG.INCIDENT_ACTION_AUDIT. */
export type TriageAction =
  | "mark_mitigated"
  | "unmark_mitigated"
  | "dispatch_soc_alert"
  | "export_evidence"
  | "generate_weekly_report"
  | "request_screenshot"
  | "review_decision";

export type TriageOutcome = "success" | "partial" | "failed";

/** External systems a dispatch can reach. */
export type IntegrationChannel = "email" | "jira" | "slack";

export type IntegrationState = "open" | "closed" | "sent" | "failed";

/** One channel's result within a dispatch, as reported back to the console. */
export interface IntegrationDispatchResult {
  channel: IntegrationChannel;
  /** False when the channel is not configured; not an error, just unused. */
  configured: boolean;
  delivered: boolean;
  externalId: string | null;
  externalUrl: string | null;
  /** Present when delivery failed. Safe to show: no credentials, no payload. */
  error: string | null;
}

export interface SocDispatchResponse {
  incidentKey: string;
  orgId: string;
  outcome: TriageOutcome;
  results: IntegrationDispatchResult[];
  dispatchedAt: string;
}

/** VW_INCIDENT_ACTION_STATE, one row, normalized. */
export interface IncidentActionState {
  orgId: string;
  incidentKey: string;
  organizationName: string;
  title: string;
  impactSeverityBand: SeverityBand | null;
  remediationStatus: RemediationStatus;
  mitigatedAt: string | null;
  mitigatedBy: string | null;
  remediationNote: string | null;
  /** 'console' or 'jira' — which side made the last change. */
  remediationUpdatedVia: string | null;
  remediationUpdatedAt: string | null;
  jiraIssueKey: string | null;
  jiraIssueUrl: string | null;
  jiraState: IntegrationState | null;
  /** Slack message timestamp, used as the thread anchor for follow-ups. */
  slackMessageTs: string | null;
  slackMessageUrl: string | null;
  slackState: IntegrationState | null;
  socEmailState: IntegrationState | null;
  socEmailSentAt: string | null;
  hasBeenDispatched: boolean;
  /** An analyst's verdict on the incident, when one has been recorded. */
  reviewDecision: ReviewDecision | null;
  reviewDecidedBy: string | null;
  reviewNote: string | null;
}

export interface MitigationResponse {
  incidentKey: string;
  /** Null when the row is a page that never became an incident. */
  state: IncidentActionState | null;
  /** What happened to the linked Jira ticket, when there is one. */
  jira: IntegrationDispatchResult | null;
}

/** One row of VW_TRIAGE_AUDIT. */
export interface TriageAuditEntry {
  actionId: string;
  orgId: string;
  organizationName: string;
  incidentKey: string | null;
  incidentTitle: string | null;
  action: TriageAction | string;
  actor: string;
  outcome: TriageOutcome | string;
  summary: string | null;
  createdAt: string;
}

/* ── evidence export & reporting ───────────────────────────────────────────── */

/**
 * Export windows. Named rather than free-form dates because every one of these
 * is also a valid *audit* record — "last 7 days from 2026-08-17" reconstructs
 * exactly, where an arbitrary pair of timestamps invites off-by-one arguments
 * about whether a boundary incident was included.
 */
export type ReportWindow = "24h" | "7d" | "30d" | "90d";

export type ReportFormat = "pdf" | "csv";

export interface ReportPeriod {
  window: ReportWindow;
  label: string;
  startsAt: string;
  endsAt: string;
}

/** The incident projection both exports and the weekly report render from. */
export interface ReportIncident {
  orgId: string;
  organizationName: string;
  incidentKey: string;
  title: string;
  url: string;
  source: string | null;
  firstSeen: string;
  lastSeen: string | null;
  leakTypes: LeakType[];
  quantityClaimed: number | null;
  impactSeverityScore: number | null;
  impactSeverityBand: SeverityBand | null;
  evidenceConfidenceScore: number | null;
  triagePriorityScore: number | null;
  triagePriorityBand: SeverityBand | null;
  actorName: string | null;
  actorCredibilityScore: number | null;
  groundingLevel: string | null;
  corroborationCount: number | null;
  sightingCount: number | null;
  insightHeadline: string | null;
  executiveSummary: string | null;
  businessImpact: string | null;
  recommendedActions: string[];
  remediationStatus: RemediationStatus;
  mitigatedAt: string | null;
  mitigatedBy: string | null;
  jiraIssueKey: string | null;
  jiraIssueUrl: string | null;
}

export interface ReportSummary {
  totalIncidents: number;
  byBand: Record<SeverityBand, number>;
  mitigatedCount: number;
  openCount: number;
  recordsClaimed: number;
  distinctActors: number;
  exposedDataClasses: LeakType[];
  topIncident: ReportIncident | null;
}

export interface ReportPayload {
  period: ReportPeriod;
  scopeLabel: string;
  generatedAt: string;
  generatedBy: string;
  summary: ReportSummary;
  incidents: ReportIncident[];
}

export interface WeeklyReportDeliveryResult {
  delivered: boolean;
  recipients: string[];
  error: string | null;
}

/* ── needs-review screenshot capture ───────────────────────────────────────── */

export type ScreenshotStatus = "requested" | "capturing" | "captured" | "failed";

export interface PageScreenshot {
  orgId: string;
  monitorKey: string;
  url: string;
  status: ScreenshotStatus;
  /** Time-bounded signed URL, minted per response. Never a raw bucket path. */
  viewUrl: string | null;
  pageTitle: string | null;
  captureError: string | null;
  requestedBy: string;
  requestedAt: string;
  capturedAt: string | null;
}

export type ReviewDecision = "confirmed_breach" | "not_a_breach";

export interface ReviewDecisionRecord {
  orgId: string;
  monitorKey: string;
  decision: ReviewDecision;
  note: string | null;
  decidedBy: string;
  decidedAt: string;
}

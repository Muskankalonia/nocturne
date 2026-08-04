import type {
  AiStatus,
  BreachRecord,
  CascadeStage,
  ClaimStatus,
  ConfidenceBand,
  DataScope,
  EdgeType,
  EntityType,
  ExtractedClaimStatus,
  GroundingLevel,
  IncidentInsight,
  L2Route,
  LeakType,
  RelationshipLabel,
  RemediationStatus,
  SeverityBand,
} from "@/types";

/**
 * Stable JSON contract between the server-only data backend, API routes, and
 * dashboard pages. Dates are ISO strings because route responses must remain
 * serializable and independent of the Snowflake driver.
 */

export type IncidentBandCounts = Record<SeverityBand, number>;

export interface DashboardGroundingSummary {
  rate: number;
  exactCount: number;
  normalizedCount: number;
  verifiedCount: number;
  quarantinedCount: number;
  totalExtractedClaims: number;
}

export interface DashboardPipelineCounts {
  pagesCollected: number;
  pagesScreened: number;
  uniquePages: number;
  pagesRelevanceChecked: number;
  pagesSelectedForL2: number;
  pagesEvidenceExtracted: number;
  pagesOwnershipVerified: number;
  pagesDataTypesClassified: number;
  incidentsRaised: number;
}

export interface CommandCenterMetrics {
  topImpactSeverityScore: number | null;
  topImpactSeverityBand: SeverityBand | null;
  openIncidentCount: number;
  incidentsByBand: IncidentBandCounts;
  distinctThreatActorCount: number;
  grounding: DashboardGroundingSummary;
  pipeline: DashboardPipelineCounts;
  downstreamAiErrorCount: number;
}

/** One Snowflake VW_COMMAND_CENTER row after server-side normalization. */
export interface CommandCenterOrganizationSnapshot {
  orgId: string;
  organizationName: string;
  enabled: boolean;
  metrics: CommandCenterMetrics;
  lastUpdatedAt: string | null;
}

/**
 * The same incident powers the priority queue, breach list, and detail page.
 * Full cached insight travels with it; rendering a detail view never calls AI.
 */
export interface DashboardIncident extends BreachRecord {
  insight: IncidentInsight;
}

/** One accepted target claim from VW_INCIDENT_CLAIMS. */
export interface DashboardIncidentClaim {
  orgId: string;
  incidentKey: string;
  docId: string;
  dedupeKey: string;
  contentSha256: string;
  claimKey: string;
  statement: string;
  statementTruncated: boolean;
  claimStatus: ClaimStatus;
  claimStatusExtracted: ExtractedClaimStatus;
  quantityClaimed: number | null;
  groundingLevel: Exclude<GroundingLevel, "unmatched">;
  /** Accepted excerpt from the masked L2 input, never from RAW_TEXT. */
  maskedEvidenceText: string;
  evidenceTextTruncated: boolean;
  evidenceStart: number | null;
  evidenceEnd: number | null;
  selectedWindowId: string | null;
  subjectNodeKey: string;
  subjectName: string;
  corroborationCount: number;
  sightingCount: number;
  mirrorSightingCount: number;
  uniqueClaimCount: number;
  disputeCount: number;
  graphScope: "target_incident";
}

/** Count-only signal projection; exact indicator values never reach the API. */
export interface DashboardIncidentIndicatorCount {
  orgId: string;
  incidentKey: string;
  docId: string;
  dedupeKey: string;
  indicatorType: string;
  indicatorCount: number;
  strongIndicatorCount: number;
  mediumIndicatorCount: number;
  weakIndicatorCount: number;
  indicatorEvidenceScore: number;
}

/** An entity or claim node in one incident's promoted graph component. */
export interface DashboardIncidentGraphNode {
  orgId: string;
  incidentKey: string;
  nodeKey: string;
  nodeType: EntityType | "claim";
  normalizedName: string | null;
  displayName: string;
  isMonitoredOrg: boolean;
  mentionCount: number;
  sightingCount: number;
  docCount: number;
  mirrorSightingCount: number;
  firstSeen: string;
  lastSeen: string;
  graphScope: "target_incident";
}

/** A validated relationship in one incident's promoted graph component. */
export interface DashboardIncidentGraphEdge {
  orgId: string;
  incidentKey: string;
  graphEdgeKey: string;
  sourceKey: string;
  edgeType: EdgeType;
  targetKey: string;
  sourceKind: "entity" | "claim";
  sourceType: EntityType | "claim";
  targetKind: "entity" | "claim";
  targetType: EntityType | "claim";
  mentionCount: number;
  sightingCount: number;
  docCount: number;
  mirrorSightingCount: number;
  firstSeen: string;
  lastSeen: string;
  graphScope: "target_incident";
}

/** Complete serializable payload for one cached, organization-scoped incident. */
export interface IncidentDetailResponse {
  scope: DataScope;
  incident: DashboardIncident;
  claims: DashboardIncidentClaim[];
  indicatorCounts: DashboardIncidentIndicatorCount[];
  graph: {
    nodes: DashboardIncidentGraphNode[];
    edges: DashboardIncidentGraphEdge[];
  };
  fetchedAt: string;
}

/** The three mutually exclusive audit categories exposed by VW_BREACH_MONITOR. */
export type BreachMonitorStatus =
  | "confirmed_yours"
  | "needs_review"
  | "another_company";

/** How far a Breach Monitor row progressed through the cached pipeline. */
export type BreachMonitorPipelineState =
  | "incident_ready"
  | "awaiting_leak_type_or_severity"
  | "relationship_ai_error"
  | "stopped_after_l1"
  | "stopped_after_l2";

/**
 * One audit-safe VW_BREACH_MONITOR row.
 *
 * Confirmed rows are incident-level and have an incidentKey. Review and
 * other-company rows are document-level and retain docId/dedupeKey instead.
 * Scores and actor attribution are null until an incident has reached L4.
 */
export interface BreachMonitorRecord {
  monitorKey: string;
  incidentKey: string | null;
  orgId: string;
  organizationName: string;
  organizationDomain: string | null;
  docId: string | null;
  dedupeKey: string | null;
  contentSha256: string;
  title: string;
  url: string;
  source: string;
  discoveredAt: string;
  monitorStatus: BreachMonitorStatus;
  pipelineState: BreachMonitorPipelineState;
  relationshipAiStatus: AiStatus;
  relationshipLabel: RelationshipLabel | null;
  l2Route: L2Route | null;
  routingReason: string;
  leakTypes: LeakType[];
  quantityClaimed: number | null;
  impactSeverityScore: number | null;
  impactSeverityBand: SeverityBand | null;
  evidenceConfidenceScore: number | null;
  evidenceConfidenceBand: ConfidenceBand | null;
  triagePriorityScore: number | null;
  triagePriorityBand: SeverityBand | null;
  actorNodeKey: string | null;
  actorName: string | null;
  actorCredibilityScore: number | null;
  groundingLevel: GroundingLevel | null;
  remediationStatus: RemediationStatus;
  detailAvailable: boolean;
}

export interface BreachMonitorSummary {
  totalRows: number;
  confirmedLeaks: number;
  recordsClaimed: number;
  exposedDataClassCount: number;
  needsReview: number;
  anotherCompany: number;
}

/** Serializable response shared by single-organization and fleet views. */
export interface BreachMonitorResponse {
  scope: DataScope;
  summary: BreachMonitorSummary;
  rows: BreachMonitorRecord[];
  lastUpdatedAt: string | null;
  fetchedAt: string;
}

/**
 * Single-organization and fleet requests share one response shape:
 *
 * - org scope: organizations contains one item and totals equals its metrics;
 * - fleet scope: organizations contains every permitted organization and totals
 *   is the server-computed aggregate across those rows.
 */
export interface CommandCenterResponse {
  scope: DataScope;
  organizations: CommandCenterOrganizationSnapshot[];
  totals: CommandCenterMetrics;
  cascade: CascadeStage[];
  incidents: DashboardIncident[];
  lastUpdatedAt: string | null;
  fetchedAt: string;
}

/**
 * Monitored-organization configuration, read from and written back to
 * NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS. This is the one table the console
 * mutates: L1 ownership resolution matches against these aliases, domains and
 * products, so editing them changes which pages become confirmed breaches.
 */
export interface MonitoredOrganizationRecord {
  orgId: string;
  canonicalName: string;
  aliases: string[];
  domains: string[];
  products: string[];
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The editable subset. `orgId` and `canonicalName` are deliberately not here. */
export interface MonitoredOrganizationUpdate {
  aliases: string[];
  domains: string[];
  products: string[];
  enabled: boolean;
}

export interface MonitoredOrganizationsResponse {
  organizations: MonitoredOrganizationRecord[];
  fetchedAt: string;
}

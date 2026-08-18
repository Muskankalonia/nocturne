import type {
  AiStatus,
  AiStage,
  BreachRecord,
  CascadeStage,
  ClaimStatus,
  ConfidenceBand,
  DataScope,
  EdgeType,
  EntityType,
  ExtractedClaimStatus,
  GraphPayload,
  GroundingLevel,
  IncidentInsight,
  L2Route,
  LeakType,
  RelationshipLabel,
  RemediationStatus,
  RejectionReason,
  ScoreReason,
  ScoreVector,
  SeverityBand,
  TaskHealth,
  ThreatActor,
  VersionDrift,
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

/** The two organization-scoped projections available on the graph screen. */
export type KnowledgeGraphView = "incident" | "actors";

/** Minimal incident context shown when the graph is scoped to one incident. */
export interface KnowledgeGraphIncidentRoot {
  incidentKey: string;
  title: string;
  url: string;
  actorName: string | null;
  impactSeverityScore: number | null;
  impactSeverityBand: SeverityBand | null;
  firstSeen: string;
}

/**
 * Live graph response. Incident mode contains one promoted component; actor
 * mode contains the organization-wide aggregate of all promoted components.
 */
export interface KnowledgeGraphResponse extends GraphPayload {
  view: KnowledgeGraphView;
  rootIncident: KnowledgeGraphIncidentRoot | null;
  incidentCount: number;
  fetchedAt: string;
}

/** Entity kinds that can filter Command Center from a graph click. */
export type CommandCenterGraphFilterType =
  | "actor_alias"
  | "claim"
  | "data_asset"
  | "domain"
  | "edge"
  | "marketplace"
  | "organization"
  | "product";

/** Server-sanitized graph selection used to filter incident lists. */
export interface CommandCenterGraphFilter {
  filterType: CommandCenterGraphFilterType;
  filterKey: string;
  filterLabel: string | null;
}

export interface ThreatActorsSummary {
  actorCount: number;
  corroboratedClaimCount: number;
  marketplaceCount: number;
  highestCredibilityScore: number;
}

/** Organization-isolated actor evidence and the aggregates shown above it. */
export interface ThreatActorsResponse {
  scope: DataScope;
  summary: ThreatActorsSummary;
  actors: ThreatActor[];
  lastUpdatedAt: string | null;
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
  appliedGraphFilter: CommandCenterGraphFilter | null;
  lastUpdatedAt: string | null;
  fetchedAt: string;
}

export interface PipelineOrganizationSummary {
  orgId: string;
  organizationName: string;
  lastUpdatedAt: string | null;
}

export interface PipelineAiCacheStage {
  stage: AiStage;
  cacheRows: number;
  successRows: number;
  errorRows: number;
  missingCandidates: number;
  lastCalledAt: string | null;
}

export interface PipelineCacheSummary {
  cacheRows: number;
  successRows: number;
  errorRows: number;
  missingCandidates: number;
  repeatCallsAvoided: number;
}

/**
 * Precision / recall / calibration against a labelled gold set.
 *
 * Optional because it is only meaningful where a gold set exists. Live tenants
 * have none, so this is absent and the Accuracy panel does not render — an
 * invented accuracy figure is worse than no figure.
 */
export interface PipelineAccuracyMetrics {
  goldSetSize: number;
  precision: number;
  recall: number;
  f1: number;
  falsePositiveRate: number;
  calibrationError: number;
  lastEvaluatedAt: string;
  /** Free-text provenance, rendered verbatim so the source is never implied. */
  basis: string;
}

export interface PipelineResponse {
  scope: DataScope;
  /** Present only when a labelled gold set backs the numbers. */
  accuracy?: PipelineAccuracyMetrics | null;
  organizations: PipelineOrganizationSummary[];
  cascade: CascadeStage[];
  grounding: DashboardGroundingSummary;
  deepAnalysisRate: number;
  cacheSummary: PipelineCacheSummary;
  cacheStages: PipelineAiCacheStage[];
  rejectionReasons: RejectionReason[];
  versionDrift: VersionDrift[];
  health: Array<{
    orgId: string | null;
    organizationName: string;
    lastIngestAt: string | null;
    groundingRate: number;
    quarantinedCount: number;
    totalExtractedCount: number;
    aiErrorCount: number;
    backlogCount: number;
    status: "healthy" | "lagging" | "degraded" | "failed";
  }>;
  tasks: TaskHealth[];
  lastUpdatedAt: string | null;
  fetchedAt: string;
}

/** One-shot analyst paste-dump run, separate from scheduled dark-web crawls. */
export type ManualUploadPipelineStageId =
  | "upload"
  | "raw_ingest"
  | "l0_signals"
  | "l1_relevance"
  | "l2_evidence"
  | "l3_graph"
  | "l4_insight";

export type ManualUploadPipelineStageState =
  | "waiting"
  | "running"
  | "complete"
  | "stopped"
  | "error";

export interface ManualUploadPipelineStage {
  id: ManualUploadPipelineStageId;
  label: string;
  caption: string;
  state: ManualUploadPipelineStageState;
  detail: string | null;
}

export interface ManualUploadCreateResponse {
  uploadId: string;
  orgId: string;
  title: string;
  objectPath: string;
  objectUri: string;
  statusUrl: string;
  message: string;
}

export interface ManualUploadStatus {
  orgId: string;
  organizationName: string;
  uploadId: string;
  docId: string | null;
  dedupeKey: string | null;
  contentSha256: string | null;
  runId: string | null;
  title: string;
  url: string;
  contentLength: number;
  fetchedAt: string | null;
  ingestedAt: string | null;
  sourceFile: string | null;
  rawLoaded: boolean;
  l0Complete: boolean;
  l1Complete: boolean;
  l2Complete: boolean;
  l4Complete: boolean;
  detailAvailable: boolean;
  monitorStatus: BreachMonitorStatus | null;
  pipelineState: string;
  relationshipAiStatus: AiStatus | null;
  relationshipLabel: RelationshipLabel | null;
  l2Eligible: boolean;
  targetMatchScore: number | null;
  targetAnchorType: string | null;
  leakMatchesScanned: number;
  strongIndicatorCount: number;
  mediumIndicatorCount: number;
  weakIndicatorCount: number;
  evidenceScore: number;
  indicatorSummary: string | null;
  l2ExtractionStatus: AiStatus | null;
  l2Route: L2Route | null;
  routingReason: string | null;
  claimCount: number;
  acceptedClaimCount: number;
  entityCount: number;
  acceptedEntityCount: number;
  acceptedTargetEntityCount: number;
  relationshipCount: number;
  acceptedRelationshipCount: number;
  targetLeakRelationGrounded: boolean;
  incidentKey: string | null;
  leakTypeAiStatus: AiStatus | null;
  leakTypeLabels: LeakType[];
  quantityClaimed: number | null;
  impactSeverityScore: number | null;
  impactSeverityBand: SeverityBand | null;
  evidenceConfidenceScore: number | null;
  evidenceConfidenceBand: ConfidenceBand | null;
  triagePriorityScore: number | null;
  triagePriorityBand: SeverityBand | null;
  scoreVector: ScoreVector;
  scoreReasons: ScoreReason[];
  insightAiStatus: AiStatus | null;
  insightHeadline: string | null;
  executiveSummary: string | null;
  whatHappened: string | null;
  businessImpact: string | null;
  recommendedActions: string[];
  confidenceAssessment: string | null;
  insightCaveats: string[];
  insightModelName: string | null;
  insightCalledAt: string | null;
  monitorKey: string | null;
  remediationStatus: RemediationStatus | null;
  lastUpdatedAt: string | null;
}

export interface ManualUploadStatusResponse {
  scope: DataScope;
  uploadId: string;
  status: ManualUploadStatus | null;
  stages: ManualUploadPipelineStage[];
  incident: DashboardIncident | null;
  graph: {
    nodes: DashboardIncidentGraphNode[];
    edges: DashboardIncidentGraphEdge[];
  };
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

/**
 * The self-service slice of a user's identity, from
 * NOCTURNE.CONFIG.USER_PROFILES. Role and tenant are absent by design — they
 * are authorization, and authorization never comes from an editable field.
 */
export interface UserProfileRecord {
  username: string;
  displayName: string | null;
  email: string | null;
  position: string | null;
  /** Severity bands this user is emailed about. Empty means alerts are off. */
  alertBands: SeverityBand[];
  weeklyDigest: boolean;
  updatedAt: string | null;
}

export interface UserProfileUpdate {
  displayName: string;
  email: string | null;
  position: string | null;
  alertBands: SeverityBand[];
  weeklyDigest: boolean;
}

/** One incident that qualified for an alert, paired with its recipient. */
export interface PendingAlert {
  incidentKey: string;
  orgId: string;
  organizationName: string;
  title: string;
  sourceUrl: string;
  severityBand: SeverityBand;
  severityScore: number | null;
  firstSeen: string | null;
  username: string;
  email: string;
  displayName: string;
  /* Context for the alert body. None of this is leaked material: it is the
     classification and the model's own summary, never a verbatim excerpt. */
  leakTypes: LeakType[];
  quantityClaimed: number | null;
  evidenceConfidenceScore: number | null;
  triagePriorityScore: number | null;
  actorName: string | null;
  insightHeadline: string | null;
  executiveSummary: string | null;
  recommendedActions: string[];
}

export interface AlertDispatchResult {
  scanned: number;
  queued: number;
  skipped: number;
  errors: string[];
}

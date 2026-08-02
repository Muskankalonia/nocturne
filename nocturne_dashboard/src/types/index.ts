/**
 * Nocturne Console — data model.
 *
 * Every union here mirrors a closed enum that already exists in the Snowflake
 * pipeline. Keeping them as string-literal unions (not `string`) means a
 * mismatch between the warehouse and the UI fails at compile time rather than
 * rendering an empty chip in production.
 *
 * Source of truth for each type is noted as `SQL:` on the interface.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Closed enums — mirror the SQL CHECK/enum values exactly
 * ──────────────────────────────────────────────────────────────────────────── */

/** SQL: 08_dt_relationship_classification.sql — the four L1 labels. */
export type RelationshipLabel =
  | "target_data_leak"
  | "target_mentioned_no_leak"
  | "other_organization_leak"
  | "no_leak";

/** SQL: 10_dt_l2_grounding_routing.sql — DT_L2_ROUTING.L2_ROUTE */
export type L2Route =
  | "target_confirmed"
  | "other_organization_confirmed"
  | "ambiguous"
  | "not_relevant"
  | "extraction_error";

/** SQL: 11_dt_leak_type_severity.sql — the five multi-label leak types. */
export type LeakType =
  | "credential"
  | "corporate_data"
  | "pii"
  | "financial"
  | "malware_exploit";

/** SQL: 13_dt_l4_severity.sql — band thresholds 0-19/20-39/40-59/60-79/80-100 */
export type SeverityBand =
  | "informational"
  | "low"
  | "medium"
  | "high"
  | "critical";

/** SQL: 13_dt_l4_severity.sql — EVIDENCE_CONFIDENCE_BAND uses its own scale. */
export type ConfidenceBand = "low" | "medium" | "high" | "very_high";

/** SQL: 10_dt_l2_grounding_routing.sql — GROUND_EVIDENCE() return level. */
export type GroundingLevel = "exact" | "normalized" | "unmatched";

/** SQL: 09 response schema — what the model may emit per claim. */
export type ExtractedClaimStatus = "unverified" | "self_evidenced" | "disputed";

/** SQL: 12_dt_l3_knowledge_graph.sql — promoted status after corroboration. */
export type ClaimStatus =
  | "unverified"
  | "self_evidenced"
  | "partially_corroborated"
  | "corroborated"
  | "disputed";

/** SQL: 09 response schema — the eight closed entity types. */
export type EntityType =
  | "organization"
  | "domain"
  | "product"
  | "actor_alias"
  | "marketplace"
  | "data_asset"
  | "contact_channel"
  | "location";

/** SQL: 09 response schema — the six closed relationship types. */
export type EdgeType =
  | "MADE_CLAIM"
  | "ALLEGEDLY_AFFECTS"
  | "OFFERS_FOR_SALE"
  | "LISTED_ON"
  | "CONTACTED_VIA"
  | "MENTIONS";

/** SQL: 10 — how an extracted entity resolved against MONITORED_ORGANIZATIONS. */
export type EntityMatchStatus =
  | "confirmed"
  | "ambiguous"
  | "context_only"
  | "unmatched";

export type EntityMatchMethod =
  | "exact_domain"
  | "exact_canonical_name"
  | "exact_alias"
  | "fuzzy_name"
  | "product_context"
  | "none";

/** Status of any of the four cached AI stages. */
export type AiStatus =
  | "success"
  | "error"
  | "invalid_response"
  | "pending_parse"
  | "pending"
  | "not_applicable";

export type AiStage =
  | "relationship"
  | "l2_extraction"
  | "leak_type"
  | "incident_insight";

/* ────────────────────────────────────────────────────────────────────────────
 * Identity & tenancy
 * ──────────────────────────────────────────────────────────────────────────── */

export type UserRole = "ORG_USER" | "SUPER_ADMIN";

/**
 * The scope a session is allowed to read.
 *
 * `{ kind: "fleet" }` is reachable only by SUPER_ADMIN. An ORG_USER session is
 * always `{ kind: "org", orgId }` and the server pins that value — the client
 * never supplies an orgId the API will trust.
 */
export type DataScope =
  | { kind: "org"; orgId: string }
  | { kind: "fleet" };

export interface User {
  /** Demo scheme: username === orgId, or the literal "admin". */
  username: string;
  displayName: string;
  initials: string;
  role: UserRole;
  /** null for SUPER_ADMIN — they are not bound to a single tenant. */
  orgId: string | null;
  lastSignInAt: string | null;
}

/** SQL: NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS */
export interface Organization {
  orgId: string;
  canonicalName: string;
  aliases: string[];
  domains: string[];
  products: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** UI-only: crawl cadence label, not currently stored in the warehouse. */
  crawlCadence: string | null;
}

export interface Session {
  user: User;
  /** Resolved at login; drives every query and the nav tree. */
  scope: DataScope;
  issuedAt: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * L4 scoring
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * SQL: 13_dt_l4_severity.sql — SCORE_VECTOR.
 *
 * Nulls are meaningful: a null component had its weight normalized away rather
 * than being treated as zero, so the UI must render "not available", never "0".
 */
export interface ScoreVector {
  dataSensitivity: number | null;
  exposureActionability: number | null;
  recordScale: number | null;
  ownershipEvidence: number | null;
  grounding: number | null;
  claimProof: number | null;
  corroboration: number | null;
  actorCredibility: number | null;
  impactSeverity: number | null;
  evidenceConfidence: number | null;
  triagePriority: number | null;
}

/** SQL: 13_dt_l4_severity.sql — SCORE_REASONS array values. */
export type ScoreReason =
  | "grounded_target_ownership_confirmed"
  | "record_count_unknown_and_omitted"
  | "corroborated_by_3_or_more_distinct_contents"
  | "corroborated_by_2_distinct_contents"
  | "single_distinct_content"
  | "same_content_mirrors_not_counted_as_corroboration"
  | "claim_disputed"
  | "strong_exposed_material_present"
  | "actor_not_identified_confidence_weight_omitted";

/* ────────────────────────────────────────────────────────────────────────────
 * Breach records
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One incident — the dashboard's primary unit.
 * SQL: VW_L4_INCIDENT_SEVERITY joined to VW_L4_INCIDENT_INSIGHTS.
 *
 * Incident boundary is ORG_ID + CONTENT_SHA256, so N mirrors of one dump are
 * one incident with sightingCount = N, not N criticals.
 */
export interface BreachRecord {
  incidentKey: string;
  orgId: string;
  /** Denormalized for the admin grid's Organization column. */
  organizationName: string;
  organizationDomain: string | null;

  contentSha256: string;
  topTitle: string;
  topUrl: string;
  source: string;

  route: L2Route;
  routingReason: string;
  relationshipLabel: RelationshipLabel;

  leakTypes: LeakType[];
  quantityClaimed: number | null;

  impactSeverityScore: number | null;
  impactSeverityBand: SeverityBand | null;
  evidenceConfidenceScore: number | null;
  evidenceConfidenceBand: ConfidenceBand | null;
  triagePriorityScore: number | null;
  triagePriorityBand: SeverityBand | null;

  scoreVector: ScoreVector;
  scoreReasons: ScoreReason[];

  /** Distinct CONTENT_SHA256 supporting this claim — real corroboration. */
  corroborationCount: number;
  /** Distinct DEDUPE_KEY — includes mirrors, so always >= corroborationCount. */
  sightingCount: number;
  mirrorSightingCount: number;

  actorNodeKey: string | null;
  actorName: string | null;
  actorCredibilityScore: number | null;

  groundingLevel: GroundingLevel | null;
  firstSeen: string;
  lastSeen: string;

  /** Workflow state — UI-owned, not currently persisted in the warehouse. */
  remediationStatus: RemediationStatus;
}

export type RemediationStatus =
  | "new"
  | "investigating"
  | "contained"
  | "resolved"
  | "false_positive"
  | "suppressed"
  | "context_only";

/** SQL: 14_ai_incident_insights.sql — VW_L4_INCIDENT_INSIGHTS */
export interface IncidentInsight {
  orgId: string;
  incidentKey: string;
  status: AiStatus;
  headline: string | null;
  executiveSummary: string | null;
  whatHappened: string | null;
  businessImpact: string | null;
  recommendedActions: string[];
  confidenceAssessment: string | null;
  caveats: string[];
  modelName: string | null;
  promptVersion: string | null;
  calledAt: string | null;
}

/** SQL: DT_L3_CLAIM_CORROBORATION joined to DT_L2_CLAIMS */
export interface GroundedClaim {
  claimKey: string;
  orgId: string;
  incidentKey: string;
  statement: string;
  claimStatus: ClaimStatus;
  claimStatusExtracted: ExtractedClaimStatus;
  quantityClaimed: number | null;
  evidenceText: string;
  /** Offsets into the evidence input, computed in SQL — never model-supplied. */
  evidenceStart: number | null;
  evidenceEnd: number | null;
  groundingLevel: GroundingLevel;
  selectedWindowId: string | null;
  isGrounded: boolean;
  isAccepted: boolean;
  corroborationCount: number;
}

/** SQL: DT_REGEX_INDICATORS.INDICATORS_FOUND — counts only, never values. */
export interface IndicatorSummary {
  type: string;
  count: number;
  strength: "strong" | "medium" | "weak";
}

/* ────────────────────────────────────────────────────────────────────────────
 * Knowledge graph
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * SQL: DIM_GRAPH_NODE.
 *
 * `nodeKey` is SHA2(ORG_ID ‖ type ‖ normalized_name) — deliberately org-scoped,
 * which is what guarantees tenant isolation.
 *
 * `globalNodeKey` is SHA2(type ‖ normalized_name), i.e. org-independent. It does
 * NOT exist in the pipeline yet — see docs/global-node-key.md. Until that column
 * ships this is null everywhere and cross-tenant correlation stays disabled.
 */
export interface GraphNode {
  nodeKey: string;
  globalNodeKey: string | null;
  orgId: string;
  nodeType: EntityType;
  displayName: string;
  normalizedName: string;
  isMonitoredOrg: boolean;

  mentionCount: number;
  sightingCount: number;
  docCount: number;
  mirrorSightingCount: number;

  firstSeen: string;
  lastSeen: string;

  entityMatchStatus?: EntityMatchStatus;
  entityMatchMethod?: EntityMatchMethod;
  entityMatchConfidence?: number;

  /** Fleet view only — populated when globalNodeKey resolves across tenants. */
  affectedOrgIds?: string[];
}

/** SQL: FCT_GRAPH_EDGE */
export interface GraphEdge {
  graphEdgeKey: string;
  orgId: string;
  sourceKey: string;
  targetKey: string;
  edgeType: EdgeType;
  sourceKind: "entity" | "claim";
  targetKind: "entity" | "claim";
  sourceType: EntityType | "claim";
  targetType: EntityType | "claim";

  /** The sentence that produced this edge. The whole point of the graph. */
  sampleEvidenceText: string;
  groundingLevel: GroundingLevel;
  evidenceStart: number | null;
  evidenceEnd: number | null;

  mentionCount: number;
  sightingCount: number;
  docCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  scope: DataScope;
  /** Which incident or actor this component was expanded from. */
  rootKey: string | null;
}

/** SQL: DT_L3_ACTOR_CREDIBILITY */
export interface ThreatActor {
  actorNodeKey: string;
  globalNodeKey: string | null;
  orgId: string;
  actorName: string;

  totalClaimCount: number;
  corroboratedClaimCount: number;
  disputedClaimCount: number;
  docCount: number;
  sightingCount: number;
  mirrorSightingCount: number;
  marketplaceCount: number;

  credibilityScore: number;
  firstSeen: string;
  lastSeen: string;

  contactChannels: string[];
  marketplaces: string[];

  /** Fleet view only — requires globalNodeKey. */
  affectedOrgIds?: string[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pipeline observability
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CascadeStage {
  id: string;
  /** Plain-English label shown to users. */
  label: string;
  /** Engineering token ("L0", "L1", "L2") rendered as a muted tag, or null. */
  layerTag: string | null;
  count: number;
  isBilled: boolean;
  costTier: 0 | 1 | 2 | 3;
}

export interface PipelineHealth {
  orgId: string | null;
  organizationName: string;
  lastIngestAt: string;
  groundingRate: number;
  exactGroundingRate: number;
  normalizedGroundingRate: number;
  quarantinedCount: number;
  totalExtractedCount: number;
  aiErrorCount: number;
  backlogCount: number;
  status: "healthy" | "lagging" | "degraded" | "failed";
}

export interface RejectionReason {
  reason: string;
  label: string;
  count: number;
  severity: "critical" | "high" | "medium" | "low";
}

export interface TaskHealth {
  taskName: string;
  trigger: "schedule" | "stream";
  scheduleLabel: string | null;
  state: "running" | "idle" | "queued" | "suspended" | "failed";
  lastRunAt: string | null;
  pendingCandidates: number | null;
  errorCount: number;
}

export interface VersionDrift {
  stage: string;
  baselineVersion: string | null;
  currentVersion: string;
  rowsBehind: number;
}

export interface CostBreakdown {
  stage: AiStage;
  label: string;
  queryTag: string;
  spendUsd: number;
  callCount: number;
}

export interface TenantCost {
  orgId: string;
  organizationName: string;
  pagesProcessed: number;
  deepAnalyses: number;
  spendUsd: number;
  costPerIncidentUsd: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Aggregates
 * ──────────────────────────────────────────────────────────────────────────── */

/** SQL: VW_L4_ORG_POSTURE */
export interface OrgPosture {
  orgId: string;
  canonicalName: string;
  topImpactSeverityScore: number | null;
  topImpactSeverityBand: SeverityBand | null;
  topTriagePriorityScore: number | null;
  topTriagePriorityBand: SeverityBand | null;
  incidentCount: number;
  criticalIncidents: number;
  highIncidents: number;
  distinctActors: number;
  totalSightings: number;
  totalMirrorSightings: number;
  lastActivity: string;
  /** 30-day triage-score series for the leaderboard sparkline. */
  trend: number[];
  groundingRate: number;
}

export interface FleetSummary {
  tenantCount: number;
  totalIncidents: number;
  criticalIncidents: number;
  fleetGroundingRate: number;
  crossTenantActorCount: number;
  totalActorCount: number;
  spendUsd30d: number;
  pagesProcessed30d: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Navigation
 * ──────────────────────────────────────────────────────────────────────────── */

export interface NavChild {
  label: string;
  href: string;
}

export interface NavItem {
  id: string;
  label: string;
  /** lucide-react icon name, resolved in the Sidebar. */
  icon: string;
  href?: string;
  children?: NavChild[];
  /** Renders only for SUPER_ADMIN. */
  adminOnly?: boolean;
  /** Section heading this item sits under. */
  section: NavSection;
  badgeKey?: "openCritical";
}

export type NavSection = "main" | "fleet" | "intel" | "ops";

import type {
  CostBreakdown,
  FleetSummary,
  OrgPosture,
  PipelineHealth,
  RejectionReason,
  TaskHealth,
  TenantCost,
  VersionDrift,
} from "@/types";

/** SQL: VW_L4_ORG_POSTURE, one row per tenant. */
export const orgPostures: OrgPosture[] = [
  {
    orgId: "european_commission",
    canonicalName: "European Commission",
    topImpactSeverityScore: 93,
    topImpactSeverityBand: "critical",
    topTriagePriorityScore: 92,
    topTriagePriorityBand: "critical",
    incidentCount: 31,
    criticalIncidents: 6,
    highIncidents: 9,
    distinctActors: 14,
    totalSightings: 47,
    totalMirrorSightings: 12,
    lastActivity: "2026-08-01T16:01:00Z",
    trend: [61, 63, 68, 66, 74, 79, 86, 92],
    groundingRate: 96,
  },
  {
    orgId: "odido",
    canonicalName: "Odido",
    topImpactSeverityScore: 96,
    topImpactSeverityBand: "critical",
    topTriagePriorityScore: 94,
    topTriagePriorityBand: "critical",
    incidentCount: 23,
    criticalIncidents: 4,
    highIncidents: 7,
    distinctActors: 11,
    totalSightings: 34,
    totalMirrorSightings: 8,
    lastActivity: "2026-08-01T16:03:00Z",
    trend: [82, 86, 80, 84, 82, 87, 85, 94],
    groundingRate: 94,
  },
  {
    orgId: "demo_org",
    canonicalName: "Demo Organization",
    topImpactSeverityScore: 74,
    topImpactSeverityBand: "high",
    topTriagePriorityScore: 73,
    topTriagePriorityBand: "high",
    incidentCount: 18,
    criticalIncidents: 3,
    highIncidents: 5,
    distinctActors: 9,
    totalSightings: 26,
    totalMirrorSightings: 6,
    lastActivity: "2026-08-01T15:54:00Z",
    trend: [88, 85, 86, 79, 74, 76, 70, 68],
    groundingRate: 92,
  },
];

// Aggregates recomputed from the three remaining tenants above, so the fleet
// header agrees with the rows underneath it. Grounding rate is incident
// weighted, not a flat mean.
export const fleetSummary: FleetSummary = {
  tenantCount: 3,
  totalIncidents: 72,
  criticalIncidents: 13,
  fleetGroundingRate: 94.4,
  crossTenantActorCount: 3,
  totalActorCount: 34,
  spendUsd30d: 12.05,
  pagesProcessed30d: 28369,
};

/** SQL: derived from DT_L2_* validation reasons + task/COPY history. */
export const pipelineHealthByTenant: PipelineHealth[] = [
  {
    orgId: "european_commission",
    organizationName: "European Commission",
    lastIngestAt: "2026-08-01T16:01:00Z",
    groundingRate: 96,
    exactGroundingRate: 84,
    normalizedGroundingRate: 12,
    quarantinedCount: 18,
    totalExtractedCount: 452,
    aiErrorCount: 0,
    backlogCount: 0,
    status: "healthy",
  },
  {
    orgId: "odido",
    organizationName: "Odido",
    lastIngestAt: "2026-08-01T16:03:00Z",
    groundingRate: 94.2,
    exactGroundingRate: 81.4,
    normalizedGroundingRate: 12.8,
    quarantinedCount: 79,
    totalExtractedCount: 1363,
    aiErrorCount: 2,
    backlogCount: 0,
    status: "healthy",
  },
  {
    orgId: "demo_org",
    organizationName: "Demo Organization",
    lastIngestAt: "2026-08-01T15:54:00Z",
    groundingRate: 92,
    exactGroundingRate: 78,
    normalizedGroundingRate: 14,
    quarantinedCount: 44,
    totalExtractedCount: 551,
    aiErrorCount: 0,
    backlogCount: 0,
    status: "healthy",
  },
];

/**
 * SQL: VALIDATION_REASON across DT_L2_CLAIMS / DT_L2_ENTITIES / DT_L2_EDGES.
 * This is a chart of the model trying to invent evidence and being caught.
 */
export const rejectionReasons: RejectionReason[] = [
  { reason: "unmatched_evidence", label: "Quote Not Found in Source", count: 41, severity: "critical" },
  { reason: "invalid_endpoint_combination", label: "Edge Shape Not Allowed", count: 17, severity: "high" },
  { reason: "missing_target_endpoint", label: "Edge Points at Nothing", count: 11, severity: "high" },
  { reason: "duplicate_claim_id", label: "Duplicate Claim ID", count: 6, severity: "medium" },
  { reason: "entity_cap_exceeded", label: "Over the Per-Page Entity Cap", count: 4, severity: "low" },
];

/** SQL: SHOW TASKS / TASK_HISTORY. Two scheduled, four stream-triggered. */
export const tasks: TaskHealth[] = [
  {
    taskName: "CRAWL_INGEST_TASK",
    trigger: "schedule",
    scheduleLabel: "5 min",
    state: "running",
    lastRunAt: "2026-08-01T16:05:00Z",
    pendingCandidates: null,
    errorCount: 0,
  },
  {
    taskName: "RELATIONSHIP_AI_TASK",
    trigger: "stream",
    scheduleLabel: null,
    state: "idle",
    lastRunAt: "2026-08-01T15:58:00Z",
    pendingCandidates: 0,
    errorCount: 0,
  },
  {
    taskName: "L2_EXTRACTION_AI_TASK",
    trigger: "stream",
    scheduleLabel: null,
    state: "idle",
    lastRunAt: "2026-08-01T16:01:00Z",
    pendingCandidates: 0,
    errorCount: 2,
  },
  {
    taskName: "LEAK_TYPE_AI_TASK",
    trigger: "stream",
    scheduleLabel: null,
    state: "idle",
    lastRunAt: "2026-08-01T16:02:00Z",
    pendingCandidates: 0,
    errorCount: 0,
  },
  {
    taskName: "INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK",
    trigger: "schedule",
    scheduleLabel: "5 min",
    state: "running",
    lastRunAt: "2026-08-01T16:05:00Z",
    pendingCandidates: 1,
    errorCount: 0,
  },
  {
    taskName: "INCIDENT_INSIGHT_AI_TASK",
    trigger: "stream",
    scheduleLabel: null,
    state: "queued",
    lastRunAt: "2026-08-01T15:47:00Z",
    pendingCandidates: 1,
    errorCount: 0,
  },
];

/** Version columns the pipeline already stamps on every row. */
export const versionDrift: VersionDrift[] = [
  {
    stage: "Relevance Prompt",
    baselineVersion: "ai_classify_relationship_v1",
    currentVersion: "ai_classify_relationship_v2",
    rowsBehind: 0,
  },
  {
    stage: "Extraction Prompt",
    baselineVersion: "ai_complete_extraction_v1",
    currentVersion: "ai_complete_extraction_v2",
    rowsBehind: 0,
  },
  {
    stage: "Score Method",
    baselineVersion: "impact_confidence_priority_v2",
    currentVersion: "impact_confidence_priority_v3",
    rowsBehind: 14,
  },
  {
    stage: "Input Builder",
    baselineVersion: "evidence_windows_v1",
    currentVersion: "evidence_windows_v2",
    rowsBehind: 0,
  },
  {
    stage: "Grounding Method",
    baselineVersion: "conservative_grounding_v1",
    currentVersion: "conservative_grounding_v2",
    rowsBehind: 0,
  },
  {
    stage: "Extraction Model",
    baselineVersion: null,
    currentVersion: "claude-sonnet-4-5",
    rowsBehind: 0,
  },
];

/** SQL: CORTEX_FUNCTIONS_USAGE_HISTORY grouped by QUERY_TAG. */
export const costByStage: CostBreakdown[] = [
  {
    stage: "l2_extraction",
    label: "Evidence Extraction",
    queryTag: "NOCTURNE_L2_EXTRACTION_AI",
    spendUsd: 8.4,
    callCount: 1418,
  },
  {
    stage: "relationship",
    label: "Relevance Check",
    queryTag: "NOCTURNE_RELATIONSHIP_AI",
    spendUsd: 3.95,
    callCount: 22184,
  },
  {
    stage: "leak_type",
    label: "Data Classification",
    queryTag: "NOCTURNE_LEAK_TYPE_AI",
    spendUsd: 1.2,
    callCount: 271,
  },
  {
    stage: "incident_insight",
    label: "Incident Narratives",
    queryTag: "NOCTURNE_L4_INCIDENT_INSIGHT_AI",
    spendUsd: 0.65,
    callCount: 89,
  },
];

export const costByTenant: TenantCost[] = [
  { orgId: "european_commission", organizationName: "European Commission", pagesProcessed: 11204, deepAnalyses: 462, spendUsd: 4.9, costPerIncidentUsd: 0.16 },
  { orgId: "odido", organizationName: "Odido", pagesProcessed: 9847, deepAnalyses: 418, spendUsd: 4.1, costPerIncidentUsd: 0.18 },
  { orgId: "demo_org", organizationName: "Demo Organization", pagesProcessed: 7318, deepAnalyses: 301, spendUsd: 3.05, costPerIncidentUsd: 0.17 },
];

export const cacheSavings = { callsAvoided: 21608, usdAvoided: 61 };

/** Exposure heatmap: tenant × leak type. */
export const exposureMatrix: { orgId: string; label: string; counts: Record<string, number> }[] = [
  { orgId: "european_commission", label: "European Commission", counts: { credential: 14, corporate_data: 9, pii: 11, financial: 5, malware_exploit: 2 } },
  { orgId: "odido", label: "Odido", counts: { credential: 12, corporate_data: 7, pii: 6, financial: 8, malware_exploit: 3 } },
  { orgId: "demo_org", label: "Demo Org", counts: { credential: 6, corporate_data: 2, pii: 7, financial: 9, malware_exploit: 0 } },
];

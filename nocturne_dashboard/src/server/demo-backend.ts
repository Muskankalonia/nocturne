import { actors as mockActors } from "@/mocks/actors";
import {
  pipelineHealthByTenant,
  rejectionReasons as mockRejectionReasons,
  tasks as mockTasks,
  versionDrift as mockVersionDrift,
} from "@/mocks/fleet";
import { graphForOrg } from "@/mocks/graph";
import {
  groundedClaims,
  incidents as mockIncidents,
  indicatorSummaries,
  insights as mockInsights,
} from "@/mocks/incidents";
import { groundingStats, orgCascade } from "@/mocks/pipeline";
import { extraDemoIncidents, extraDemoInsight } from "@/server/demo-fixtures";
import type { DataScope, GroundingLevel, IncidentInsight, SeverityBand } from "@/types";
import type {
  BreachMonitorRecord,
  BreachMonitorResponse,
  CommandCenterMetrics,
  CommandCenterResponse,
  DashboardIncident,
  DashboardIncidentClaim,
  DashboardIncidentGraphEdge,
  DashboardIncidentGraphNode,
  DashboardIncidentIndicatorCount,
  IncidentDetailResponse,
  KnowledgeGraphResponse,
  MonitoredOrganizationRecord,
  KnowledgeGraphView,
  PipelineResponse,
  ThreatActorsResponse,
} from "@/types/dashboard";

/**
 * A wholly synthetic tenant, used to demonstrate screens that live data cannot
 * currently fill.
 *
 * This exists because the warehouse holds real incidents for only some
 * organizations, and a walkthrough needs one account where every panel — the
 * priority queue, the graph, actor credibility, pipeline health — is populated
 * at once. Rather than seeding fake rows into Snowflake, where they would mix
 * with real evidence and skew real scores, the fabrication is confined here.
 *
 * Two invariants make that safe:
 *
 * 1. It is reachable only at org scope for DEMO_ORG_ID. Fleet scope and every
 *    other tenant go to Snowflake untouched, so no real view is ever served
 *    from this file.
 * 2. Everything it returns is stamped with DEMO_ORG_ID. The mock fixtures were
 *    authored for other tenants, so their identifiers are rewritten on the way
 *    out — otherwise a demo response could carry another organization's name.
 *
 * Delete this module and its dispatch in nocturne-backend.ts once the demo
 * tenant has real crawled data.
 */

export const DEMO_ORG_ID = "demo_org";
const DEMO_ORG_NAME = "Demo Organization";
const DEMO_DOMAIN = "demo-org.example";

/** True only for a single-organization request against the demo tenant. */
export function isDemoScope(scope: DataScope): boolean {
  return scope.kind === "org" && scope.orgId === DEMO_ORG_ID;
}

const now = () => new Date().toISOString();
const demoScope: DataScope = { kind: "org", orgId: DEMO_ORG_ID };

/**
 * Rewrites a fixture's tenant identity so nothing leaks another org's name.
 *
 * This sweeps the whole response rather than selected fields. Field-by-field
 * rewriting was the first attempt and it missed `insight.orgId` nested inside
 * each incident, plus every narrative sentence naming the real tenant and its
 * domain. A demo tenant quoting another organization's breach text is both
 * confusing and exactly the cross-tenant bleed the rest of this codebase works
 * to prevent, so the sweep is exhaustive by construction.
 *
 * Node and edge keys go through the same substitution, so endpoints that
 * referenced `...-odido` still line up with the nodes they point at.
 */
const TENANT_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/odido\.nl/gi, DEMO_DOMAIN],
  [/ben\.nl/gi, DEMO_DOMAIN],
  [/paloaltonetworks\.com/gi, DEMO_DOMAIN],
  [/T-Mobile Netherlands/gi, DEMO_ORG_NAME],
  [/Odido/gi, DEMO_ORG_NAME],
  [/\bODIDO\b/g, DEMO_ORG_NAME],
];

function scrubText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of TENANT_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Deep-rewrites tenant identity across an entire response object. */
function demoize<T>(value: T): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (Array.isArray(value)) return value.map(demoize) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "orgId") out[key] = DEMO_ORG_ID;
      else if (key === "organizationName" || key === "canonicalName") out[key] = DEMO_ORG_NAME;
      else if (key === "organizationDomain") out[key] = DEMO_DOMAIN;
      else out[key] = demoize(entry);
    }
    return out as T;
  }
  return value;
}

function reOrg<T extends { orgId: string; organizationName?: string }>(row: T): T {
  return demoize(row);
}

const FALLBACK_INSIGHT: IncidentInsight = {
  ...(mockInsights[0] as IncidentInsight),
};

function insightFor(incidentKey: string): IncidentInsight {
  return mockInsights.find((i) => i.incidentKey === incidentKey) ?? FALLBACK_INSIGHT;
}

/** The demo tenant's incidents, with insights attached as the live API does. */
function demoIncidents(): DashboardIncident[] {
  const handWritten = mockIncidents.map((incident) => ({
    ...reOrg(incident),
    organizationDomain: DEMO_DOMAIN,
    insight: insightFor(incident.incidentKey),
  }));
  const generated = extraDemoIncidents(DEMO_ORG_ID, DEMO_ORG_NAME, DEMO_DOMAIN).map(
    (incident) => ({
      ...incident,
      insight: extraDemoInsight(incident, DEMO_ORG_NAME),
    }),
  );
  // Highest triage first, matching the live priority queue's ordering.
  return [...handWritten, ...generated].sort(
    (a, b) => (b.triagePriorityScore ?? -1) - (a.triagePriorityScore ?? -1),
  );
}

function bandCounts(incidents: DashboardIncident[]) {
  const counts: Record<SeverityBand, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
  for (const incident of incidents) {
    if (incident.impactSeverityBand) counts[incident.impactSeverityBand] += 1;
  }
  return counts;
}

function stage(id: string): number {
  return orgCascade.find((s) => s.id === id)?.count ?? 0;
}

function grounding() {
  const g = groundingStats.org;
  return {
    rate: g.rate,
    exactCount: g.exact,
    normalizedCount: g.normalized,
    verifiedCount: g.verified,
    quarantinedCount: g.quarantined,
    totalExtractedClaims: g.verified + g.quarantined,
  };
}

function metrics(incidents: DashboardIncident[]): CommandCenterMetrics {
  const scored = incidents
    .map((i) => i.impactSeverityScore)
    .filter((s): s is number => s !== null);
  const top = scored.length ? Math.max(...scored) : null;
  const topIncident = incidents.find((i) => i.impactSeverityScore === top);

  return {
    topImpactSeverityScore: top,
    topImpactSeverityBand: topIncident?.impactSeverityBand ?? null,
    openIncidentCount: incidents.length,
    incidentsByBand: bandCounts(incidents),
    distinctThreatActorCount: new Set(
      incidents.map((i) => i.actorNodeKey).filter(Boolean),
    ).size,
    grounding: grounding(),
    pipeline: {
      pagesCollected: stage("collected"),
      pagesScreened: stage("screened"),
      uniquePages: stage("deduped"),
      pagesRelevanceChecked: stage("relevance"),
      pagesSelectedForL2: stage("selected"),
      pagesEvidenceExtracted: stage("extracted"),
      pagesOwnershipVerified: stage("verified"),
      pagesDataTypesClassified: stage("classified"),
      incidentsRaised: incidents.length,
    },
    downstreamAiErrorCount: 0,
  };
}

export function getDemoCommandCenter(): CommandCenterResponse {
  const incidents = demoIncidents();
  const totals = metrics(incidents);
  return demoize({
    scope: demoScope,
    organizations: [
      {
        orgId: DEMO_ORG_ID,
        organizationName: DEMO_ORG_NAME,
        enabled: true,
        metrics: totals,
        lastUpdatedAt: now(),
      },
    ],
    totals,
    cascade: orgCascade,
    incidents,
    lastUpdatedAt: now(),
    fetchedAt: now(),
  });
}

/** Maps an incident onto the audit-oriented Breach Monitor row shape. */
function monitorRow(incident: DashboardIncident): BreachMonitorRecord {
  const confirmed = incident.route === "target_confirmed";
  return {
    monitorKey: `${DEMO_ORG_ID}:${incident.incidentKey}`,
    incidentKey: confirmed ? incident.incidentKey : null,
    orgId: DEMO_ORG_ID,
    organizationName: DEMO_ORG_NAME,
    organizationDomain: DEMO_DOMAIN,
    docId: confirmed ? null : `doc-${incident.contentSha256.slice(0, 12)}`,
    dedupeKey: confirmed ? null : `dedupe-${incident.contentSha256.slice(0, 12)}`,
    contentSha256: incident.contentSha256,
    title: incident.topTitle,
    url: incident.topUrl,
    source: incident.source,
    discoveredAt: incident.firstSeen,
    monitorStatus: confirmed
      ? "confirmed_yours"
      : incident.relationshipLabel === "other_organization_leak"
        ? "another_company"
        : "needs_review",
    pipelineState: confirmed ? "incident_ready" : "stopped_after_l2",
    relationshipAiStatus: "success",
    relationshipLabel: incident.relationshipLabel,
    l2Route: incident.route,
    routingReason: incident.routingReason,
    leakTypes: incident.leakTypes,
    quantityClaimed: incident.quantityClaimed,
    impactSeverityScore: incident.impactSeverityScore,
    impactSeverityBand: incident.impactSeverityBand,
    evidenceConfidenceScore: incident.evidenceConfidenceScore,
    evidenceConfidenceBand: incident.evidenceConfidenceBand,
    triagePriorityScore: incident.triagePriorityScore,
    triagePriorityBand: incident.triagePriorityBand,
    actorNodeKey: incident.actorNodeKey,
    actorName: incident.actorName,
    actorCredibilityScore: incident.actorCredibilityScore,
    groundingLevel: incident.groundingLevel,
    remediationStatus: incident.remediationStatus,
    mitigatedAt: incident.remediationStatus === "mitigated" ? incident.lastSeen : null,
    mitigatedBy: incident.remediationStatus === "mitigated" ? "demo" : null,
    // The demo tenant has no review decisions, so the effective status is
    // always the cascade's own and the two agree by construction.
    pipelineMonitorStatus: confirmed
      ? "confirmed_yours"
      : incident.relationshipLabel === "other_organization_leak"
        ? "another_company"
        : "needs_review",
    reviewDecision: null,
    reviewDecidedBy: null,
    reviewDecidedAt: null,
    screenshotStatus: null,
    screenshotCapturedAt: null,
    detailAvailable: confirmed,
  };
}

export function getDemoBreachMonitor(): BreachMonitorResponse {
  const rows = demoIncidents().map(monitorRow);
  const confirmed = rows.filter((r) => r.monitorStatus === "confirmed_yours");
  return demoize({
    scope: demoScope,
    summary: {
      totalRows: rows.length,
      confirmedLeaks: confirmed.length,
      recordsClaimed: confirmed.reduce((sum, r) => sum + (r.quantityClaimed ?? 0), 0),
      exposedDataClassCount: new Set(confirmed.flatMap((r) => r.leakTypes)).size,
      needsReview: rows.filter((r) => r.monitorStatus === "needs_review").length,
      anotherCompany: rows.filter((r) => r.monitorStatus === "another_company").length,
      mitigated: rows.filter((r) => r.remediationStatus === "mitigated").length,
      dismissed: rows.filter((r) => r.monitorStatus === "dismissed").length,
    },
    rows,
    totalCount: rows.length,
    lastUpdatedAt: now(),
    fetchedAt: now(),
  });
}

export function getDemoThreatActors(): ThreatActorsResponse {
  const actors = mockActors.map(reOrg);
  return demoize({
    scope: demoScope,
    summary: {
      actorCount: actors.length,
      corroboratedClaimCount: actors.reduce((s, a) => s + (a.corroboratedClaimCount ?? 0), 0),
      marketplaceCount: new Set(actors.flatMap((a) => a.marketplaces ?? [])).size,
      highestCredibilityScore: actors.length
        ? Math.max(...actors.map((a) => a.credibilityScore ?? 0))
        : 0,
    },
    actors,
    lastUpdatedAt: now(),
    fetchedAt: now(),
  });
}

export function getDemoKnowledgeGraph(
  view: KnowledgeGraphView,
  incidentKey?: string,
): KnowledgeGraphResponse {
  const graph = graphForOrg(DEMO_ORG_ID);
  const incidents = demoIncidents();
  const root =
    incidents.find((i) => i.incidentKey === incidentKey)
    ?? incidents.find((i) => i.route === "target_confirmed")
    ?? incidents[0];

  return demoize({
    ...graph,
    scope: demoScope,
    rootKey: root?.incidentKey ?? null,
    view,
    rootIncident: root
      ? {
          incidentKey: root.incidentKey,
          title: root.topTitle,
          url: root.topUrl,
          actorName: root.actorName,
          impactSeverityScore: root.impactSeverityScore,
          impactSeverityBand: root.impactSeverityBand,
          firstSeen: root.firstSeen,
        }
      : null,
    incidentCount: incidents.filter((i) => i.route === "target_confirmed").length,
    fetchedAt: now(),
  });
}

export function getDemoIncidentDetail(incidentKey: string): IncidentDetailResponse | null {
  const incident = demoIncidents().find((i) => i.incidentKey === incidentKey);
  if (!incident) return null;

  const docId = `doc-${incident.contentSha256.slice(0, 12)}`;
  const dedupeKey = `dedupe-${incident.contentSha256.slice(0, 12)}`;

  const claims: DashboardIncidentClaim[] = groundedClaims
    .filter((c) => c.isAccepted && c.groundingLevel !== "unmatched")
    .map((c) => ({
      orgId: DEMO_ORG_ID,
      incidentKey,
      docId,
      dedupeKey,
      contentSha256: incident.contentSha256,
      claimKey: c.claimKey,
      statement: c.statement,
      statementTruncated: false,
      claimStatus: c.claimStatus,
      claimStatusExtracted: c.claimStatusExtracted,
      quantityClaimed: c.quantityClaimed,
      groundingLevel: c.groundingLevel as Exclude<GroundingLevel, "unmatched">,
      maskedEvidenceText: c.evidenceText,
      evidenceTextTruncated: false,
      evidenceStart: c.evidenceStart,
      evidenceEnd: c.evidenceEnd,
      selectedWindowId: c.selectedWindowId,
      subjectNodeKey: `entity-${DEMO_ORG_ID}`,
      subjectName: DEMO_ORG_NAME,
      corroborationCount: c.corroborationCount,
      sightingCount: incident.sightingCount,
      mirrorSightingCount: incident.mirrorSightingCount,
      uniqueClaimCount: 1,
      disputeCount: 0,
      graphScope: "target_incident",
    }));

  const indicatorCounts: DashboardIncidentIndicatorCount[] = (
    indicatorSummaries[incidentKey] ?? []
  ).map((s) => ({
    orgId: DEMO_ORG_ID,
    incidentKey,
    docId,
    dedupeKey,
    indicatorType: s.type,
    indicatorCount: s.count,
    strongIndicatorCount: s.strength === "strong" ? s.count : 0,
    mediumIndicatorCount: s.strength === "medium" ? s.count : 0,
    weakIndicatorCount: s.strength === "weak" ? s.count : 0,
    indicatorEvidenceScore: s.strength === "strong" ? 90 : s.strength === "medium" ? 60 : 30,
  }));

  const graph = graphForOrg(DEMO_ORG_ID);
  const nodes: DashboardIncidentGraphNode[] = graph.nodes.map((n) => ({
    orgId: DEMO_ORG_ID,
    incidentKey,
    nodeKey: n.nodeKey,
    nodeType: n.nodeType,
    normalizedName: n.normalizedName,
    displayName: n.displayName,
    isMonitoredOrg: n.isMonitoredOrg,
    mentionCount: n.mentionCount,
    sightingCount: n.sightingCount,
    docCount: n.docCount,
    mirrorSightingCount: n.mirrorSightingCount,
    firstSeen: n.firstSeen,
    lastSeen: n.lastSeen,
    graphScope: "target_incident",
  }));
  const edges: DashboardIncidentGraphEdge[] = graph.edges.map((e) => ({
    orgId: DEMO_ORG_ID,
    incidentKey,
    graphEdgeKey: e.graphEdgeKey,
    sourceKey: e.sourceKey,
    edgeType: e.edgeType,
    targetKey: e.targetKey,
    sourceKind: e.sourceKind,
    sourceType: e.sourceType,
    targetKind: e.targetKind,
    targetType: e.targetType,
    mentionCount: e.mentionCount,
    sightingCount: e.sightingCount,
    docCount: e.docCount,
    mirrorSightingCount: Math.max(0, e.sightingCount - e.docCount),
    firstSeen: e.firstSeen,
    lastSeen: e.lastSeen,
    graphScope: "target_incident",
  }));

  return demoize({
    scope: demoScope,
    incident,
    claims,
    indicatorCounts,
    graph: { nodes, edges },
    fetchedAt: now(),
  });
}

export function getDemoPipeline(): PipelineResponse {
  const health = pipelineHealthByTenant[0];
  const g = grounding();
  const extracted = stage("extracted");
  const relevance = stage("relevance");

  return demoize({
    scope: demoScope,
    organizations: [
      { orgId: DEMO_ORG_ID, organizationName: DEMO_ORG_NAME, lastUpdatedAt: now() },
    ],
    cascade: orgCascade,
    grounding: g,
    deepAnalysisRate: relevance ? Number(((extracted / relevance) * 100).toFixed(1)) : 0,
    cacheSummary: {
      cacheRows: 3196,
      successRows: 3194,
      errorRows: 2,
      missingCandidates: 0,
      repeatCallsAvoided: 2871,
    },
    cacheStages: [
      { stage: "relationship", cacheRows: 3196, successRows: 3196, errorRows: 0, missingCandidates: 0, lastCalledAt: now() },
      { stage: "l2_extraction", cacheRows: 214, successRows: 212, errorRows: 2, missingCandidates: 0, lastCalledAt: now() },
      { stage: "leak_type", cacheRows: 37, successRows: 37, errorRows: 0, missingCandidates: 0, lastCalledAt: now() },
      { stage: "incident_insight", cacheRows: 23, successRows: 23, errorRows: 0, missingCandidates: 0, lastCalledAt: now() },
    ],
    rejectionReasons: mockRejectionReasons,
    versionDrift: mockVersionDrift,
    health: [
      {
        orgId: DEMO_ORG_ID,
        organizationName: DEMO_ORG_NAME,
        lastIngestAt: health?.lastIngestAt ?? now(),
        groundingRate: g.rate,
        quarantinedCount: g.quarantinedCount,
        totalExtractedCount: g.totalExtractedClaims,
        aiErrorCount: 2,
        backlogCount: 0,
        status: "healthy",
      },
    ],
    tasks: mockTasks,
    // Demo-only. Live tenants leave this absent and the panel does not render.
    accuracy: {
      goldSetSize: 42,
      precision: 0.93,
      recall: 0.88,
      f1: 0.9,
      falsePositiveRate: 0.07,
      calibrationError: 0.04,
      lastEvaluatedAt: "2026-08-04T09:00:00Z",
      basis: "42 hand-reviewed pages labelled by two analysts; disagreements resolved by a third.",
    },
    lastUpdatedAt: now(),
    fetchedAt: now(),
  });
}

/**
 * Configuration row for the demo tenant.
 *
 * Settings reads MONITORED_ORGANIZATIONS directly, and the demo tenant has no
 * row there — which rendered "This organization is not configured for
 * monitoring". Synthesizing it here keeps the Monitored Assets screen
 * demonstrable without inserting a tenant into the warehouse that the pipeline
 * would then try to crawl.
 */
export function getDemoMonitoredOrganization(): MonitoredOrganizationRecord {
  return {
    orgId: DEMO_ORG_ID,
    canonicalName: DEMO_ORG_NAME,
    aliases: ["Demo", "Demo Org"],
    domains: [DEMO_DOMAIN, "demo-org.test"],
    products: ["Demo Portal", "Demo Mobile App"],
    enabled: true,
    createdAt: "2026-08-02T09:00:00Z",
    updatedAt: "2026-08-05T09:14:00Z",
  };
}

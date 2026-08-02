import snowflake, {
  type Binds,
  type Connection,
  type ConnectionOptions,
} from "snowflake-sdk";

import type {
  AiStatus,
  ClaimStatus,
  ConfidenceBand,
  DataScope,
  EdgeType,
  EntityType,
  ExtractedClaimStatus,
  GroundingLevel,
  L2Route,
  LeakType,
  RelationshipLabel,
  RemediationStatus,
  ScoreReason,
  SeverityBand,
} from "@/types";
import type {
  BreachMonitorPipelineState,
  BreachMonitorRecord,
  BreachMonitorResponse,
  BreachMonitorStatus,
  CommandCenterMetrics,
  CommandCenterOrganizationSnapshot,
  CommandCenterResponse,
  DashboardIncident,
  DashboardIncidentClaim,
  DashboardIncidentGraphEdge,
  DashboardIncidentGraphNode,
  DashboardIncidentIndicatorCount,
  DashboardPipelineCounts,
  IncidentDetailResponse,
} from "@/types/dashboard";

if (typeof window !== "undefined") {
  throw new Error("The Nocturne Snowflake backend may only run on the server.");
}

type SnowflakeRow = Record<string, unknown>;

interface BackendConfig {
  account: string;
  username: string;
  token: string | null;
  password: string | null;
  warehouse: string;
  role: string;
  database: string;
  schema: string;
  queryTag: string;
  queryTimeoutSeconds: number;
}

export interface NocturneBackend {
  getCommandCenter(scope: DataScope): Promise<CommandCenterResponse>;
  getBreachMonitor(
    scope: DataScope,
    access?: BreachMonitorAccess,
  ): Promise<BreachMonitorResponse>;
  getIncidentDetail(
    scope: DataScope,
    incidentKey: string,
  ): Promise<IncidentDetailResponse | null>;
}

export interface BreachMonitorAccess {
  /** External-company context is privileged and denied by default. */
  includeExternalContext?: boolean;
}

const SUMMARY_COLUMNS = `
  ORG_ID,
  ORGANIZATION_NAME,
  ENABLED,
  PAGES_COLLECTED,
  PAGES_SCREENED,
  UNIQUE_PAGES,
  PAGES_RELEVANCE_CHECKED,
  PAGES_SELECTED_FOR_L2,
  PAGES_EVIDENCE_EXTRACTED,
  PAGES_OWNERSHIP_VERIFIED,
  PAGES_DATA_TYPES_CLASSIFIED,
  INCIDENTS_RAISED,
  TOP_IMPACT_SEVERITY_SCORE,
  TOP_IMPACT_SEVERITY_BAND,
  CRITICAL_INCIDENTS,
  HIGH_INCIDENTS,
  MEDIUM_INCIDENTS,
  LOW_INCIDENTS,
  INFORMATIONAL_INCIDENTS,
  DISTINCT_THREAT_ACTORS,
  EXACT_GROUNDED_COUNT,
  NORMALIZED_GROUNDED_COUNT,
  QUARANTINED_COUNT,
  TOTAL_EXTRACTED_CLAIMS,
  EVIDENCE_GROUNDING_RATE,
  DOWNSTREAM_AI_ERROR_COUNT,
  TO_VARCHAR(
    LAST_UPDATED_AT,
    'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'
  ) AS LAST_UPDATED_AT
`;

const INCIDENT_COLUMNS = `
  ORG_ID,
  ORGANIZATION_NAME,
  ORGANIZATION_DOMAIN,
  INCIDENT_KEY,
  CONTENT_SHA256,
  TOP_TITLE,
  TOP_URL,
  SOURCE,
  L2_ROUTE,
  ROUTING_REASON,
  RELATIONSHIP_LABEL,
  LEAK_TYPE_LABELS,
  QUANTITY_CLAIMED,
  IMPACT_SEVERITY_SCORE,
  IMPACT_SEVERITY_BAND,
  EVIDENCE_CONFIDENCE_SCORE,
  EVIDENCE_CONFIDENCE_BAND,
  TRIAGE_PRIORITY_SCORE,
  TRIAGE_PRIORITY_BAND,
  SCORE_VECTOR,
  SCORE_REASONS,
  CORROBORATION_COUNT,
  SIGHTING_COUNT,
  MIRROR_SIGHTING_COUNT,
  ACTOR_NODE_KEY,
  ACTOR_NAME,
  ACTOR_CREDIBILITY_SCORE,
  GROUNDING_LEVEL,
  TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS FIRST_SEEN,
  TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS LAST_SEEN,
  INSIGHT_AI_STATUS,
  INSIGHT_HEADLINE,
  EXECUTIVE_SUMMARY,
  WHAT_HAPPENED,
  BUSINESS_IMPACT,
  RECOMMENDED_ACTIONS,
  CONFIDENCE_ASSESSMENT,
  INSIGHT_CAVEATS,
  INSIGHT_PROMPT_VERSION,
  INSIGHT_MODEL_NAME,
  TO_VARCHAR(
    INSIGHT_CALLED_AT,
    'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'
  ) AS INSIGHT_CALLED_AT,
  REMEDIATION_STATUS
`;

const BREACH_MONITOR_COLUMNS = `
  ORG_ID,
  ORGANIZATION_NAME,
  ORGANIZATION_DOMAIN,
  MONITOR_KEY,
  INCIDENT_KEY,
  DOC_ID,
  DEDUPE_KEY,
  CONTENT_SHA256,
  TITLE,
  URL,
  SOURCE,
  TO_VARCHAR(
    DISCOVERED_AT,
    'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'
  ) AS DISCOVERED_AT,
  MONITOR_STATUS,
  PIPELINE_STATE,
  RELATIONSHIP_AI_STATUS,
  RELATIONSHIP_LABEL,
  L2_ROUTE,
  ROUTING_REASON,
  LEAK_TYPE_LABELS,
  QUANTITY_CLAIMED,
  IMPACT_SEVERITY_SCORE,
  IMPACT_SEVERITY_BAND,
  EVIDENCE_CONFIDENCE_SCORE,
  EVIDENCE_CONFIDENCE_BAND,
  TRIAGE_PRIORITY_SCORE,
  TRIAGE_PRIORITY_BAND,
  ACTOR_NODE_KEY,
  ACTOR_NAME,
  ACTOR_CREDIBILITY_SCORE,
  GROUNDING_LEVEL,
  REMEDIATION_STATUS,
  DETAIL_AVAILABLE
`;

const INCIDENT_CLAIM_COLUMNS = `
  ORG_ID,
  INCIDENT_KEY,
  DOC_ID,
  DEDUPE_KEY,
  CONTENT_SHA256,
  CLAIM_KEY,
  CLAIM_STATEMENT,
  CLAIM_STATEMENT_TRUNCATED,
  CLAIM_STATUS,
  CLAIM_STATUS_EXTRACTED,
  QUANTITY_CLAIMED,
  GROUNDING_LEVEL,
  MASKED_EVIDENCE_TEXT,
  EVIDENCE_TEXT_TRUNCATED,
  EVIDENCE_START,
  EVIDENCE_END,
  SELECTED_WINDOW_ID,
  SUBJECT_NODE_KEY,
  SUBJECT_NAME,
  CORROBORATION_COUNT,
  SIGHTING_COUNT,
  MIRROR_SIGHTING_COUNT,
  UNIQUE_CLAIM_COUNT,
  DISPUTE_COUNT,
  GRAPH_SCOPE
`;

const INCIDENT_INDICATOR_COLUMNS = `
  ORG_ID,
  INCIDENT_KEY,
  DOC_ID,
  DEDUPE_KEY,
  INDICATOR_TYPE,
  INDICATOR_COUNT,
  STRONG_INDICATOR_COUNT,
  MEDIUM_INDICATOR_COUNT,
  WEAK_INDICATOR_COUNT,
  INDICATOR_EVIDENCE_SCORE
`;

const INCIDENT_GRAPH_NODE_COLUMNS = `
  ORG_ID,
  INCIDENT_KEY,
  NODE_KEY,
  NODE_TYPE,
  NORMALIZED_NAME,
  DISPLAY_NAME,
  IS_MONITORED_ORG,
  MENTION_COUNT,
  SIGHTING_COUNT,
  DOC_COUNT,
  MIRROR_SIGHTING_COUNT,
  TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS FIRST_SEEN,
  TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS LAST_SEEN,
  GRAPH_SCOPE
`;

const INCIDENT_GRAPH_EDGE_COLUMNS = `
  ORG_ID,
  INCIDENT_KEY,
  GRAPH_EDGE_KEY,
  SOURCE_KEY,
  EDGE_TYPE,
  TARGET_KEY,
  SOURCE_KIND,
  SOURCE_TYPE,
  TARGET_KIND,
  TARGET_TYPE,
  MENTION_COUNT,
  SIGHTING_COUNT,
  DOC_COUNT,
  MIRROR_SIGHTING_COUNT,
  TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS FIRST_SEEN,
  TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS LAST_SEEN,
  GRAPH_SCOPE
`;

let connectionPromise: Promise<Connection> | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing server environment variable: ${name}`);
  return value;
}

function loadConfig(): BackendConfig {
  const dataSource = process.env.NOCTURNE_DATA_SOURCE?.trim() ?? "live";
  if (dataSource !== "live") {
    throw new Error(
      `NOCTURNE_DATA_SOURCE must be "live" for the Snowflake backend; received "${dataSource}".`,
    );
  }

  const token = process.env.SNOWFLAKE_TOKEN?.trim() || null;
  const password = process.env.SNOWFLAKE_PASSWORD?.trim() || null;
  if (!token && !password) {
    throw new Error("Set SNOWFLAKE_TOKEN or SNOWFLAKE_PASSWORD on the server.");
  }

  const queryTimeoutSeconds = Number.parseInt(
    process.env.SNOWFLAKE_QUERY_TIMEOUT_SECONDS ?? "30",
    10,
  );
  if (!Number.isInteger(queryTimeoutSeconds) || queryTimeoutSeconds < 1) {
    throw new Error("SNOWFLAKE_QUERY_TIMEOUT_SECONDS must be a positive integer.");
  }

  return {
    account: requiredEnv("SNOWFLAKE_ACCOUNT"),
    username: requiredEnv("SNOWFLAKE_USER"),
    token,
    password,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE?.trim() || "COMPUTE_WH",
    role: process.env.SNOWFLAKE_ROLE?.trim() || "ACCOUNTADMIN",
    database: process.env.SNOWFLAKE_DATABASE?.trim() || "NOCTURNE",
    schema: process.env.SNOWFLAKE_SCHEMA?.trim() || "DASHBOARD",
    queryTag:
      process.env.SNOWFLAKE_QUERY_TAG?.trim() || "NOCTURNE_DASHBOARD_READ",
    queryTimeoutSeconds,
  };
}

async function createConnection(): Promise<Connection> {
  const config = loadConfig();
  const options: ConnectionOptions = {
    account: config.account,
    username: config.username,
    warehouse: config.warehouse,
    role: config.role,
    database: config.database,
    schema: config.schema,
    application: "NOCTURNE_DASHBOARD",
    queryTag: config.queryTag,
    timeout: config.queryTimeoutSeconds * 1_000,
    clientSessionKeepAlive: false,
    fetchAsString: ["Number", "Date"],
    ...(config.token
      ? {
          authenticator: "PROGRAMMATIC_ACCESS_TOKEN",
          token: config.token,
        }
      : { password: config.password! }),
  };

  const connection = snowflake.createConnection(options);
  await connection.connectAsync();
  return connection;
}

async function getConnection(): Promise<Connection> {
  if (connectionPromise) {
    try {
      const existing = await connectionPromise;
      if (existing.isUp() && (await existing.isValidAsync())) return existing;
    } catch {
      // Recreate the connection below. Never include credential-bearing config
      // in the surfaced error or logs.
    }
    connectionPromise = null;
  }

  connectionPromise = createConnection().catch((error: unknown) => {
    connectionPromise = null;
    throw error;
  });
  return connectionPromise;
}

async function executeQuery(
  sqlText: string,
  binds: Binds = [],
): Promise<SnowflakeRow[]> {
  const config = loadConfig();
  const connection = await getConnection();

  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText,
      binds,
      fetchAsString: ["Number", "Date"],
      parameters: {
        STATEMENT_TIMEOUT_IN_SECONDS: config.queryTimeoutSeconds,
        STRICT_JSON_OUTPUT: true,
      },
      complete: (error, statement, rows) => {
        if (error) {
          reject(
            new Error(
              `Snowflake dashboard query failed (query ${statement?.getQueryId?.() ?? "unavailable"}): ${error.message}`,
            ),
          );
          return;
        }
        resolve((rows ?? []) as SnowflakeRow[]);
      },
    });
  });
}

function scopeFilter(scope: DataScope): { clause: string; binds: Binds } {
  return scope.kind === "org"
    ? { clause: " WHERE ORG_ID = ?", binds: [scope.orgId] }
    : { clause: "", binds: [] };
}

function breachMonitorFilter(
  scope: DataScope,
  includeExternalContext: boolean,
): { clause: string; binds: Binds } {
  const filter = scopeFilter(scope);
  if (includeExternalContext) return filter;
  return {
    clause: `${filter.clause || " WHERE 1 = 1"}
      AND MONITOR_STATUS <> 'another_company'`,
    binds: filter.binds,
  };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return nullableString(value) ?? fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric dashboard value: ${value}`);
  return parsed;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  // With fetchAsString enabled, nullable NUMBER expressions from UNION-backed
  // Snowflake views can be returned by the Node SDK as the literal "NULL".
  if (typeof value === "string" && value.trim().toUpperCase() === "NULL") {
    return null;
  }
  return numberValue(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return Boolean(value);
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

function mapPipeline(row: SnowflakeRow): DashboardPipelineCounts {
  return {
    pagesCollected: numberValue(row.PAGES_COLLECTED),
    pagesScreened: numberValue(row.PAGES_SCREENED),
    uniquePages: numberValue(row.UNIQUE_PAGES),
    pagesRelevanceChecked: numberValue(row.PAGES_RELEVANCE_CHECKED),
    pagesSelectedForL2: numberValue(row.PAGES_SELECTED_FOR_L2),
    pagesEvidenceExtracted: numberValue(row.PAGES_EVIDENCE_EXTRACTED),
    pagesOwnershipVerified: numberValue(row.PAGES_OWNERSHIP_VERIFIED),
    pagesDataTypesClassified: numberValue(row.PAGES_DATA_TYPES_CLASSIFIED),
    incidentsRaised: numberValue(row.INCIDENTS_RAISED),
  };
}

function mapOrganization(row: SnowflakeRow): CommandCenterOrganizationSnapshot {
  const exactCount = numberValue(row.EXACT_GROUNDED_COUNT);
  const normalizedCount = numberValue(row.NORMALIZED_GROUNDED_COUNT);
  const pipeline = mapPipeline(row);

  return {
    orgId: stringValue(row.ORG_ID),
    organizationName: stringValue(row.ORGANIZATION_NAME),
    enabled: booleanValue(row.ENABLED),
    metrics: {
      topImpactSeverityScore: nullableNumber(row.TOP_IMPACT_SEVERITY_SCORE),
      topImpactSeverityBand: nullableString(
        row.TOP_IMPACT_SEVERITY_BAND,
      ) as SeverityBand | null,
      openIncidentCount: pipeline.incidentsRaised,
      incidentsByBand: {
        critical: numberValue(row.CRITICAL_INCIDENTS),
        high: numberValue(row.HIGH_INCIDENTS),
        medium: numberValue(row.MEDIUM_INCIDENTS),
        low: numberValue(row.LOW_INCIDENTS),
        informational: numberValue(row.INFORMATIONAL_INCIDENTS),
      },
      distinctThreatActorCount: numberValue(row.DISTINCT_THREAT_ACTORS),
      grounding: {
        rate: numberValue(row.EVIDENCE_GROUNDING_RATE),
        exactCount,
        normalizedCount,
        verifiedCount: exactCount + normalizedCount,
        quarantinedCount: numberValue(row.QUARANTINED_COUNT),
        totalExtractedClaims: numberValue(row.TOTAL_EXTRACTED_CLAIMS),
      },
      pipeline,
      downstreamAiErrorCount: numberValue(row.DOWNSTREAM_AI_ERROR_COUNT),
    },
    lastUpdatedAt: nullableString(row.LAST_UPDATED_AT),
  };
}

function scoreVector(value: unknown): DashboardIncident["scoreVector"] {
  const parsed = jsonValue(value);
  const vector =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  return {
    dataSensitivity: nullableNumber(vector.data_sensitivity),
    exposureActionability: nullableNumber(vector.exposure_actionability),
    recordScale: nullableNumber(vector.record_scale),
    ownershipEvidence: nullableNumber(vector.ownership_evidence),
    grounding: nullableNumber(vector.grounding),
    claimProof: nullableNumber(vector.claim_proof),
    corroboration: nullableNumber(vector.corroboration),
    actorCredibility: nullableNumber(vector.actor_credibility),
    impactSeverity: nullableNumber(vector.impact_severity),
    evidenceConfidence: nullableNumber(vector.evidence_confidence),
    triagePriority: nullableNumber(vector.triage_priority),
  };
}

function mapIncident(row: SnowflakeRow): DashboardIncident {
  const orgId = stringValue(row.ORG_ID);
  const incidentKey = stringValue(row.INCIDENT_KEY);
  return {
    incidentKey,
    orgId,
    organizationName: stringValue(row.ORGANIZATION_NAME),
    organizationDomain: nullableString(row.ORGANIZATION_DOMAIN),
    contentSha256: stringValue(row.CONTENT_SHA256),
    topTitle: stringValue(row.TOP_TITLE),
    topUrl: stringValue(row.TOP_URL),
    source: stringValue(row.SOURCE, "unknown"),
    route: stringValue(row.L2_ROUTE) as L2Route,
    routingReason: stringValue(row.ROUTING_REASON),
    relationshipLabel: stringValue(row.RELATIONSHIP_LABEL) as RelationshipLabel,
    leakTypes: stringArray(row.LEAK_TYPE_LABELS) as LeakType[],
    quantityClaimed: nullableNumber(row.QUANTITY_CLAIMED),
    impactSeverityScore: nullableNumber(row.IMPACT_SEVERITY_SCORE),
    impactSeverityBand: nullableString(row.IMPACT_SEVERITY_BAND) as SeverityBand | null,
    evidenceConfidenceScore: nullableNumber(row.EVIDENCE_CONFIDENCE_SCORE),
    evidenceConfidenceBand: nullableString(
      row.EVIDENCE_CONFIDENCE_BAND,
    ) as ConfidenceBand | null,
    triagePriorityScore: nullableNumber(row.TRIAGE_PRIORITY_SCORE),
    triagePriorityBand: nullableString(row.TRIAGE_PRIORITY_BAND) as SeverityBand | null,
    scoreVector: scoreVector(row.SCORE_VECTOR),
    scoreReasons: stringArray(row.SCORE_REASONS) as ScoreReason[],
    corroborationCount: numberValue(row.CORROBORATION_COUNT),
    sightingCount: numberValue(row.SIGHTING_COUNT),
    mirrorSightingCount: numberValue(row.MIRROR_SIGHTING_COUNT),
    actorNodeKey: nullableString(row.ACTOR_NODE_KEY),
    actorName: nullableString(row.ACTOR_NAME),
    actorCredibilityScore: nullableNumber(row.ACTOR_CREDIBILITY_SCORE),
    groundingLevel: nullableString(row.GROUNDING_LEVEL) as GroundingLevel | null,
    firstSeen: stringValue(row.FIRST_SEEN),
    lastSeen: stringValue(row.LAST_SEEN),
    remediationStatus: stringValue(row.REMEDIATION_STATUS, "new") as RemediationStatus,
    insight: {
      orgId,
      incidentKey,
      status: stringValue(row.INSIGHT_AI_STATUS, "pending") as AiStatus,
      headline: nullableString(row.INSIGHT_HEADLINE),
      executiveSummary: nullableString(row.EXECUTIVE_SUMMARY),
      whatHappened: nullableString(row.WHAT_HAPPENED),
      businessImpact: nullableString(row.BUSINESS_IMPACT),
      recommendedActions: stringArray(row.RECOMMENDED_ACTIONS),
      confidenceAssessment: nullableString(row.CONFIDENCE_ASSESSMENT),
      caveats: stringArray(row.INSIGHT_CAVEATS),
      modelName: nullableString(row.INSIGHT_MODEL_NAME),
      promptVersion: nullableString(row.INSIGHT_PROMPT_VERSION),
      calledAt: nullableString(row.INSIGHT_CALLED_AT),
    },
  };
}

function mapBreachMonitorRecord(row: SnowflakeRow): BreachMonitorRecord {
  return {
    monitorKey: stringValue(row.MONITOR_KEY),
    incidentKey: nullableString(row.INCIDENT_KEY),
    orgId: stringValue(row.ORG_ID),
    organizationName: stringValue(row.ORGANIZATION_NAME),
    organizationDomain: nullableString(row.ORGANIZATION_DOMAIN),
    docId: nullableString(row.DOC_ID),
    dedupeKey: nullableString(row.DEDUPE_KEY),
    contentSha256: stringValue(row.CONTENT_SHA256),
    title: stringValue(row.TITLE),
    url: stringValue(row.URL),
    source: stringValue(row.SOURCE, "unknown"),
    discoveredAt: stringValue(row.DISCOVERED_AT),
    monitorStatus: stringValue(row.MONITOR_STATUS) as BreachMonitorStatus,
    pipelineState: stringValue(
      row.PIPELINE_STATE,
    ) as BreachMonitorPipelineState,
    relationshipAiStatus: stringValue(
      row.RELATIONSHIP_AI_STATUS,
      "pending",
    ) as AiStatus,
    relationshipLabel: nullableString(
      row.RELATIONSHIP_LABEL,
    ) as RelationshipLabel | null,
    l2Route: nullableString(row.L2_ROUTE) as L2Route | null,
    routingReason: stringValue(row.ROUTING_REASON),
    leakTypes: stringArray(row.LEAK_TYPE_LABELS) as LeakType[],
    quantityClaimed: nullableNumber(row.QUANTITY_CLAIMED),
    impactSeverityScore: nullableNumber(row.IMPACT_SEVERITY_SCORE),
    impactSeverityBand: nullableString(
      row.IMPACT_SEVERITY_BAND,
    ) as SeverityBand | null,
    evidenceConfidenceScore: nullableNumber(row.EVIDENCE_CONFIDENCE_SCORE),
    evidenceConfidenceBand: nullableString(
      row.EVIDENCE_CONFIDENCE_BAND,
    ) as ConfidenceBand | null,
    triagePriorityScore: nullableNumber(row.TRIAGE_PRIORITY_SCORE),
    triagePriorityBand: nullableString(
      row.TRIAGE_PRIORITY_BAND,
    ) as SeverityBand | null,
    actorNodeKey: nullableString(row.ACTOR_NODE_KEY),
    actorName: nullableString(row.ACTOR_NAME),
    actorCredibilityScore: nullableNumber(row.ACTOR_CREDIBILITY_SCORE),
    groundingLevel: nullableString(
      row.GROUNDING_LEVEL,
    ) as GroundingLevel | null,
    remediationStatus: stringValue(
      row.REMEDIATION_STATUS,
      "new",
    ) as RemediationStatus,
    detailAvailable: booleanValue(row.DETAIL_AVAILABLE),
  };
}

function mapIncidentClaim(row: SnowflakeRow): DashboardIncidentClaim {
  return {
    orgId: stringValue(row.ORG_ID),
    incidentKey: stringValue(row.INCIDENT_KEY),
    docId: stringValue(row.DOC_ID),
    dedupeKey: stringValue(row.DEDUPE_KEY),
    contentSha256: stringValue(row.CONTENT_SHA256),
    claimKey: stringValue(row.CLAIM_KEY),
    statement: stringValue(row.CLAIM_STATEMENT),
    statementTruncated: booleanValue(row.CLAIM_STATEMENT_TRUNCATED),
    claimStatus: stringValue(row.CLAIM_STATUS) as ClaimStatus,
    claimStatusExtracted: stringValue(
      row.CLAIM_STATUS_EXTRACTED,
    ) as ExtractedClaimStatus,
    quantityClaimed: nullableNumber(row.QUANTITY_CLAIMED),
    groundingLevel: stringValue(
      row.GROUNDING_LEVEL,
    ) as DashboardIncidentClaim["groundingLevel"],
    maskedEvidenceText: stringValue(row.MASKED_EVIDENCE_TEXT),
    evidenceTextTruncated: booleanValue(row.EVIDENCE_TEXT_TRUNCATED),
    evidenceStart: nullableNumber(row.EVIDENCE_START),
    evidenceEnd: nullableNumber(row.EVIDENCE_END),
    selectedWindowId: nullableString(row.SELECTED_WINDOW_ID),
    subjectNodeKey: stringValue(row.SUBJECT_NODE_KEY),
    subjectName: stringValue(row.SUBJECT_NAME),
    corroborationCount: numberValue(row.CORROBORATION_COUNT),
    sightingCount: numberValue(row.SIGHTING_COUNT),
    mirrorSightingCount: numberValue(row.MIRROR_SIGHTING_COUNT),
    uniqueClaimCount: numberValue(row.UNIQUE_CLAIM_COUNT),
    disputeCount: numberValue(row.DISPUTE_COUNT),
    graphScope: stringValue(
      row.GRAPH_SCOPE,
      "target_incident",
    ) as "target_incident",
  };
}

function mapIncidentIndicatorCount(
  row: SnowflakeRow,
): DashboardIncidentIndicatorCount {
  return {
    orgId: stringValue(row.ORG_ID),
    incidentKey: stringValue(row.INCIDENT_KEY),
    docId: stringValue(row.DOC_ID),
    dedupeKey: stringValue(row.DEDUPE_KEY),
    indicatorType: stringValue(row.INDICATOR_TYPE),
    indicatorCount: numberValue(row.INDICATOR_COUNT),
    strongIndicatorCount: numberValue(row.STRONG_INDICATOR_COUNT),
    mediumIndicatorCount: numberValue(row.MEDIUM_INDICATOR_COUNT),
    weakIndicatorCount: numberValue(row.WEAK_INDICATOR_COUNT),
    indicatorEvidenceScore: numberValue(row.INDICATOR_EVIDENCE_SCORE),
  };
}

function mapIncidentGraphNode(row: SnowflakeRow): DashboardIncidentGraphNode {
  return {
    orgId: stringValue(row.ORG_ID),
    incidentKey: stringValue(row.INCIDENT_KEY),
    nodeKey: stringValue(row.NODE_KEY),
    nodeType: stringValue(row.NODE_TYPE) as EntityType | "claim",
    normalizedName: nullableString(row.NORMALIZED_NAME),
    displayName: stringValue(row.DISPLAY_NAME),
    isMonitoredOrg: booleanValue(row.IS_MONITORED_ORG),
    mentionCount: numberValue(row.MENTION_COUNT),
    sightingCount: numberValue(row.SIGHTING_COUNT),
    docCount: numberValue(row.DOC_COUNT),
    mirrorSightingCount: numberValue(row.MIRROR_SIGHTING_COUNT),
    firstSeen: stringValue(row.FIRST_SEEN),
    lastSeen: stringValue(row.LAST_SEEN),
    graphScope: stringValue(
      row.GRAPH_SCOPE,
      "target_incident",
    ) as "target_incident",
  };
}

function mapIncidentGraphEdge(row: SnowflakeRow): DashboardIncidentGraphEdge {
  return {
    orgId: stringValue(row.ORG_ID),
    incidentKey: stringValue(row.INCIDENT_KEY),
    graphEdgeKey: stringValue(row.GRAPH_EDGE_KEY),
    sourceKey: stringValue(row.SOURCE_KEY),
    edgeType: stringValue(row.EDGE_TYPE) as EdgeType,
    targetKey: stringValue(row.TARGET_KEY),
    sourceKind: stringValue(row.SOURCE_KIND) as "entity" | "claim",
    sourceType: stringValue(row.SOURCE_TYPE) as EntityType | "claim",
    targetKind: stringValue(row.TARGET_KIND) as "entity" | "claim",
    targetType: stringValue(row.TARGET_TYPE) as EntityType | "claim",
    mentionCount: numberValue(row.MENTION_COUNT),
    sightingCount: numberValue(row.SIGHTING_COUNT),
    docCount: numberValue(row.DOC_COUNT),
    mirrorSightingCount: numberValue(row.MIRROR_SIGHTING_COUNT),
    firstSeen: stringValue(row.FIRST_SEEN),
    lastSeen: stringValue(row.LAST_SEEN),
    graphScope: stringValue(
      row.GRAPH_SCOPE,
      "target_incident",
    ) as "target_incident",
  };
}

function summarizeBreachMonitor(
  rows: BreachMonitorRecord[],
): BreachMonitorResponse["summary"] {
  const confirmed = rows.filter(
    (row) => row.monitorStatus === "confirmed_yours",
  );
  const exposedDataClasses = new Set(
    confirmed.flatMap((row) => row.leakTypes),
  );

  return {
    totalRows: rows.length,
    confirmedLeaks: confirmed.length,
    recordsClaimed: confirmed.reduce(
      (total, row) => total + (row.quantityClaimed ?? 0),
      0,
    ),
    exposedDataClassCount: exposedDataClasses.size,
    needsReview: rows.filter(
      (row) => row.monitorStatus === "needs_review",
    ).length,
    anotherCompany: rows.filter(
      (row) => row.monitorStatus === "another_company",
    ).length,
  };
}

function emptyMetrics(): CommandCenterMetrics {
  return {
    topImpactSeverityScore: null,
    topImpactSeverityBand: null,
    openIncidentCount: 0,
    incidentsByBand: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      informational: 0,
    },
    distinctThreatActorCount: 0,
    grounding: {
      rate: 0,
      exactCount: 0,
      normalizedCount: 0,
      verifiedCount: 0,
      quarantinedCount: 0,
      totalExtractedClaims: 0,
    },
    pipeline: {
      pagesCollected: 0,
      pagesScreened: 0,
      uniquePages: 0,
      pagesRelevanceChecked: 0,
      pagesSelectedForL2: 0,
      pagesEvidenceExtracted: 0,
      pagesOwnershipVerified: 0,
      pagesDataTypesClassified: 0,
      incidentsRaised: 0,
    },
    downstreamAiErrorCount: 0,
  };
}

function aggregateMetrics(
  organizations: CommandCenterOrganizationSnapshot[],
  incidents: DashboardIncident[],
): CommandCenterMetrics {
  const totals = emptyMetrics();
  const pipelineKeys = Object.keys(totals.pipeline) as Array<
    keyof DashboardPipelineCounts
  >;

  for (const organization of organizations) {
    const metrics = organization.metrics;
    for (const key of pipelineKeys) totals.pipeline[key] += metrics.pipeline[key];
    for (const band of Object.keys(totals.incidentsByBand) as SeverityBand[]) {
      totals.incidentsByBand[band] += metrics.incidentsByBand[band];
    }
    totals.grounding.exactCount += metrics.grounding.exactCount;
    totals.grounding.normalizedCount += metrics.grounding.normalizedCount;
    totals.grounding.verifiedCount += metrics.grounding.verifiedCount;
    totals.grounding.quarantinedCount += metrics.grounding.quarantinedCount;
    totals.grounding.totalExtractedClaims += metrics.grounding.totalExtractedClaims;
    totals.downstreamAiErrorCount += metrics.downstreamAiErrorCount;

    if (
      metrics.topImpactSeverityScore !== null
      && (
        totals.topImpactSeverityScore === null
        || metrics.topImpactSeverityScore > totals.topImpactSeverityScore
      )
    ) {
      totals.topImpactSeverityScore = metrics.topImpactSeverityScore;
      totals.topImpactSeverityBand = metrics.topImpactSeverityBand;
    }
  }

  totals.openIncidentCount = totals.pipeline.incidentsRaised;
  totals.distinctThreatActorCount = new Set(
    incidents
      .map((incident) => incident.actorNodeKey ?? incident.actorName)
      .filter((actor): actor is string => Boolean(actor)),
  ).size;
  if (totals.grounding.totalExtractedClaims > 0) {
    totals.grounding.rate = Number(
      (
        100
        * totals.grounding.verifiedCount
        / totals.grounding.totalExtractedClaims
      ).toFixed(1),
    );
  }
  return totals;
}

function buildCascade(metrics: CommandCenterMetrics): CommandCenterResponse["cascade"] {
  const counts = metrics.pipeline;
  return [
    { id: "collected", label: "Pages collected", layerTag: null, count: counts.pagesCollected, isBilled: false, costTier: 0 },
    { id: "screened", label: "Screened for signals", layerTag: "L0", count: counts.pagesScreened, isBilled: false, costTier: 0 },
    { id: "deduped", label: "Duplicates removed", layerTag: null, count: counts.uniquePages, isBilled: false, costTier: 0 },
    { id: "relevance", label: "Checked for relevance", layerTag: "L1", count: counts.pagesRelevanceChecked, isBilled: true, costTier: 2 },
    { id: "selected", label: "Selected for deep analysis", layerTag: null, count: counts.pagesSelectedForL2, isBilled: false, costTier: 0 },
    { id: "extracted", label: "Evidence extracted", layerTag: "L2", count: counts.pagesEvidenceExtracted, isBilled: true, costTier: 3 },
    { id: "verified", label: "Ownership verified", layerTag: null, count: counts.pagesOwnershipVerified, isBilled: false, costTier: 0 },
    { id: "classified", label: "Data types classified", layerTag: null, count: counts.pagesDataTypesClassified, isBilled: true, costTier: 2 },
    { id: "incidents", label: "Incidents raised", layerTag: "L4", count: counts.incidentsRaised, isBilled: false, costTier: 0 },
  ];
}

function latestTimestamp(values: Array<string | null>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

export class SnowflakeNocturneBackend implements NocturneBackend {
  async getCommandCenter(scope: DataScope): Promise<CommandCenterResponse> {
    const filter = scopeFilter(scope);
    const [summaryRows, incidentRows] = await Promise.all([
      executeQuery(
        `SELECT ${SUMMARY_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_COMMAND_CENTER${filter.clause}
         ORDER BY ORG_ID`,
        filter.binds,
      ),
      executeQuery(
        `SELECT ${INCIDENT_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_INCIDENTS${filter.clause}
         ORDER BY TRIAGE_PRIORITY_SCORE DESC, INCIDENT_KEY`,
        filter.binds,
      ),
    ]);

    const organizations = summaryRows.map(mapOrganization);
    const enabledOrgIds = new Set(
      organizations.map((organization) => organization.orgId),
    );
    const incidents = incidentRows
      .map(mapIncident)
      .filter((incident) => enabledOrgIds.has(incident.orgId));
    const totals = aggregateMetrics(organizations, incidents);

    return {
      scope,
      organizations,
      totals,
      cascade: buildCascade(totals),
      incidents,
      lastUpdatedAt: latestTimestamp(
        organizations.map((organization) => organization.lastUpdatedAt),
      ),
      fetchedAt: new Date().toISOString(),
    };
  }

  async getBreachMonitor(
    scope: DataScope,
    access: BreachMonitorAccess = {},
  ): Promise<BreachMonitorResponse> {
    const filter = breachMonitorFilter(
      scope,
      access.includeExternalContext === true,
    );
    const resultRows = await executeQuery(
      `SELECT ${BREACH_MONITOR_COLUMNS}
       FROM NOCTURNE.DASHBOARD.VW_BREACH_MONITOR${filter.clause}
       ORDER BY
         CASE MONITOR_STATUS
           WHEN 'confirmed_yours' THEN 1
           WHEN 'needs_review' THEN 2
           ELSE 3
         END,
         TRIAGE_PRIORITY_SCORE DESC NULLS LAST,
         DISCOVERED_AT DESC,
         MONITOR_KEY`,
      filter.binds,
    );
    const rows = resultRows.map(mapBreachMonitorRecord);

    return {
      scope,
      summary: summarizeBreachMonitor(rows),
      rows,
      lastUpdatedAt: latestTimestamp(rows.map((row) => row.discoveredAt)),
      fetchedAt: new Date().toISOString(),
    };
  }

  async getIncidentDetail(
    scope: DataScope,
    incidentKey: string,
  ): Promise<IncidentDetailResponse | null> {
    const scopeConstraint = scopeFilter(scope);
    const incidentBinds: Binds = scope.kind === "org"
      ? [scope.orgId, incidentKey]
      : [incidentKey];
    const incidentRows = await executeQuery(
      `SELECT ${INCIDENT_COLUMNS}
       FROM NOCTURNE.DASHBOARD.VW_INCIDENTS
       ${scopeConstraint.clause || "WHERE 1 = 1"}
         AND INCIDENT_KEY = ?
       LIMIT 1`,
      incidentBinds,
    );
    if (incidentRows.length === 0) return null;

    const incident = mapIncident(incidentRows[0]);
    // Resolve the organization from the authorized incident row, then pin all
    // dependent reads to both keys—even for a fleet-scoped administrator.
    const detailBinds: Binds = [incident.orgId, incident.incidentKey];
    const [claimRows, indicatorRows, nodeRows, edgeRows] = await Promise.all([
      executeQuery(
        `SELECT ${INCIDENT_CLAIM_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_INCIDENT_CLAIMS
         WHERE ORG_ID = ? AND INCIDENT_KEY = ?
         ORDER BY CLAIM_STATUS, CLAIM_KEY`,
        detailBinds,
      ),
      executeQuery(
        `SELECT ${INCIDENT_INDICATOR_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_INCIDENT_INDICATOR_COUNTS
         WHERE ORG_ID = ? AND INCIDENT_KEY = ?
         ORDER BY INDICATOR_COUNT DESC, INDICATOR_TYPE`,
        detailBinds,
      ),
      executeQuery(
        `SELECT ${INCIDENT_GRAPH_NODE_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_INCIDENT_GRAPH_NODES
         WHERE ORG_ID = ? AND INCIDENT_KEY = ?
         ORDER BY IS_MONITORED_ORG DESC, NODE_TYPE, DISPLAY_NAME, NODE_KEY`,
        detailBinds,
      ),
      executeQuery(
        `SELECT ${INCIDENT_GRAPH_EDGE_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_INCIDENT_GRAPH_EDGES
         WHERE ORG_ID = ? AND INCIDENT_KEY = ?
         ORDER BY EDGE_TYPE, SOURCE_KEY, TARGET_KEY`,
        detailBinds,
      ),
    ]);

    return {
      scope,
      incident,
      claims: claimRows.map(mapIncidentClaim),
      indicatorCounts: indicatorRows.map(mapIncidentIndicatorCount),
      graph: {
        nodes: nodeRows.map(mapIncidentGraphNode),
        edges: edgeRows.map(mapIncidentGraphEdge),
      },
      fetchedAt: new Date().toISOString(),
    };
  }
}

export const nocturneBackend: NocturneBackend = new SnowflakeNocturneBackend();

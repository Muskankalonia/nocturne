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
  EntityMatchMethod,
  EntityMatchStatus,
  EntityType,
  ExtractedClaimStatus,
  GraphEdge,
  GraphNode,
  GroundingLevel,
  L2Route,
  LeakType,
  RelationshipLabel,
  RemediationStatus,
  ScoreReason,
  SeverityBand,
  ThreatActor,
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
  KnowledgeGraphResponse,
  KnowledgeGraphView,
  MonitoredOrganizationRecord,
  MonitoredOrganizationUpdate,
  ThreatActorsResponse,
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
  getKnowledgeGraph(
    scope: DataScope,
    view: KnowledgeGraphView,
    incidentKey?: string,
  ): Promise<KnowledgeGraphResponse | null>;
  getThreatActors(scope: DataScope): Promise<ThreatActorsResponse>;
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
  NODE_DESCRIPTION,
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

const KNOWLEDGE_GRAPH_NODE_COLUMNS = `
  ORG_ID,
  NODE_KEY,
  NODE_TYPE,
  NORMALIZED_NAME,
  DISPLAY_NAME,
  NODE_DESCRIPTION,
  IS_MONITORED_ORG,
  ENTITY_MATCH_STATUS,
  ENTITY_MATCH_METHOD,
  ENTITY_MATCH_CONFIDENCE,
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

const KNOWLEDGE_GRAPH_EDGE_COLUMNS = `
  ORG_ID,
  GRAPH_EDGE_KEY,
  SOURCE_KEY,
  EDGE_TYPE,
  TARGET_KEY,
  SOURCE_KIND,
  SOURCE_TYPE,
  TARGET_KIND,
  TARGET_TYPE,
  SAMPLE_EVIDENCE_TEXT,
  GROUNDING_LEVEL,
  EVIDENCE_START,
  EVIDENCE_END,
  SELECTED_WINDOW_ID,
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

const KNOWLEDGE_GRAPH_ROOT_COLUMNS = `
  INCIDENT_KEY,
  TOP_TITLE,
  TOP_URL,
  ACTOR_NAME,
  IMPACT_SEVERITY_SCORE,
  IMPACT_SEVERITY_BAND,
  TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS FIRST_SEEN
`;

const THREAT_ACTOR_COLUMNS = `
  ORG_ID,
  ACTOR_NODE_KEY,
  ACTOR_NAME,
  TOTAL_CLAIM_COUNT,
  CORROBORATED_CLAIM_COUNT,
  SELF_EVIDENCED_CLAIM_COUNT,
  DISPUTED_CLAIM_COUNT,
  DOC_COUNT,
  SIGHTING_COUNT,
  MIRROR_SIGHTING_COUNT,
  MARKETPLACE_COUNT,
  MARKETPLACES,
  CONTACT_CHANNEL_COUNT,
  CORROBORATION_COMPONENT,
  SELF_EVIDENCE_COMPONENT,
  INDEPENDENT_HISTORY_COMPONENT,
  CLAIM_HISTORY_COMPONENT,
  DISPUTE_PENALTY,
  ACTOR_CREDIBILITY_SCORE,
  ACTOR_METHOD_VERSION,
  TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS FIRST_SEEN,
  TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
    AS LAST_SEEN
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

function mapKnowledgeGraphNode(row: SnowflakeRow): GraphNode {
  const matchStatus = nullableString(row.ENTITY_MATCH_STATUS);
  const matchMethod = nullableString(row.ENTITY_MATCH_METHOD);
  const matchConfidence = nullableNumber(row.ENTITY_MATCH_CONFIDENCE);

  return {
    nodeKey: stringValue(row.NODE_KEY),
    globalNodeKey: null,
    orgId: stringValue(row.ORG_ID),
    nodeType: stringValue(row.NODE_TYPE) as EntityType | "claim",
    displayName: stringValue(row.DISPLAY_NAME),
    description: stringValue(row.NODE_DESCRIPTION, stringValue(row.DISPLAY_NAME)),
    normalizedName: stringValue(row.NORMALIZED_NAME),
    isMonitoredOrg: booleanValue(row.IS_MONITORED_ORG),
    mentionCount: numberValue(row.MENTION_COUNT),
    sightingCount: numberValue(row.SIGHTING_COUNT),
    docCount: numberValue(row.DOC_COUNT),
    mirrorSightingCount: numberValue(row.MIRROR_SIGHTING_COUNT),
    firstSeen: stringValue(row.FIRST_SEEN),
    lastSeen: stringValue(row.LAST_SEEN),
    ...(matchStatus
      ? { entityMatchStatus: matchStatus as EntityMatchStatus }
      : {}),
    ...(matchMethod
      ? { entityMatchMethod: matchMethod as EntityMatchMethod }
      : {}),
    ...(matchConfidence === null
      ? {}
      : { entityMatchConfidence: matchConfidence }),
  };
}

function mapKnowledgeGraphEdge(row: SnowflakeRow): GraphEdge {
  return {
    graphEdgeKey: stringValue(row.GRAPH_EDGE_KEY),
    orgId: stringValue(row.ORG_ID),
    sourceKey: stringValue(row.SOURCE_KEY),
    targetKey: stringValue(row.TARGET_KEY),
    edgeType: stringValue(row.EDGE_TYPE) as EdgeType,
    sourceKind: stringValue(row.SOURCE_KIND) as "entity" | "claim",
    targetKind: stringValue(row.TARGET_KIND) as "entity" | "claim",
    sourceType: stringValue(row.SOURCE_TYPE) as EntityType | "claim",
    targetType: stringValue(row.TARGET_TYPE) as EntityType | "claim",
    sampleEvidenceText: stringValue(row.SAMPLE_EVIDENCE_TEXT),
    groundingLevel: stringValue(row.GROUNDING_LEVEL) as GroundingLevel,
    evidenceStart: nullableNumber(row.EVIDENCE_START),
    evidenceEnd: nullableNumber(row.EVIDENCE_END),
    mentionCount: numberValue(row.MENTION_COUNT),
    sightingCount: numberValue(row.SIGHTING_COUNT),
    docCount: numberValue(row.DOC_COUNT),
    firstSeen: stringValue(row.FIRST_SEEN),
    lastSeen: stringValue(row.LAST_SEEN),
  };
}

function mapThreatActor(row: SnowflakeRow): ThreatActor {
  return {
    actorNodeKey: stringValue(row.ACTOR_NODE_KEY),
    globalNodeKey: null,
    orgId: stringValue(row.ORG_ID),
    actorName: stringValue(row.ACTOR_NAME, "unattributed"),
    totalClaimCount: numberValue(row.TOTAL_CLAIM_COUNT),
    corroboratedClaimCount: numberValue(row.CORROBORATED_CLAIM_COUNT),
    selfEvidencedClaimCount: numberValue(row.SELF_EVIDENCED_CLAIM_COUNT),
    disputedClaimCount: numberValue(row.DISPUTED_CLAIM_COUNT),
    docCount: numberValue(row.DOC_COUNT),
    sightingCount: numberValue(row.SIGHTING_COUNT),
    mirrorSightingCount: numberValue(row.MIRROR_SIGHTING_COUNT),
    marketplaceCount: numberValue(row.MARKETPLACE_COUNT),
    contactChannelCount: numberValue(row.CONTACT_CHANNEL_COUNT),
    credibilityScore: numberValue(row.ACTOR_CREDIBILITY_SCORE),
    corroborationComponent: numberValue(row.CORROBORATION_COMPONENT),
    selfEvidenceComponent: numberValue(row.SELF_EVIDENCE_COMPONENT),
    independentHistoryComponent: numberValue(row.INDEPENDENT_HISTORY_COMPONENT),
    claimHistoryComponent: numberValue(row.CLAIM_HISTORY_COMPONENT),
    disputePenalty: numberValue(row.DISPUTE_PENALTY),
    credibilityMethodVersion: stringValue(row.ACTOR_METHOD_VERSION),
    firstSeen: stringValue(row.FIRST_SEEN),
    lastSeen: stringValue(row.LAST_SEEN),
    contactChannels: [],
    marketplaces: stringArray(row.MARKETPLACES),
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

  async getKnowledgeGraph(
    scope: DataScope,
    view: KnowledgeGraphView,
    incidentKey?: string,
  ): Promise<KnowledgeGraphResponse | null> {
    if (scope.kind !== "org") {
      throw new Error("Knowledge graph queries require one organization scope.");
    }

    const orgId = scope.orgId;
    const rootClause = incidentKey ? " AND INCIDENT_KEY = ?" : "";
    const rootBinds: Binds = incidentKey ? [orgId, incidentKey] : [orgId];
    const [countRows, rootRows] = await Promise.all([
      executeQuery(
        `SELECT COUNT(*) AS INCIDENT_COUNT
         FROM NOCTURNE.DASHBOARD.VW_INCIDENTS
         WHERE ORG_ID = ?`,
        [orgId],
      ),
      view === "incident"
        ? executeQuery(
            `SELECT ${KNOWLEDGE_GRAPH_ROOT_COLUMNS}
             FROM NOCTURNE.DASHBOARD.VW_INCIDENTS
             WHERE ORG_ID = ?${rootClause}
             ORDER BY
               TRIAGE_PRIORITY_SCORE DESC NULLS LAST,
               LAST_SEEN DESC,
               INCIDENT_KEY
             LIMIT 1`,
            rootBinds,
          )
        : Promise.resolve([]),
    ]);

    if (view === "incident" && rootRows.length === 0) return null;

    const rootRow = rootRows[0];
    const selectedIncidentKey = rootRow
      ? stringValue(rootRow.INCIDENT_KEY)
      : null;
    const isActorNetwork = view === "actors";
    const nodeView = isActorNetwork
      ? "NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_NODES"
      : "NOCTURNE.DASHBOARD.VW_INCIDENT_GRAPH_NODES";
    const edgeView = isActorNetwork
      ? "NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_EDGES"
      : "NOCTURNE.DASHBOARD.VW_INCIDENT_GRAPH_EDGES";
    const graphClause = isActorNetwork
      ? "WHERE ORG_ID = ?"
      : "WHERE ORG_ID = ? AND INCIDENT_KEY = ?";
    const graphBinds: Binds = isActorNetwork
      ? [orgId]
      : [orgId, selectedIncidentKey as string];

    const [nodeRows, edgeRows] = await Promise.all([
      executeQuery(
        `SELECT ${KNOWLEDGE_GRAPH_NODE_COLUMNS}
         FROM ${nodeView}
         ${graphClause}
         ORDER BY IS_MONITORED_ORG DESC, NODE_TYPE, DISPLAY_NAME, NODE_KEY`,
        graphBinds,
      ),
      executeQuery(
        `SELECT ${KNOWLEDGE_GRAPH_EDGE_COLUMNS}
         FROM ${edgeView}
         ${graphClause}
         ORDER BY FIRST_SEEN, EDGE_TYPE, SOURCE_KEY, TARGET_KEY`,
        graphBinds,
      ),
    ]);

    return {
      scope,
      view,
      rootKey: selectedIncidentKey,
      rootIncident: rootRow
        ? {
            incidentKey: stringValue(rootRow.INCIDENT_KEY),
            title: stringValue(rootRow.TOP_TITLE),
            url: stringValue(rootRow.TOP_URL),
            actorName: nullableString(rootRow.ACTOR_NAME),
            impactSeverityScore: nullableNumber(rootRow.IMPACT_SEVERITY_SCORE),
            impactSeverityBand: nullableString(
              rootRow.IMPACT_SEVERITY_BAND,
            ) as SeverityBand | null,
            firstSeen: stringValue(rootRow.FIRST_SEEN),
          }
        : null,
      incidentCount: numberValue(countRows[0]?.INCIDENT_COUNT),
      nodes: nodeRows.map(mapKnowledgeGraphNode),
      edges: edgeRows.map(mapKnowledgeGraphEdge),
      fetchedAt: new Date().toISOString(),
    };
  }

  async getThreatActors(scope: DataScope): Promise<ThreatActorsResponse> {
    if (scope.kind !== "org") {
      throw new Error("Threat actor queries require one organization scope.");
    }

    const rows = await executeQuery(
      `SELECT ${THREAT_ACTOR_COLUMNS}
       FROM NOCTURNE.DASHBOARD.VW_THREAT_ACTORS
       WHERE ORG_ID = ?
       ORDER BY ACTOR_CREDIBILITY_SCORE DESC, LAST_SEEN DESC, ACTOR_NODE_KEY`,
      [scope.orgId],
    );
    const actors = rows.map(mapThreatActor);
    const marketplaces = new Set(
      actors.flatMap((actor) => actor.marketplaces),
    );

    return {
      scope,
      summary: {
        actorCount: actors.length,
        corroboratedClaimCount: actors.reduce(
          (total, actor) => total + actor.corroboratedClaimCount,
          0,
        ),
        marketplaceCount: marketplaces.size,
        highestCredibilityScore: actors.reduce(
          (highest, actor) => Math.max(highest, actor.credibilityScore),
          0,
        ),
      },
      actors,
      lastUpdatedAt: latestTimestamp(actors.map((actor) => actor.lastSeen)),
      fetchedAt: new Date().toISOString(),
    };
  }
}

export const nocturneBackend: NocturneBackend = new SnowflakeNocturneBackend();

/* ── monitored-organization configuration ──────────────────────────────────── */

const MONITORED_ORG_COLUMNS = `
  ORG_ID,
  CANONICAL_NAME,
  ALIASES,
  DOMAINS,
  PRODUCTS,
  ENABLED,
  TO_VARCHAR(CREATED_AT, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS CREATED_AT,
  TO_VARCHAR(UPDATED_AT, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS UPDATED_AT
`;

/** Caps are defensive: these arrays are matched against every crawled page. */
const MAX_LIST_ENTRIES = 64;
const MAX_ENTRY_LENGTH = 120;
const DOMAIN_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

function mapMonitoredOrganization(row: SnowflakeRow): MonitoredOrganizationRecord {
  return {
    orgId: stringValue(row.ORG_ID),
    canonicalName: stringValue(row.CANONICAL_NAME),
    aliases: stringArray(row.ALIASES),
    domains: stringArray(row.DOMAINS),
    products: stringArray(row.PRODUCTS),
    enabled: booleanValue(row.ENABLED),
    createdAt: nullableString(row.CREATED_AT),
    updatedAt: nullableString(row.UPDATED_AT),
  };
}

/** Trim, drop blanks, de-duplicate case-insensitively, and bound the size. */
function normalizeList(values: unknown, label: string): string[] {
  if (!Array.isArray(values)) {
    throw new ConfigValidationError(`${label} must be an array of strings.`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") {
      throw new ConfigValidationError(`${label} must contain only strings.`);
    }
    const value = raw.trim();
    if (!value) continue;
    if (value.length > MAX_ENTRY_LENGTH) {
      throw new ConfigValidationError(
        `${label} entries must be ${MAX_ENTRY_LENGTH} characters or fewer.`,
      );
    }
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  if (out.length > MAX_LIST_ENTRIES) {
    throw new ConfigValidationError(
      `${label} cannot hold more than ${MAX_LIST_ENTRIES} entries.`,
    );
  }
  return out;
}

/** A bad domain silently stops matching real breaches, so reject it loudly. */
function normalizeDomains(values: unknown): string[] {
  return normalizeList(values, "Domains").map((domain) => {
    const value = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!DOMAIN_PATTERN.test(value)) {
      throw new ConfigValidationError(
        `"${domain}" is not a valid domain. Use a bare hostname such as example.com.`,
      );
    }
    return value;
  });
}

/** Thrown for user-correctable input so routes can answer 400 instead of 500. */
export class ConfigValidationError extends Error {}

export function normalizeMonitoredOrganizationUpdate(
  input: unknown,
): MonitoredOrganizationUpdate {
  if (!input || typeof input !== "object") {
    throw new ConfigValidationError("A JSON object body is required.");
  }
  const body = input as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") {
    throw new ConfigValidationError("`enabled` must be true or false.");
  }
  return {
    aliases: normalizeList(body.aliases, "Aliases"),
    domains: normalizeDomains(body.domains),
    products: normalizeList(body.products, "Products"),
    enabled: body.enabled,
  };
}

export async function listMonitoredOrganizations(
  scope: DataScope,
): Promise<MonitoredOrganizationRecord[]> {
  const filter = scopeFilter(scope);
  const rows = await executeQuery(
    `SELECT ${MONITORED_ORG_COLUMNS}
     FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS${filter.clause}
     ORDER BY ORG_ID`,
    filter.binds,
  );
  return rows.map(mapMonitoredOrganization);
}

/**
 * Writes the editable fields for one organization and returns the stored row.
 *
 * Arrays travel as JSON text and are parsed server-side rather than being
 * interpolated, so an alias containing a quote can never alter the statement.
 * Returns null when the org does not exist, which the route turns into a 404.
 */
export async function updateMonitoredOrganization(
  orgId: string,
  update: MonitoredOrganizationUpdate,
): Promise<MonitoredOrganizationRecord | null> {
  await executeQuery(
    `UPDATE NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
     SET ALIASES = CAST(PARSE_JSON(?) AS ARRAY),
         DOMAINS = CAST(PARSE_JSON(?) AS ARRAY),
         PRODUCTS = CAST(PARSE_JSON(?) AS ARRAY),
         ENABLED = ?,
         UPDATED_AT = CURRENT_TIMESTAMP()
     WHERE ORG_ID = ?`,
    [
      JSON.stringify(update.aliases),
      JSON.stringify(update.domains),
      JSON.stringify(update.products),
      update.enabled,
      orgId,
    ],
  );

  const rows = await executeQuery(
    `SELECT ${MONITORED_ORG_COLUMNS}
     FROM NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS
     WHERE ORG_ID = ?`,
    [orgId],
  );
  return rows.length ? mapMonitoredOrganization(rows[0]!) : null;
}

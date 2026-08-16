import snowflake, {
  type Binds,
  type Connection,
  type ConnectionOptions,
} from "snowflake-sdk";

import { organizations as consoleTenants } from "@/mocks/organizations";
import {
  getDemoBreachMonitor,
  getDemoCommandCenter,
  getDemoIncidentDetail,
  getDemoKnowledgeGraph,
  getDemoPipeline,
  getDemoMonitoredOrganization,
  getDemoThreatActors,
  isDemoScope,
  DEMO_ORG_ID,
} from "@/server/demo-backend";

import type {
  AiStatus,
  AiStage,
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
  RejectionReason,
  RemediationStatus,
  ScoreReason,
  SeverityBand,
  TaskHealth,
  ThreatActor,
  VersionDrift,
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
  PendingAlert,
  PipelineAiCacheStage,
  PipelineCacheSummary,
  PipelineResponse,
  ThreatActorsResponse,
  UserProfileRecord,
  UserProfileUpdate,
} from "@/types/dashboard";

if (typeof window !== "undefined") {
  throw new Error("The Nocturne Snowflake backend may only run on the server.");
}

type SnowflakeRow = Record<string, unknown>;

async function optionalDashboardQuery(
  label: string,
  sql: string,
  binds?: Binds,
): Promise<SnowflakeRow[]> {
  try {
    return await executeQuery(sql, binds);
  } catch (error) {
    console.warn(`[nocturne-dashboard] optional ${label} query unavailable:`, error);
    return [];
  }
}

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
  /**
   * `include` narrows a fleet request to a chosen subset of tenants. It is a
   * view preference, not an access control: it can only ever remove rows the
   * caller was already permitted to see, and org-scoped requests ignore it.
   */
  getCommandCenter(
    scope: DataScope,
    include?: ReadonlySet<string>,
  ): Promise<CommandCenterResponse>;
  getBreachMonitor(
    scope: DataScope,
    access?: BreachMonitorAccess,
    include?: ReadonlySet<string>,
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
  getPipeline(scope: DataScope): Promise<PipelineResponse>;
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

const ACTOR_NETWORK_NODE_QUERY = `
  WITH PARAMS AS (
    SELECT ?::VARCHAR AS ORG_ID
  ),
  ACTORS AS (
    SELECT
      ACTOR.ORG_ID,
      ACTOR.ACTOR_NODE_KEY,
      ACTOR.ACTOR_NAME,
      ACTOR.TOTAL_CLAIM_COUNT,
      ACTOR.CORROBORATED_CLAIM_COUNT,
      ACTOR.DOC_COUNT,
      ACTOR.SIGHTING_COUNT,
      ACTOR.MIRROR_SIGHTING_COUNT,
      ACTOR.ACTOR_CREDIBILITY_SCORE,
      ACTOR.FIRST_SEEN,
      ACTOR.LAST_SEEN
    FROM NOCTURNE.DASHBOARD.VW_THREAT_ACTORS AS ACTOR
    INNER JOIN PARAMS
      ON PARAMS.ORG_ID = ACTOR.ORG_ID
  ),
  ACTOR_TARGETS AS (
    SELECT DISTINCT
      CLAIM_EDGE.ORG_ID,
      AFFECTS_EDGE.TARGET_KEY AS NODE_KEY
    FROM NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_EDGES AS CLAIM_EDGE
    INNER JOIN NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_EDGES AS AFFECTS_EDGE
      ON AFFECTS_EDGE.ORG_ID = CLAIM_EDGE.ORG_ID
      AND AFFECTS_EDGE.SOURCE_KEY = CLAIM_EDGE.TARGET_KEY
      AND AFFECTS_EDGE.EDGE_TYPE = 'ALLEGEDLY_AFFECTS'
      AND AFFECTS_EDGE.TARGET_TYPE IN ('organization', 'domain')
    INNER JOIN PARAMS
      ON PARAMS.ORG_ID = CLAIM_EDGE.ORG_ID
    WHERE CLAIM_EDGE.EDGE_TYPE = 'MADE_CLAIM'
      AND CLAIM_EDGE.SOURCE_TYPE = 'actor_alias'
      AND CLAIM_EDGE.TARGET_TYPE = 'claim'

    UNION

    SELECT DISTINCT
      LISTED_EDGE.ORG_ID,
      LISTED_EDGE.TARGET_KEY AS NODE_KEY
    FROM NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_EDGES AS LISTED_EDGE
    INNER JOIN PARAMS
      ON PARAMS.ORG_ID = LISTED_EDGE.ORG_ID
    WHERE LISTED_EDGE.EDGE_TYPE = 'LISTED_ON'
      AND LISTED_EDGE.SOURCE_TYPE = 'actor_alias'
      AND LISTED_EDGE.TARGET_TYPE = 'marketplace'
  ),
  ENTITY_NODES AS (
    SELECT
      NODE.ORG_ID,
      NODE.NODE_KEY,
      NODE.NODE_TYPE,
      NODE.NORMALIZED_NAME,
      NODE.DISPLAY_NAME,
      NODE.NODE_DESCRIPTION,
      NODE.IS_MONITORED_ORG,
      NODE.ENTITY_MATCH_STATUS,
      NODE.ENTITY_MATCH_METHOD,
      NODE.ENTITY_MATCH_CONFIDENCE,
      NODE.MENTION_COUNT,
      NODE.SIGHTING_COUNT,
      NODE.DOC_COUNT,
      NODE.MIRROR_SIGHTING_COUNT,
      NODE.FIRST_SEEN,
      NODE.LAST_SEEN,
      NODE.GRAPH_SCOPE
    FROM NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_NODES AS NODE
    INNER JOIN ACTOR_TARGETS AS TARGET
      ON TARGET.ORG_ID = NODE.ORG_ID
      AND TARGET.NODE_KEY = NODE.NODE_KEY
  ),
  ACTOR_NODES AS (
    SELECT
      ORG_ID,
      ACTOR_NODE_KEY AS NODE_KEY,
      'actor_alias' AS NODE_TYPE,
      LOWER(ACTOR_NAME) AS NORMALIZED_NAME,
      ACTOR_NAME AS DISPLAY_NAME,
      'Threat actor aggregate: '
        || TOTAL_CLAIM_COUNT
        || ' claim(s), credibility '
        || ACTOR_CREDIBILITY_SCORE
        || '/100' AS NODE_DESCRIPTION,
      FALSE AS IS_MONITORED_ORG,
      NULL::VARCHAR AS ENTITY_MATCH_STATUS,
      NULL::VARCHAR AS ENTITY_MATCH_METHOD,
      NULL::NUMBER AS ENTITY_MATCH_CONFIDENCE,
      TOTAL_CLAIM_COUNT AS MENTION_COUNT,
      SIGHTING_COUNT,
      DOC_COUNT,
      MIRROR_SIGHTING_COUNT,
      FIRST_SEEN,
      LAST_SEEN,
      'target_incident' AS GRAPH_SCOPE
    FROM ACTORS
  ),
  CLAIM_BUNDLE_NODES AS (
    SELECT
      ORG_ID,
      'actor_claim_bundle:' || ACTOR_NODE_KEY AS NODE_KEY,
      'claim' AS NODE_TYPE,
      LOWER(ACTOR_NAME) || ' claims' AS NORMALIZED_NAME,
      TOTAL_CLAIM_COUNT || ' claim(s)' AS DISPLAY_NAME,
      'Aggregated target-confirmed claims made by ' || ACTOR_NAME AS NODE_DESCRIPTION,
      FALSE AS IS_MONITORED_ORG,
      NULL::VARCHAR AS ENTITY_MATCH_STATUS,
      NULL::VARCHAR AS ENTITY_MATCH_METHOD,
      NULL::NUMBER AS ENTITY_MATCH_CONFIDENCE,
      TOTAL_CLAIM_COUNT AS MENTION_COUNT,
      SIGHTING_COUNT,
      DOC_COUNT,
      MIRROR_SIGHTING_COUNT,
      FIRST_SEEN,
      LAST_SEEN,
      'target_incident' AS GRAPH_SCOPE
    FROM ACTORS
  )
  SELECT
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
    TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS FIRST_SEEN,
    TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS LAST_SEEN,
    GRAPH_SCOPE
  FROM ACTOR_NODES

  UNION ALL

  SELECT
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
    TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS FIRST_SEEN,
    TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS LAST_SEEN,
    GRAPH_SCOPE
  FROM CLAIM_BUNDLE_NODES

  UNION ALL

  SELECT
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
    TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS FIRST_SEEN,
    TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS LAST_SEEN,
    GRAPH_SCOPE
  FROM ENTITY_NODES
`;

const ACTOR_NETWORK_EDGE_QUERY = `
  WITH PARAMS AS (
    SELECT ?::VARCHAR AS ORG_ID
  ),
  ACTORS AS (
    SELECT
      ACTOR.ORG_ID,
      ACTOR.ACTOR_NODE_KEY,
      ACTOR.ACTOR_NAME,
      ACTOR.TOTAL_CLAIM_COUNT,
      ACTOR.DOC_COUNT,
      ACTOR.SIGHTING_COUNT,
      ACTOR.MIRROR_SIGHTING_COUNT,
      ACTOR.FIRST_SEEN,
      ACTOR.LAST_SEEN
    FROM NOCTURNE.DASHBOARD.VW_THREAT_ACTORS AS ACTOR
    INNER JOIN PARAMS
      ON PARAMS.ORG_ID = ACTOR.ORG_ID
  ),
  ACTOR_CLAIM_EDGES AS (
    SELECT
      ORG_ID,
      SHA2(ORG_ID || '|' || ACTOR_NODE_KEY || '|MADE_CLAIM|actor_claim_bundle:' || ACTOR_NODE_KEY)
        AS GRAPH_EDGE_KEY,
      ACTOR_NODE_KEY AS SOURCE_KEY,
      'MADE_CLAIM' AS EDGE_TYPE,
      'actor_claim_bundle:' || ACTOR_NODE_KEY AS TARGET_KEY,
      'entity' AS SOURCE_KIND,
      'actor_alias' AS SOURCE_TYPE,
      'claim' AS TARGET_KIND,
      'claim' AS TARGET_TYPE,
      'Aggregated target-confirmed claims made by ' || ACTOR_NAME AS SAMPLE_EVIDENCE_TEXT,
      'exact' AS GROUNDING_LEVEL,
      NULL::NUMBER AS EVIDENCE_START,
      NULL::NUMBER AS EVIDENCE_END,
      NULL::VARCHAR AS SELECTED_WINDOW_ID,
      TOTAL_CLAIM_COUNT AS MENTION_COUNT,
      SIGHTING_COUNT,
      DOC_COUNT,
      MIRROR_SIGHTING_COUNT,
      FIRST_SEEN,
      LAST_SEEN,
      'target_incident' AS GRAPH_SCOPE
    FROM ACTORS
  ),
  ACTOR_TARGET_EDGES AS (
    SELECT
      CLAIM_EDGE.ORG_ID,
      SHA2(
        CLAIM_EDGE.ORG_ID
          || '|actor_claim_bundle:'
          || CLAIM_EDGE.SOURCE_KEY
          || '|ALLEGEDLY_AFFECTS|'
          || AFFECTS_EDGE.TARGET_KEY
      ) AS GRAPH_EDGE_KEY,
      'actor_claim_bundle:' || CLAIM_EDGE.SOURCE_KEY AS SOURCE_KEY,
      'ALLEGEDLY_AFFECTS' AS EDGE_TYPE,
      AFFECTS_EDGE.TARGET_KEY,
      'claim' AS SOURCE_KIND,
      'claim' AS SOURCE_TYPE,
      AFFECTS_EDGE.TARGET_KIND,
      AFFECTS_EDGE.TARGET_TYPE,
      LEFT(MAX(AFFECTS_EDGE.SAMPLE_EVIDENCE_TEXT), 1200) AS SAMPLE_EVIDENCE_TEXT,
      MODE(AFFECTS_EDGE.GROUNDING_LEVEL) AS GROUNDING_LEVEL,
      MAX(AFFECTS_EDGE.EVIDENCE_START) AS EVIDENCE_START,
      MAX(AFFECTS_EDGE.EVIDENCE_END) AS EVIDENCE_END,
      MODE(AFFECTS_EDGE.SELECTED_WINDOW_ID) AS SELECTED_WINDOW_ID,
      SUM(AFFECTS_EDGE.MENTION_COUNT) AS MENTION_COUNT,
      SUM(AFFECTS_EDGE.SIGHTING_COUNT) AS SIGHTING_COUNT,
      SUM(AFFECTS_EDGE.DOC_COUNT) AS DOC_COUNT,
      SUM(AFFECTS_EDGE.MIRROR_SIGHTING_COUNT) AS MIRROR_SIGHTING_COUNT,
      MIN(AFFECTS_EDGE.FIRST_SEEN) AS FIRST_SEEN,
      MAX(AFFECTS_EDGE.LAST_SEEN) AS LAST_SEEN,
      'target_incident' AS GRAPH_SCOPE
    FROM NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_EDGES AS CLAIM_EDGE
    INNER JOIN NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_EDGES AS AFFECTS_EDGE
      ON AFFECTS_EDGE.ORG_ID = CLAIM_EDGE.ORG_ID
      AND AFFECTS_EDGE.SOURCE_KEY = CLAIM_EDGE.TARGET_KEY
      AND AFFECTS_EDGE.EDGE_TYPE = 'ALLEGEDLY_AFFECTS'
      AND AFFECTS_EDGE.TARGET_TYPE IN ('organization', 'domain')
    INNER JOIN PARAMS
      ON PARAMS.ORG_ID = CLAIM_EDGE.ORG_ID
    WHERE CLAIM_EDGE.EDGE_TYPE = 'MADE_CLAIM'
      AND CLAIM_EDGE.SOURCE_TYPE = 'actor_alias'
      AND CLAIM_EDGE.TARGET_TYPE = 'claim'
    GROUP BY
      CLAIM_EDGE.ORG_ID,
      CLAIM_EDGE.SOURCE_KEY,
      AFFECTS_EDGE.TARGET_KEY,
      AFFECTS_EDGE.TARGET_KIND,
      AFFECTS_EDGE.TARGET_TYPE
  ),
  ACTOR_MARKETPLACE_EDGES AS (
    SELECT
      LISTED_EDGE.ORG_ID,
      SHA2(LISTED_EDGE.ORG_ID || '|' || LISTED_EDGE.SOURCE_KEY || '|LISTED_ON|' || LISTED_EDGE.TARGET_KEY)
        AS GRAPH_EDGE_KEY,
      LISTED_EDGE.SOURCE_KEY,
      'LISTED_ON' AS EDGE_TYPE,
      LISTED_EDGE.TARGET_KEY,
      LISTED_EDGE.SOURCE_KIND,
      LISTED_EDGE.SOURCE_TYPE,
      LISTED_EDGE.TARGET_KIND,
      LISTED_EDGE.TARGET_TYPE,
      LEFT(MAX(LISTED_EDGE.SAMPLE_EVIDENCE_TEXT), 1200) AS SAMPLE_EVIDENCE_TEXT,
      MODE(LISTED_EDGE.GROUNDING_LEVEL) AS GROUNDING_LEVEL,
      MAX(LISTED_EDGE.EVIDENCE_START) AS EVIDENCE_START,
      MAX(LISTED_EDGE.EVIDENCE_END) AS EVIDENCE_END,
      MODE(LISTED_EDGE.SELECTED_WINDOW_ID) AS SELECTED_WINDOW_ID,
      SUM(LISTED_EDGE.MENTION_COUNT) AS MENTION_COUNT,
      SUM(LISTED_EDGE.SIGHTING_COUNT) AS SIGHTING_COUNT,
      SUM(LISTED_EDGE.DOC_COUNT) AS DOC_COUNT,
      SUM(LISTED_EDGE.MIRROR_SIGHTING_COUNT) AS MIRROR_SIGHTING_COUNT,
      MIN(LISTED_EDGE.FIRST_SEEN) AS FIRST_SEEN,
      MAX(LISTED_EDGE.LAST_SEEN) AS LAST_SEEN,
      'target_incident' AS GRAPH_SCOPE
    FROM NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_EDGES AS LISTED_EDGE
    INNER JOIN PARAMS
      ON PARAMS.ORG_ID = LISTED_EDGE.ORG_ID
    WHERE LISTED_EDGE.EDGE_TYPE = 'LISTED_ON'
      AND LISTED_EDGE.SOURCE_TYPE = 'actor_alias'
      AND LISTED_EDGE.TARGET_TYPE = 'marketplace'
    GROUP BY
      LISTED_EDGE.ORG_ID,
      LISTED_EDGE.SOURCE_KEY,
      LISTED_EDGE.TARGET_KEY,
      LISTED_EDGE.SOURCE_KIND,
      LISTED_EDGE.SOURCE_TYPE,
      LISTED_EDGE.TARGET_KIND,
      LISTED_EDGE.TARGET_TYPE
  )
  SELECT
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
    TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS FIRST_SEEN,
    TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS LAST_SEEN,
    GRAPH_SCOPE
  FROM ACTOR_CLAIM_EDGES

  UNION ALL

  SELECT
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
    TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS FIRST_SEEN,
    TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS LAST_SEEN,
    GRAPH_SCOPE
  FROM ACTOR_TARGET_EDGES

  UNION ALL

  SELECT
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
    TO_VARCHAR(FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS FIRST_SEEN,
    TO_VARCHAR(LAST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS LAST_SEEN,
    GRAPH_SCOPE
  FROM ACTOR_MARKETPLACE_EDGES
`;

const PIPELINE_REJECTION_COLUMNS = `
  ORG_ID,
  ELEMENT_KIND,
  VALIDATION_REASON,
  REJECTED_COUNT
`;

const PIPELINE_CACHE_COLUMNS = `
  ORG_ID,
  STAGE,
  CACHE_ROWS,
  SUCCESS_ROWS,
  ERROR_ROWS,
  MISSING_CANDIDATES,
  TO_VARCHAR(
    LAST_CALLED_AT,
    'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'
  ) AS LAST_CALLED_AT
`;

const PIPELINE_DRIFT_COLUMNS = `
  ORG_ID,
  STAGE,
  BASELINE_VERSION,
  EXPECTED_VERSION,
  CURRENT_VERSION,
  ROWS_BEHIND
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

type PipelineCacheStageRow = PipelineAiCacheStage & { orgId: string };

function rowField(row: SnowflakeRow, ...names: string[]): unknown {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  const entries = Object.entries(row);
  for (const name of names) {
    const match = entries.find(([key]) => key.toUpperCase() === name.toUpperCase());
    if (match) return match[1];
  }
  return undefined;
}

function pipelineStageLabel(stage: AiStage): string {
  switch (stage) {
    case "relationship":
      return "Relationship";
    case "l2_extraction":
      return "L2 extraction";
    case "leak_type":
      return "Leak type";
    case "incident_insight":
      return "Incident insight";
  }
}

function rejectionLabel(reason: string): string {
  return reason
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function rejectionSeverity(reason: string): RejectionReason["severity"] {
  if (reason === "unmatched_evidence") return "critical";
  if (
    reason.includes("endpoint")
    || reason.includes("combination")
    || reason.includes("source")
    || reason.includes("target")
  ) {
    return "high";
  }
  if (reason.includes("cap")) return "low";
  return "medium";
}

function aggregateRejectionReasons(rows: SnowflakeRow[]): RejectionReason[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = stringValue(row.VALIDATION_REASON, "unknown");
    counts.set(reason, (counts.get(reason) ?? 0) + numberValue(row.REJECTED_COUNT));
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({
      reason,
      label: rejectionLabel(reason),
      count,
      severity: rejectionSeverity(reason),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function mapCacheStage(row: SnowflakeRow): PipelineCacheStageRow {
  return {
    orgId: stringValue(row.ORG_ID),
    stage: stringValue(row.STAGE) as AiStage,
    cacheRows: numberValue(row.CACHE_ROWS),
    successRows: numberValue(row.SUCCESS_ROWS),
    errorRows: numberValue(row.ERROR_ROWS),
    missingCandidates: numberValue(row.MISSING_CANDIDATES),
    lastCalledAt: nullableString(row.LAST_CALLED_AT),
  };
}

function aggregateCacheStages(rows: SnowflakeRow[]): PipelineCacheStageRow[] {
  const byStage = new Map<AiStage, PipelineCacheStageRow>();
  for (const row of rows.map(mapCacheStage)) {
    const current = byStage.get(row.stage);
    if (!current) {
      byStage.set(row.stage, { ...row, orgId: "fleet" });
      continue;
    }
    current.cacheRows += row.cacheRows;
    current.successRows += row.successRows;
    current.errorRows += row.errorRows;
    current.missingCandidates += row.missingCandidates;
    current.lastCalledAt = latestTimestamp([current.lastCalledAt, row.lastCalledAt]);
  }
  return [...byStage.values()].sort((a, b) =>
    pipelineStageLabel(a.stage).localeCompare(pipelineStageLabel(b.stage)),
  );
}

function summarizeCache(stages: PipelineAiCacheStage[]): PipelineCacheSummary {
  return {
    cacheRows: stages.reduce((total, stage) => total + stage.cacheRows, 0),
    successRows: stages.reduce((total, stage) => total + stage.successRows, 0),
    errorRows: stages.reduce((total, stage) => total + stage.errorRows, 0),
    missingCandidates: stages.reduce(
      (total, stage) => total + stage.missingCandidates,
      0,
    ),
    repeatCallsAvoided: stages.reduce(
      (total, stage) => total + stage.successRows,
      0,
    ),
  };
}

function aggregateVersionDrift(rows: SnowflakeRow[]): VersionDrift[] {
  const byStage = new Map<string, {
    baselineVersion: string | null;
    currentVersions: Set<string>;
    expectedVersion: string;
    rowsBehind: number;
  }>();

  for (const row of rows) {
    const stage = stringValue(row.STAGE);
    const current = byStage.get(stage);
    const currentVersion = stringValue(row.CURRENT_VERSION);
    if (!current) {
      byStage.set(stage, {
        baselineVersion: nullableString(row.BASELINE_VERSION),
        currentVersions: new Set([currentVersion]),
        expectedVersion: stringValue(row.EXPECTED_VERSION, currentVersion),
        rowsBehind: numberValue(row.ROWS_BEHIND),
      });
    } else {
      current.currentVersions.add(currentVersion);
      current.rowsBehind += numberValue(row.ROWS_BEHIND);
    }
  }

  return [...byStage.entries()].map(([stage, value]) => {
    const versions = [...value.currentVersions].filter(Boolean);
    return {
      stage,
      baselineVersion: value.baselineVersion,
      currentVersion: versions.length <= 1
        ? versions[0] ?? value.expectedVersion
        : "mixed",
      rowsBehind: value.rowsBehind,
    };
  });
}

function normalizeTaskState(
  state: string,
  trigger: TaskHealth["trigger"],
): TaskHealth["state"] {
  const normalized = state.toLowerCase();
  if (normalized.includes("suspend")) return "suspended";
  if (normalized.includes("fail")) return "failed";
  if (normalized.includes("queue")) return "queued";
  if (normalized.includes("start") || normalized.includes("run")) {
    return trigger === "stream" ? "idle" : "running";
  }
  return "idle";
}

function taskLastRunAt(row: SnowflakeRow, fallback: string | null): string | null {
  return nullableString(
    rowField(
      row,
      "last_committed_on",
      "LAST_COMMITTED_ON",
      "last_run_at",
      "LAST_RUN_AT",
      "completed_time",
      "COMPLETED_TIME",
      "scheduled_time",
      "SCHEDULED_TIME",
    ),
  ) ?? fallback;
}

const AI_TASK_STAGE: Record<string, AiStage | null> = {
  RELATIONSHIP_AI_TASK: "relationship",
  L2_EXTRACTION_AI_TASK: "l2_extraction",
  LEAK_TYPE_AI_TASK: "leak_type",
  INCIDENT_INSIGHT_AI_TASK: "incident_insight",
  CRAWL_INGEST_TASK: null,
  INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK: null,
};

function defaultTasks(cacheStages: PipelineAiCacheStage[]): TaskHealth[] {
  const byStage = new Map(cacheStages.map((stage) => [stage.stage, stage]));
  return Object.entries(AI_TASK_STAGE).map(([taskName, stage]) => ({
    taskName,
    trigger: taskName === "CRAWL_INGEST_TASK" || taskName === "INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK"
      ? "schedule"
      : "stream",
    scheduleLabel: taskName === "CRAWL_INGEST_TASK" || taskName === "INCIDENT_INSIGHT_CANDIDATE_DISCOVERY_TASK"
      ? "5 min"
      : null,
    state: "idle",
    lastRunAt: stage ? byStage.get(stage)?.lastCalledAt ?? null : null,
    pendingCandidates: stage ? byStage.get(stage)?.missingCandidates ?? 0 : null,
    errorCount: stage ? byStage.get(stage)?.errorRows ?? 0 : 0,
  }));
}

function mapTaskRows(
  rows: SnowflakeRow[],
  cacheStages: PipelineAiCacheStage[],
): TaskHealth[] {
  if (rows.length === 0) return defaultTasks(cacheStages);

  const byStage = new Map(cacheStages.map((stage) => [stage.stage, stage]));
  const tasks = rows
    .map((row) => {
      const taskName = stringValue(rowField(row, "name", "task_name", "NAME", "TASK_NAME"));
      const stage = AI_TASK_STAGE[taskName];
      if (stage === undefined) return null;
      const condition = nullableString(rowField(row, "condition", "CONDITION"));
      const schedule = nullableString(rowField(row, "schedule", "SCHEDULE"));
      const trigger: TaskHealth["trigger"] = condition ? "stream" : "schedule";
      const cacheStage = stage ? byStage.get(stage) : undefined;
      return {
        taskName,
        trigger,
        scheduleLabel: trigger === "schedule" ? schedule ?? "manual" : null,
        state: normalizeTaskState(
          stringValue(rowField(row, "state", "STATE"), "idle"),
          trigger,
        ),
        lastRunAt: taskLastRunAt(row, cacheStage?.lastCalledAt ?? null),
        pendingCandidates: stage ? cacheStage?.missingCandidates ?? 0 : null,
        errorCount: stage ? cacheStage?.errorRows ?? 0 : 0,
      };
    })
    .filter((task): task is TaskHealth => task !== null);

  return tasks.length ? tasks : defaultTasks(cacheStages);
}

function aggregatePipelineHealth(
  organizations: CommandCenterOrganizationSnapshot[],
  cacheStages: PipelineCacheStageRow[],
): PipelineResponse["health"] {
  return organizations.map((organization) => {
    const orgCache = cacheStages.filter((stage) => stage.orgId === organization.orgId);
    const backlogCount = orgCache.reduce(
      (total, stage) => total + stage.missingCandidates,
      0,
    );
    const aiErrorCount = organization.metrics.downstreamAiErrorCount
      + orgCache.reduce((total, stage) => total + stage.errorRows, 0);
    const groundingRate = organization.metrics.grounding.rate;
    const status: PipelineResponse["health"][number]["status"] = aiErrorCount > 0
      ? "degraded"
      : backlogCount > 0
        ? "lagging"
        : "healthy";
    return {
      orgId: organization.orgId,
      organizationName: organization.organizationName,
      lastIngestAt: organization.lastUpdatedAt,
      groundingRate,
      quarantinedCount: organization.metrics.grounding.quarantinedCount,
      totalExtractedCount: organization.metrics.grounding.totalExtractedClaims,
      aiErrorCount,
      backlogCount,
      status,
    };
  });
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
    const isSingleIncidentGraph = view === "incident" && Boolean(incidentKey);
    const rootClause = incidentKey ? " AND INCIDENT_KEY = ?" : "";
    const rootBinds: Binds = incidentKey ? [orgId, incidentKey] : [orgId];
    const [countRows, rootRows] = await Promise.all([
      executeQuery(
        `SELECT COUNT(*) AS INCIDENT_COUNT
         FROM NOCTURNE.DASHBOARD.VW_INCIDENTS
         WHERE ORG_ID = ?`,
        [orgId],
      ),
      isSingleIncidentGraph
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

    if (isSingleIncidentGraph && rootRows.length === 0) return null;

    const rootRow = rootRows[0];
    const selectedIncidentKey = rootRow
      ? stringValue(rootRow.INCIDENT_KEY)
      : null;
    if (view === "actors") {
      const [nodeRows, edgeRows] = await Promise.all([
        executeQuery(
          `${ACTOR_NETWORK_NODE_QUERY}
           ORDER BY IS_MONITORED_ORG DESC, NODE_TYPE, DISPLAY_NAME, NODE_KEY`,
          [orgId],
        ),
        executeQuery(
          `${ACTOR_NETWORK_EDGE_QUERY}
           ORDER BY FIRST_SEEN, EDGE_TYPE, SOURCE_KEY, TARGET_KEY`,
          [orgId],
        ),
      ]);

      return {
        scope,
        view,
        rootKey: null,
        rootIncident: null,
        incidentCount: numberValue(countRows[0]?.INCIDENT_COUNT),
        nodes: nodeRows.map(mapKnowledgeGraphNode),
        edges: edgeRows.map(mapKnowledgeGraphEdge),
        fetchedAt: new Date().toISOString(),
      };
    }

    const isOrgWideGraph = !isSingleIncidentGraph;
    const nodeView = isOrgWideGraph
      ? "NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_NODES"
      : "NOCTURNE.DASHBOARD.VW_INCIDENT_GRAPH_NODES";
    const edgeView = isOrgWideGraph
      ? "NOCTURNE.DASHBOARD.VW_KNOWLEDGE_GRAPH_EDGES"
      : "NOCTURNE.DASHBOARD.VW_INCIDENT_GRAPH_EDGES";
    const graphClause = isOrgWideGraph
      ? "WHERE ORG_ID = ?"
      : "WHERE ORG_ID = ? AND INCIDENT_KEY = ?";
    const graphBinds: Binds = isOrgWideGraph
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

  async getPipeline(scope: DataScope): Promise<PipelineResponse> {
    const filter = scopeFilter(scope);
    const [
      summaryRows,
      rejectionRows,
      cacheRows,
      driftRows,
      taskRows,
    ] = await Promise.all([
      executeQuery(
        `SELECT ${SUMMARY_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_COMMAND_CENTER${filter.clause}
         ORDER BY ORG_ID`,
        filter.binds,
      ),
      optionalDashboardQuery(
        "pipeline rejection reasons",
        `SELECT ${PIPELINE_REJECTION_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_PIPELINE_REJECTION_REASONS${filter.clause}
         ORDER BY REJECTED_COUNT DESC, VALIDATION_REASON`,
        filter.binds,
      ),
      optionalDashboardQuery(
        "pipeline AI cache health",
        `SELECT ${PIPELINE_CACHE_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_PIPELINE_AI_CACHE_HEALTH${filter.clause}
         ORDER BY ORG_ID, STAGE`,
        filter.binds,
      ),
      optionalDashboardQuery(
        "pipeline version drift",
        `SELECT ${PIPELINE_DRIFT_COLUMNS}
         FROM NOCTURNE.DASHBOARD.VW_PIPELINE_VERSION_DRIFT${filter.clause}
         ORDER BY ORG_ID, STAGE`,
        filter.binds,
      ),
      executeQuery("SHOW TASKS IN SCHEMA NOCTURNE.RAW").catch(() => []),
    ]);

    const organizations = summaryRows.map(mapOrganization);
    const totals = aggregateMetrics(organizations, []);
    const orgCacheStages = cacheRows.map(mapCacheStage);
    const cacheStagesWithOrg = scope.kind === "fleet"
      ? aggregateCacheStages(cacheRows)
      : orgCacheStages.sort((a, b) =>
          pipelineStageLabel(a.stage).localeCompare(pipelineStageLabel(b.stage)),
        );
    const cacheStages = cacheStagesWithOrg.map(({ orgId: _orgId, ...stage }) => stage);
    const relevance = totals.pipeline.pagesRelevanceChecked || 0;
    const extracted = totals.pipeline.pagesEvidenceExtracted || 0;

    return {
      scope,
      organizations: organizations.map((organization) => ({
        orgId: organization.orgId,
        organizationName: organization.organizationName,
        lastUpdatedAt: organization.lastUpdatedAt,
      })),
      cascade: buildCascade(totals),
      grounding: totals.grounding,
      deepAnalysisRate: relevance === 0
        ? 0
        : Number(((100 * extracted) / relevance).toFixed(1)),
      cacheSummary: summarizeCache(cacheStages),
      cacheStages,
      rejectionReasons: aggregateRejectionReasons(rejectionRows),
      versionDrift: aggregateVersionDrift(driftRows),
      health: aggregatePipelineHealth(organizations, orgCacheStages),
      tasks: mapTaskRows(taskRows, cacheStages),
      lastUpdatedAt: latestTimestamp(
        organizations.map((organization) => organization.lastUpdatedAt),
      ),
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

const snowflakeBackend: NocturneBackend = new SnowflakeNocturneBackend();

/**
 * Tenants this console is configured for.
 *
 * MONITORED_ORGANIZATIONS accumulates rows from earlier crawls and experiments,
 * and VW_INCIDENTS joins it unconditionally — so a retired target keeps
 * appearing in fleet views with all of its historical incidents. Filtering to
 * the console's own registry hides them without deleting warehouse data, which
 * would take the incident history with it. Onboarding a tenant means adding it
 * to src/mocks/organizations.ts, the same place its login comes from.
 */
const CONSOLE_TENANT_IDS = new Set(consoleTenants.map((tenant) => tenant.orgId));

function isConsoleTenant(row: { orgId: string }): boolean {
  return CONSOLE_TENANT_IDS.has(row.orgId);
}

/**
 * Fleet response with retired tenants removed and the demo tenant folded in.
 *
 * Totals and the cascade are recomputed from the surviving rows rather than
 * carried over, so the header cannot disagree with the table beneath it.
 */
async function fleetCommandCenter(
  scope: DataScope,
  include?: ReadonlySet<string>,
): Promise<CommandCenterResponse> {
  const live = await snowflakeBackend.getCommandCenter(scope);
  const demo = getDemoCommandCenter();

  // The demo tenant's figures are fabricated, so it is opt-in: leaving it in
  // by default would put invented incidents into the fleet totals a reviewer
  // reads as real.
  const selected = (row: { orgId: string }) =>
    include ? include.has(row.orgId) : row.orgId !== DEMO_ORG_ID;

  const organizations = [
    ...live.organizations.filter(isConsoleTenant),
    ...demo.organizations,
  ].filter(selected);
  const incidents = [...live.incidents.filter(isConsoleTenant), ...demo.incidents]
    .filter(selected)
    .sort((a, b) => (b.triagePriorityScore ?? -1) - (a.triagePriorityScore ?? -1));
  const totals = aggregateMetrics(organizations, incidents);

  return {
    ...live,
    organizations,
    totals,
    cascade: buildCascade(totals),
    incidents,
  };
}



/**
 * One dispatch point for the synthetic demo tenant.
 *
 * Routing here rather than in each API route means a new route cannot forget
 * the check, and — more importantly — cannot accidentally apply it too widely:
 * `isDemoScope` is true only for an org-scoped request against DEMO_ORG_ID, so
 * fleet scope and every real tenant still reach Snowflake. See demo-backend.ts.
 */
export const nocturneBackend: NocturneBackend = {
  getCommandCenter(scope, include) {
    if (isDemoScope(scope)) return Promise.resolve(getDemoCommandCenter());
    if (scope.kind === "fleet") return fleetCommandCenter(scope, include);
    return snowflakeBackend.getCommandCenter(scope);
  },
  async getBreachMonitor(scope, access, include) {
    if (isDemoScope(scope)) return getDemoBreachMonitor();
    const live = await snowflakeBackend.getBreachMonitor(scope, access);
    if (scope.kind !== "fleet") return live;

    // Same rule as the command centre: honour an explicit selection, and leave
    // the fabricated demo tenant out when there is none.
    const selected = (row: { orgId: string }) =>
      include ? include.has(row.orgId) : row.orgId !== DEMO_ORG_ID;

    const demo = getDemoBreachMonitor();
    const rows = [...live.rows.filter(isConsoleTenant), ...demo.rows].filter(selected);
    const confirmed = rows.filter((row) => row.monitorStatus === "confirmed_yours");
    return {
      ...live,
      rows,
      summary: {
        totalRows: rows.length,
        confirmedLeaks: confirmed.length,
        recordsClaimed: confirmed.reduce((sum, r) => sum + (r.quantityClaimed ?? 0), 0),
        exposedDataClassCount: new Set(confirmed.flatMap((r) => r.leakTypes)).size,
        needsReview: rows.filter((r) => r.monitorStatus === "needs_review").length,
        anotherCompany: rows.filter((r) => r.monitorStatus === "another_company").length,
      },
    };
  },
  getIncidentDetail(scope, incidentKey) {
    if (isDemoScope(scope)) return Promise.resolve(getDemoIncidentDetail(incidentKey));
    return snowflakeBackend.getIncidentDetail(scope, incidentKey);
  },
  getKnowledgeGraph(scope, view, incidentKey) {
    if (isDemoScope(scope)) return Promise.resolve(getDemoKnowledgeGraph(view, incidentKey));
    return snowflakeBackend.getKnowledgeGraph(scope, view, incidentKey);
  },
  getThreatActors(scope) {
    if (isDemoScope(scope)) return Promise.resolve(getDemoThreatActors());
    return snowflakeBackend.getThreatActors(scope);
  },
  async getPipeline(scope) {
    if (isDemoScope(scope)) return getDemoPipeline();
    const live = await snowflakeBackend.getPipeline(scope);
    if (scope.kind !== "fleet") return live;
    return {
      ...live,
      organizations: live.organizations.filter(isConsoleTenant),
      health: live.health.filter((row) => row.orgId === null || isConsoleTenant({ orgId: row.orgId })),
    };
  },
};

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
  if (isDemoScope(scope)) return [getDemoMonitoredOrganization()];
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
  // The demo tenant has no warehouse row to write. Echo the edit back so the
  // form round-trips, without pretending it was persisted anywhere.
  if (orgId === DEMO_ORG_ID) {
    return { ...getDemoMonitoredOrganization(), ...update, orgId: DEMO_ORG_ID };
  }
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

/* ── user profiles ─────────────────────────────────────────────────────────── */

const USER_PROFILE_COLUMNS = `
  USERNAME,
  DISPLAY_NAME,
  EMAIL,
  POSITION,
  ALERT_BANDS,
  WEEKLY_DIGEST,
  TO_VARCHAR(UPDATED_AT, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS UPDATED_AT
`;

const MAX_DISPLAY_NAME = 80;
const MAX_EMAIL = 254;
const MAX_POSITION = 80;
// Deliberately permissive: the goal is to catch a typo, not to adjudicate
// RFC 5322. Anything with one @ and a dotted domain passes.
const EMAIL_PATTERN = /^[^\s@]{1,64}@(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

function mapUserProfile(row: SnowflakeRow): UserProfileRecord {
  return {
    username: stringValue(row.USERNAME),
    displayName: nullableString(row.DISPLAY_NAME),
    email: nullableString(row.EMAIL),
    position: nullableString(row.POSITION),
    // NULL means never configured; fall back to the default rather than
    // silently treating an unconfigured account as "alerts off".
    alertBands:
      row.ALERT_BANDS === null || row.ALERT_BANDS === undefined
        ? [...DEFAULT_ALERT_BANDS]
        : (stringArray(row.ALERT_BANDS).filter(isSeverityBand) as SeverityBand[]),
    weeklyDigest:
      row.WEEKLY_DIGEST === null || row.WEEKLY_DIGEST === undefined
        ? true
        : booleanValue(row.WEEKLY_DIGEST),
    updatedAt: nullableString(row.UPDATED_AT),
  };
}

/** Loud severities only. Nobody wants an email for an informational row. */
export const DEFAULT_ALERT_BANDS: SeverityBand[] = ["critical", "high"];

/** The same defaults as a Snowflake array literal, built from the list above. */
const DEFAULT_ALERT_BANDS_SQL = `ARRAY_CONSTRUCT(${DEFAULT_ALERT_BANDS.map(
  (band) => `'${band}'`,
).join(", ")})`;
const SEVERITY_BANDS: SeverityBand[] = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
];

function isSeverityBand(value: string): value is SeverityBand {
  return (SEVERITY_BANDS as string[]).includes(value);
}

/** Trims, and treats an all-whitespace field as "cleared" rather than "  ". */
function optionalText(
  value: unknown,
  label: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new ConfigValidationError(`${label} must be text.`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new ConfigValidationError(
      `${label} must be ${maxLength} characters or fewer.`,
    );
  }
  return trimmed;
}

export function normalizeUserProfileUpdate(input: unknown): UserProfileUpdate {
  if (!input || typeof input !== "object") {
    throw new ConfigValidationError("A JSON object body is required.");
  }
  const body = input as Record<string, unknown>;

  // Display name is the one required field — it is what the sidebar renders,
  // and an empty one would leave the account visually anonymous.
  const displayName = optionalText(body.displayName, "Display name", MAX_DISPLAY_NAME);
  if (!displayName) {
    throw new ConfigValidationError("Display name cannot be empty.");
  }

  const email = optionalText(body.email, "Email", MAX_EMAIL);
  if (email && !EMAIL_PATTERN.test(email)) {
    throw new ConfigValidationError(`"${email}" is not a valid email address.`);
  }

  const rawBands = body.alertBands;
  if (!Array.isArray(rawBands)) {
    throw new ConfigValidationError("`alertBands` must be an array.");
  }
  const alertBands = rawBands.map((band) => {
    if (typeof band !== "string" || !isSeverityBand(band)) {
      throw new ConfigValidationError(`"${String(band)}" is not a severity band.`);
    }
    return band;
  });

  if (typeof body.weeklyDigest !== "boolean") {
    throw new ConfigValidationError("`weeklyDigest` must be true or false.");
  }

  // An alert with nowhere to go is a silent failure, so make it a loud one.
  if (alertBands.length > 0 && !email) {
    throw new ConfigValidationError(
      "Add an email address before enabling breach alerts.",
    );
  }

  return {
    displayName,
    email,
    position: optionalText(body.position, "Position", MAX_POSITION),
    alertBands: [...new Set(alertBands)],
    weeklyDigest: body.weeklyDigest,
  };
}

export async function getUserProfile(
  username: string,
): Promise<UserProfileRecord | null> {
  const rows = await executeQuery(
    `SELECT ${USER_PROFILE_COLUMNS}
     FROM NOCTURNE.CONFIG.USER_PROFILES
     WHERE USERNAME = ?`,
    [username],
  );
  return rows.length ? mapUserProfile(rows[0]!) : null;
}

/**
 * Upsert, because a profile row only exists once someone has saved one. The
 * username is bound, never interpolated, and is taken from the signed session
 * by the caller — a user can only ever write their own row.
 */
export async function saveUserProfile(
  username: string,
  update: UserProfileUpdate,
): Promise<UserProfileRecord | null> {
  await executeQuery(
    `MERGE INTO NOCTURNE.CONFIG.USER_PROFILES AS target
     USING (SELECT ? AS USERNAME) AS source
       ON target.USERNAME = source.USERNAME
     WHEN MATCHED THEN UPDATE SET
       DISPLAY_NAME = ?,
       EMAIL = ?,
       POSITION = ?,
       ALERT_BANDS = CAST(PARSE_JSON(?) AS ARRAY),
       WEEKLY_DIGEST = ?,
       UPDATED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN
       INSERT (USERNAME, DISPLAY_NAME, EMAIL, POSITION, ALERT_BANDS, WEEKLY_DIGEST)
       VALUES (source.USERNAME, ?, ?, ?, CAST(PARSE_JSON(?) AS ARRAY), ?)`,
    [
      username,
      update.displayName,
      update.email,
      update.position,
      JSON.stringify(update.alertBands),
      update.weeklyDigest,
      update.displayName,
      update.email,
      update.position,
      JSON.stringify(update.alertBands),
      update.weeklyDigest,
    ],
  );
  return getUserProfile(username);
}

/* ── breach alert dispatch ─────────────────────────────────────────────────── */

/**
 * Incidents that someone has asked to be emailed about and that have not been
 * emailed to them yet.
 *
 * The anti-join against ALERT_DELIVERIES is what makes re-running the sweep
 * safe: an incident already delivered to a user simply does not come back. The
 * join to USER_PROFILES is an inner join on a non-null email, so a user with
 * alerts on but no address is excluded here rather than failing later.
 *
 * `lookbackHours` stops a first run from emailing the entire history — the
 * cold-start case where the deliveries table is empty and every incident ever
 * raised would otherwise qualify.
 */
export async function findPendingAlerts(
  lookbackHours: number,
): Promise<PendingAlert[]> {
  const rows = await executeQuery(
    `SELECT
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
       TO_VARCHAR(i.FIRST_SEEN, 'YYYY-MM-DD"T"HH24:MI:SSTZH:TZM') AS FIRST_SEEN,
       p.USERNAME,
       p.EMAIL,
       COALESCE(p.DISPLAY_NAME, p.USERNAME) AS DISPLAY_NAME
     FROM NOCTURNE.DASHBOARD.VW_INCIDENTS i
     JOIN NOCTURNE.CONFIG.USER_PROFILES p
       ON p.EMAIL IS NOT NULL
      -- NULL means never configured. The settings UI shows the same defaults
      -- as enabled, so the dispatcher has to honour them or the switches would
      -- promise alerts that never send.
      AND ARRAY_CONTAINS(
            i.IMPACT_SEVERITY_BAND::VARIANT,
            COALESCE(p.ALERT_BANDS, ${DEFAULT_ALERT_BANDS_SQL})
          )
     LEFT JOIN NOCTURNE.CONFIG.ALERT_DELIVERIES d
       ON d.INCIDENT_KEY = i.INCIDENT_KEY
      AND d.USERNAME = p.USERNAME
     WHERE d.INCIDENT_KEY IS NULL
       AND i.L2_ROUTE = 'target_confirmed'
       AND i.FIRST_SEEN >= DATEADD(hour, -?, CURRENT_TIMESTAMP())
       AND (p.USERNAME = i.ORG_ID OR p.USERNAME = 'admin')
     ORDER BY i.IMPACT_SEVERITY_SCORE DESC NULLS LAST, i.INCIDENT_KEY`,
    [lookbackHours],
  );

  return rows.map((row) => ({
    incidentKey: stringValue(row.INCIDENT_KEY),
    orgId: stringValue(row.ORG_ID),
    organizationName: stringValue(row.ORGANIZATION_NAME),
    title: stringValue(row.TOP_TITLE),
    sourceUrl: stringValue(row.TOP_URL),
    severityBand: stringValue(row.IMPACT_SEVERITY_BAND) as SeverityBand,
    severityScore: nullableNumber(row.IMPACT_SEVERITY_SCORE),
    firstSeen: nullableString(row.FIRST_SEEN),
    username: stringValue(row.USERNAME),
    email: stringValue(row.EMAIL),
    displayName: stringValue(row.DISPLAY_NAME),
    leakTypes: stringArray(row.LEAK_TYPE_LABELS) as LeakType[],
    quantityClaimed: nullableNumber(row.QUANTITY_CLAIMED),
    evidenceConfidenceScore: nullableNumber(row.EVIDENCE_CONFIDENCE_SCORE),
    triagePriorityScore: nullableNumber(row.TRIAGE_PRIORITY_SCORE),
    actorName: nullableString(row.ACTOR_NAME),
    insightHeadline: nullableString(row.INSIGHT_HEADLINE),
    executiveSummary: nullableString(row.EXECUTIVE_SUMMARY),
    recommendedActions: stringArray(row.RECOMMENDED_ACTIONS),
  }));
}

/**
 * Claims the right to send one alert, returning false if someone already has.
 *
 * This is the exactly-once guard and it runs *before* the mail is queued. Two
 * dispatchers racing on the same incident both reach here; the primary key
 * lets exactly one insert succeed, and the loser skips instead of sending a
 * duplicate. Claiming before queueing means the worst case is a dropped email,
 * never a repeated one — the safer direction for an alert that says "breach".
 */
export async function claimAlertDelivery(alert: PendingAlert): Promise<boolean> {
  const rows = await executeQuery(
    `INSERT INTO NOCTURNE.CONFIG.ALERT_DELIVERIES
       (INCIDENT_KEY, USERNAME, ORG_ID, EMAIL, SEVERITY_BAND)
     SELECT ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM NOCTURNE.CONFIG.ALERT_DELIVERIES
       WHERE INCIDENT_KEY = ? AND USERNAME = ?
     )`,
    [
      alert.incidentKey,
      alert.username,
      alert.orgId,
      alert.email,
      alert.severityBand,
      alert.incidentKey,
      alert.username,
    ],
  );
  // Snowflake reports affected rows as "number of rows inserted".
  const inserted = Number(
    (rows[0] as Record<string, unknown> | undefined)?.["number of rows inserted"] ?? 0,
  );
  return inserted > 0;
}

/**
 * Starts the ingestion task and reports what is queued behind it.
 *
 * EXECUTE TASK returns as soon as the task is submitted, not when it finishes,
 * so the counts below describe the state at submission — the UI says "started",
 * never "complete".
 */
export async function executePipelineRun(): Promise<{
  startedAt: string;
  task: string;
  pendingCandidates: number | null;
}> {
  await executeQuery("EXECUTE TASK NOCTURNE.RAW.CRAWL_INGEST_TASK", []);

  let pendingCandidates: number | null = null;
  try {
    const rows = await executeQuery(
      `SELECT COUNT(*) AS PENDING
       FROM NOCTURNE.RAW.DT_L1_CLASSIFICATION_INPUT`,
      [],
    );
    pendingCandidates = nullableNumber(rows[0]?.PENDING);
  } catch {
    // Informational only — a run that started is still a run that started.
  }

  return {
    startedAt: new Date().toISOString(),
    task: "CRAWL_INGEST_TASK",
    pendingCandidates,
  };
}

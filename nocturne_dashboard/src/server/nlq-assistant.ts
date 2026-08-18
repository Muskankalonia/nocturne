/**
 * Nocturne Console — NLQ Assistant (tool-calling agent loop).
 *
 * Wraps existing nocturneBackend methods as "tools" for Cortex COMPLETE.
 * The LLM decides which dashboard data to fetch based on the analyst's
 * question, then formats the results into a conversational answer.
 *
 * Security: only calls pre-built, scope-enforced backend functions.
 * No generated SQL, no direct Snowflake access, no new data path.
 */

import type { DataScope } from "@/types";
import type {
  CommandCenterResponse,
  BreachMonitorResponse,
  IncidentDetailResponse,
  ThreatActorsResponse,
  PipelineResponse,
} from "@/types/dashboard";
import { nocturneBackend } from "@/server/nocturne-backend";

if (typeof window !== "undefined") {
  throw new Error("The NLQ assistant may only run on the server.");
}

/* ── Types ─────────────────────────────────────────────────────────────────── */

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantCitation {
  type: "incident" | "actor" | "organization";
  key: string;
  label: string;
}

export interface AssistantResponse {
  answer: string;
  citations: AssistantCitation[];
  suggestedFollowUps: string[];
  toolsCalled: string[];
  latencyMs: number;
}

/* ── Tool definitions ──────────────────────────────────────────────────────── */

interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, string>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "getCommandCenter",
    description:
      "Get posture KPIs: incident counts by severity band (critical/high/medium/low/informational), total pages collected/screened/verified, top severity score, threat actor count, evidence grounding rate, pipeline cascade counts per organization.",
    parameters: {},
  },
  {
    name: "getBreachMonitor",
    description:
      "Get all breach monitor records — confirmed incidents, needs-review pages, and other-company context. Each record has: title, severity scores/bands, leak types, actor name, grounding level, discovery date, remediation status.",
    parameters: {},
  },
  {
    name: "getIncidentDetail",
    description:
      "Get full detail for one specific incident by its 64-character hex incident key. Returns: all severity/confidence/priority scores and their component vectors, grounded claims with evidence text, indicator counts, AI-generated insight (headline, executive summary, business impact, recommended actions), graph nodes and edges.",
    parameters: { incidentKey: "string — 64-character hex SHA256 incident key" },
  },
  {
    name: "getThreatActors",
    description:
      "Get threat actor credibility data: actor names, credibility scores (0-100), claim counts (total/corroborated/self-evidenced/disputed), marketplace presence, document and sighting counts, first/last seen dates.",
    parameters: {},
  },
  {
    name: "getPipeline",
    description:
      "Get pipeline health: per-organization cascade stage counts (pages collected through to incidents raised), AI cache status, task health, and any downstream errors.",
    parameters: {},
  },
];

/* ── System prompt with product knowledge ──────────────────────────────────── */

const SYSTEM_PROMPT = `You are the Nocturne Security Assistant, embedded in a dark-web breach monitoring dashboard. You help threat analysts by retrieving and presenting their LIVE data.

## CRITICAL RULES
1. ALWAYS call a tool FIRST before answering any data question. NEVER answer from memory or assumptions.
2. Present data in STRUCTURED FORMAT: use markdown tables, bullet lists, and bold numbers.
3. When you have data, show it directly — do not explain where data "could be found" or tell users to "check another page."
4. If a tool returns data, format it as a clear table or structured list with the actual values.
5. If a tool returns empty or an error, say so plainly: "No data found for X."
6. For methodology questions (how scoring works), answer directly from knowledge below without calling a tool.
7. Maximum 3 tool calls per question — prioritize the most relevant tool.
8. Never reveal raw SQL, internal implementation details, or Snowflake credentials.
9. If asked about something unrelated to security/breach monitoring, decline politely.
10. ALWAYS include a relevant page link at the end of your answer using the format: [Link text](/path)
11. NEVER say "feature request for the product team" or "not available" — the features exist, link to them.
12. ALWAYS end your response with exactly 3 contextual follow-up suggestions on a new line in this format:
[SUGGESTIONS: "first follow-up question", "second follow-up question", "third follow-up question"]
These must be directly related to what you just answered — drill-down questions, adjacent topics from the same data, or natural next steps for the analyst.

## Dashboard pages (use these links in responses)
- Command Center (posture overview): [View Command Center](/)
- Breach Monitor (all incidents list): [View Breach Monitor](/leaks)
- Knowledge Graph (visual network): [View Knowledge Graph](/graph)
- Threat Actors (actor credibility): [View Threat Actors](/actors)
- Pipeline Health: [View Pipeline](/pipeline)
- Settings / Monitored Assets: [View Settings](/settings)
- Incident Detail (for a specific incident): [View Incident](/leaks/{incidentKey})

Always include the most relevant link. For example:
- If asked about the knowledge graph → include [View Knowledge Graph](/graph)
- If asked about incidents → include [View Breach Monitor](/leaks)
- If asked about actors → include [View Threat Actors](/actors)

## TOOL CALL FORMAT
When you need data, emit exactly this format (nothing else in the message):
[TOOL_CALL: toolName({"arg": "value"})]

For tools with no parameters:
[TOOL_CALL: getBreachMonitor({})]

## Available tools
- getCommandCenter — posture KPIs, incident counts, pipeline cascade counts
- getBreachMonitor — all breach records with severity, leak types, actors, dates
- getIncidentDetail — full detail for one incident (needs incidentKey parameter)
- getThreatActors — actor credibility scores, claim history, marketplaces
- getPipeline — pipeline health and cascade stage counts

## When to call which tool
- "incidents", "breaches", "leaks", "data leak" → getBreachMonitor
- "posture", "overview", "how many incidents", "KPIs" → getCommandCenter
- specific incident by key → getIncidentDetail
- "actors", "threat actors", "who", "credibility" → getThreatActors
- "pipeline", "stages", "health", "cascade" → getPipeline
- "knowledge graph", "graph", "relationships", "entities" → getBreachMonitor (graph data is derived from breach data)

## Response formatting rules
- Use markdown tables for ANY list of items (incidents, actors, stages)
- Use **bold** for scores, counts, and key values
- Use bullet points for details about a single item
- Always include actual numbers/values from the tool results — never say "check the dashboard"

## Product methodology knowledge (answer directly without tool calls)

### Severity scoring (L4)
- **Impact Severity** (0-100): 60% data sensitivity + 25% exposure actionability + 15% record scale
- **Evidence Confidence** (0-100): 35% ownership + 25% grounding + 20% claim proof + 15% corroboration + 5% actor credibility
- **Triage Priority** (0-100): 80% impact + 20% confidence
- Bands: critical >= 80, high >= 60, medium >= 40, low >= 20, informational < 20

### Grounding
Evidence text verified as exact/normalized substring of source. Unmatched = rejected.

### Corroboration
3+ distinct content hashes = corroborated, 2 = partially, 1 = unverified. Mirrors don't count.

### Actor credibility (0-100)
45% corroboration ratio + 25% self-evidence + 20% doc history + 10% claim depth - 30% dispute penalty.

### Pipeline stages
L0 (regex indicators) → L1 (AI relationship classification) → L2 (extraction + grounding + routing) → L3 (knowledge graph + corroboration) → L4 (severity scoring + AI insights)`;

/* ── Tool execution ────────────────────────────────────────────────────────── */

async function executeTool(
  toolName: string,
  args: Record<string, string>,
  scope: DataScope,
): Promise<{ data: unknown; error?: string }> {
  try {
    switch (toolName) {
      case "getCommandCenter": {
        const result: CommandCenterResponse =
          await nocturneBackend.getCommandCenter(scope);
        return {
          data: {
            organizations: result.organizations.map((org) => ({
              orgId: org.orgId,
              name: org.organizationName,
              incidentsRaised: org.metrics.pipeline.incidentsRaised,
              criticalIncidents: org.metrics.incidentsByBand.critical,
              highIncidents: org.metrics.incidentsByBand.high,
              mediumIncidents: org.metrics.incidentsByBand.medium,
              lowIncidents: org.metrics.incidentsByBand.low,
              topSeverityBand: org.metrics.topImpactSeverityBand,
              topSeverityScore: org.metrics.topImpactSeverityScore,
              distinctActors: org.metrics.distinctThreatActorCount,
              groundingRate: org.metrics.grounding.rate,
              pagesCollected: org.metrics.pipeline.pagesCollected,
              pagesScreened: org.metrics.pipeline.pagesScreened,
              uniquePages: org.metrics.pipeline.uniquePages,
              pagesOwnershipVerified: org.metrics.pipeline.pagesOwnershipVerified,
              lastUpdated: org.lastUpdatedAt,
            })),
            totals: result.totals,
          },
        };
      }
      case "getBreachMonitor": {
        const result: BreachMonitorResponse =
          await nocturneBackend.getBreachMonitor(scope, {
            includeExternalContext: true,
          });
        // Compact: return summary + rows (capped at 50 to bound tokens)
        return {
          data: {
            summary: result.summary,
            totalRows: result.rows.length,
            rows: result.rows.slice(0, 50).map((row) => ({
              incidentKey: row.incidentKey,
              title: row.title,
              orgId: row.orgId,
              organizationName: row.organizationName,
              monitorStatus: row.monitorStatus,
              leakTypes: row.leakTypes,
              impactSeverityScore: row.impactSeverityScore,
              impactSeverityBand: row.impactSeverityBand,
              evidenceConfidenceScore: row.evidenceConfidenceScore,
              evidenceConfidenceBand: row.evidenceConfidenceBand,
              triagePriorityScore: row.triagePriorityScore,
              triagePriorityBand: row.triagePriorityBand,
              actorName: row.actorName,
              groundingLevel: row.groundingLevel,
              discoveredAt: row.discoveredAt,
              remediationStatus: row.remediationStatus,
              quantityClaimed: row.quantityClaimed,
            })),
          },
        };
      }
      case "getIncidentDetail": {
        const incidentKey = args.incidentKey;
        if (!incidentKey || !/^[a-f0-9]{64}$/i.test(incidentKey)) {
          return { data: null, error: "Invalid incident key format." };
        }
        const result: IncidentDetailResponse | null =
          await nocturneBackend.getIncidentDetail(scope, incidentKey);
        if (!result) {
          return { data: null, error: "Incident not found or not accessible." };
        }
        return {
          data: {
            incident: {
              incidentKey: result.incident.incidentKey,
              title: result.incident.topTitle,
              orgId: result.incident.orgId,
              organizationName: result.incident.organizationName,
              leakTypes: result.incident.leakTypes,
              impactSeverityScore: result.incident.impactSeverityScore,
              impactSeverityBand: result.incident.impactSeverityBand,
              evidenceConfidenceScore: result.incident.evidenceConfidenceScore,
              evidenceConfidenceBand: result.incident.evidenceConfidenceBand,
              triagePriorityScore: result.incident.triagePriorityScore,
              triagePriorityBand: result.incident.triagePriorityBand,
              scoreVector: result.incident.scoreVector,
              scoreReasons: result.incident.scoreReasons,
              actorName: result.incident.actorName,
              actorCredibilityScore: result.incident.actorCredibilityScore,
              groundingLevel: result.incident.groundingLevel,
              corroborationCount: result.incident.corroborationCount,
              sightingCount: result.incident.sightingCount,
              firstSeen: result.incident.firstSeen,
              lastSeen: result.incident.lastSeen,
              remediationStatus: result.incident.remediationStatus,
              insightHeadline: result.incident.insight.headline,
              executiveSummary: result.incident.insight.executiveSummary,
              whatHappened: result.incident.insight.whatHappened,
              businessImpact: result.incident.insight.businessImpact,
              recommendedActions: result.incident.insight.recommendedActions,
              confidenceAssessment: result.incident.insight.confidenceAssessment,
            },
            claims: result.claims.slice(0, 10).map((c) => ({
              statement: c.statement,
              status: c.claimStatus,
              groundingLevel: c.groundingLevel,
              corroborationCount: c.corroborationCount,
              quantityClaimed: c.quantityClaimed,
            })),
            indicatorCounts: result.indicatorCounts,
          },
        };
      }
      case "getThreatActors": {
        const result: ThreatActorsResponse =
          await nocturneBackend.getThreatActors(scope);
        return {
          data: {
            actors: result.actors.slice(0, 30).map((a) => ({
              actorName: a.actorName,
              credibilityScore: a.credibilityScore,
              totalClaims: a.totalClaimCount,
              corroboratedClaims: a.corroboratedClaimCount,
              selfEvidencedClaims: a.selfEvidencedClaimCount,
              disputedClaims: a.disputedClaimCount,
              marketplaceCount: a.marketplaceCount,
              marketplaces: a.marketplaces,
              docCount: a.docCount,
              sightingCount: a.sightingCount,
              firstSeen: a.firstSeen,
              lastSeen: a.lastSeen,
            })),
          },
        };
      }
      case "getPipeline": {
        const result: PipelineResponse =
          await nocturneBackend.getPipeline(scope);
        return {
          data: {
            organizations: result.organizations.map((org) => ({
              orgId: org.orgId,
              name: org.organizationName,
              lastUpdated: org.lastUpdatedAt,
            })),
            cascade: result.cascade,
            grounding: result.grounding,
            health: result.health,
          },
        };
      }
      default:
        return { data: null, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown tool execution error";
    console.error(`[nlq-assistant] tool ${toolName} failed:`, message);
    return { data: null, error: `Tool execution failed: ${message}` };
  }
}

/* ── LLM interaction via Cortex COMPLETE ───────────────────────────────────── */

/**
 * Calls Snowflake Cortex COMPLETE via SQL (simplest integration path —
 * uses the existing snowflake-sdk connection, no new REST dependency).
 *
 * Falls back to a simple heuristic response if Cortex is unavailable.
 */
async function callCortexComplete(
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  // Import executeQuery dynamically to avoid circular deps — the function is
  // not exported from nocturne-backend.ts, so we use SNOWFLAKE.CORTEX.COMPLETE
  // via a raw SQL call through the backend's existing connection.
  const { cortexComplete } = await import("@/server/cortex-complete");
  return cortexComplete(messages);
}

/* ── Main orchestrator ─────────────────────────────────────────────────────── */

const MAX_TOOL_CALLS = 3;
const MAX_HISTORY_TURNS = 10;

export async function askAssistant(
  question: string,
  scope: DataScope,
  history: AssistantMessage[] = [],
): Promise<AssistantResponse> {
  const startTime = Date.now();
  const toolsCalled: string[] = [];
  const citations: AssistantCitation[] = [];

  // Build conversation messages
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];

  // Add bounded history
  const boundedHistory = history.slice(-MAX_HISTORY_TURNS * 2);
  for (const msg of boundedHistory) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Add current question
  messages.push({ role: "user", content: question });

  // Tool-calling loop
  let toolCallCount = 0;
  let finalAnswer = "";

  for (let iteration = 0; iteration < MAX_TOOL_CALLS + 1; iteration++) {
    const response = await callCortexComplete(messages);

    // Check if the response contains a tool call request
    const toolCall = parseToolCall(response);

    if (!toolCall || toolCallCount >= MAX_TOOL_CALLS) {
      // Final answer — strip any residual tool-call markup
      finalAnswer = cleanAnswer(response);
      break;
    }

    // Execute the tool
    toolCallCount++;
    toolsCalled.push(toolCall.name);

    const toolResult = await executeTool(toolCall.name, toolCall.args, scope);

    // Feed tool result back into conversation
    messages.push({
      role: "assistant",
      content: `[TOOL_CALL: ${toolCall.name}(${JSON.stringify(toolCall.args)})]`,
    });
    messages.push({
      role: "user",
      content: `[TOOL_RESULT]\n${JSON.stringify(toolResult.data, null, 2)}\n[/TOOL_RESULT]\n\nNow provide a natural-language answer to the original question using this data. Be concise and cite specific values.`,
    });
  }

  // If no answer was produced (shouldn't happen), provide a fallback
  if (!finalAnswer) {
    finalAnswer =
      "I wasn't able to generate an answer. Please try rephrasing your question.";
  }

  // Extract citations from the answer (incident keys mentioned)
  const incidentKeyPattern = /[a-f0-9]{64}/gi;
  const mentionedKeys = finalAnswer.match(incidentKeyPattern) || [];
  for (const key of [...new Set(mentionedKeys)].slice(0, 5)) {
    citations.push({ type: "incident", key, label: key.slice(0, 12) + "..." });
  }

  // Extract LLM-generated suggestions from the response
  const suggestedFollowUps = parseSuggestions(finalAnswer);
  // Strip the suggestions line from the displayed answer
  finalAnswer = finalAnswer.replace(/\[SUGGESTIONS:.*?\]/s, "").trim();

  return {
    answer: finalAnswer,
    citations,
    suggestedFollowUps,
    toolsCalled,
    latencyMs: Date.now() - startTime,
  };
}

/* ── Helper functions ──────────────────────────────────────────────────────── */

interface ParsedToolCall {
  name: string;
  args: Record<string, string>;
}

function parseToolCall(response: string): ParsedToolCall | null {
  // The model is instructed to emit tool calls in this format:
  // [TOOL_CALL: toolName({"arg": "value"})]
  const match = response.match(
    /\[TOOL_CALL:\s*(\w+)\((\{[^}]*\}|)\)\]/,
  );
  if (!match) return null;

  const name = match[1];
  if (!TOOLS.find((t) => t.name === name)) return null;

  let args: Record<string, string> = {};
  if (match[2] && match[2].trim()) {
    try {
      args = JSON.parse(match[2]);
    } catch {
      args = {};
    }
  }

  return { name, args };
}

function cleanAnswer(response: string): string {
  // Remove any tool-call markup that leaked into the final answer
  return response
    .replace(/\[TOOL_CALL:[^\]]*\]/g, "")
    .replace(/\[TOOL_RESULT\][\s\S]*?\[\/TOOL_RESULT\]/g, "")
    .trim();
}

function parseSuggestions(response: string): string[] {
  // Parse [SUGGESTIONS: "q1", "q2", "q3"] from the model's response
  const match = response.match(/\[SUGGESTIONS:\s*(.+?)\]/s);
  if (!match) {
    return [
      "What's my current breach posture?",
      "Show me confirmed incidents",
      "How does the severity scoring work?",
    ];
  }

  try {
    // Extract quoted strings
    const quotedStrings = match[1].match(/"([^"]+)"/g);
    if (quotedStrings && quotedStrings.length > 0) {
      return quotedStrings
        .map((s) => s.slice(1, -1))
        .slice(0, 3);
    }
  } catch {
    // Fall through to defaults
  }

  return [
    "What's my current breach posture?",
    "Show me confirmed incidents",
    "How does the severity scoring work?",
  ];
}

/* ── Rate limiter for assistant queries ────────────────────────────────────── */

const ASSISTANT_MAX_REQUESTS = 20;
const ASSISTANT_WINDOW_MS = 60 * 1000;

interface AssistantBucket {
  count: number;
  resetsAt: number;
}

const assistantBuckets = new Map<string, AssistantBucket>();

export function checkAssistantRate(sessionKey: string): {
  allowed: boolean;
  retryAfterMs: number;
} {
  const now = Date.now();
  const bucket = assistantBuckets.get(sessionKey);

  if (!bucket || bucket.resetsAt <= now) {
    assistantBuckets.set(sessionKey, {
      count: 1,
      resetsAt: now + ASSISTANT_WINDOW_MS,
    });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (bucket.count < ASSISTANT_MAX_REQUESTS) {
    bucket.count++;
    return { allowed: true, retryAfterMs: 0 };
  }

  return { allowed: false, retryAfterMs: bucket.resetsAt - now };
}

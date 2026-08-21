import { createHash } from "node:crypto";

import { executeQuery } from "@/server/nocturne-backend";
import type { GraphEdge, GraphNode } from "@/types";
import type { KnowledgeGraphResponse } from "@/types/dashboard";

if (typeof window !== "undefined") {
  throw new Error("Nocturne graph summaries may only be generated on the server.");
}

/**
 * A natural-language reading of the knowledge graph.
 *
 * The canvas shows that things are connected; it does not say what the
 * connections mean. An analyst looking at forty nodes and ninety edges can see
 * a dense cluster around one actor without being able to state what that actor
 * is alleged to have done, which claims corroborate each other, or which edge
 * carries the grounded evidence. That reading is what this produces.
 *
 * Two rules shape the prompt below, and both come from the product rather than
 * from the model:
 *
 *   - the summary describes relationships, never counts of any kind. Every
 *     number it could cite is already on screen beside it, and the budget is
 *     120 words.
 *   - it never invents attribution. The graph records what pages claimed and
 *     how well grounded each claim is; a summary that turns "alleged" into
 *     "confirmed" would launder an unverified forum post into an intelligence
 *     finding, which is the exact failure this product exists to prevent.
 */

/**
 * Bumped whenever the rules below change.
 *
 * Folded into the fingerprint, so tightening the prompt re-reads every graph
 * instead of serving summaries written to the old rules forever. Without it the
 * cache is keyed only on the graph's contents, and a graph that has not changed
 * would keep its stale reading indefinitely.
 */
const PROMPT_VERSION = "graph_summary_v2";

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 320;

export interface GraphSummary {
  summary: string;
  generatedAt: string;
  modelName: string;
  nodeCount: number;
  edgeCount: number;
  /** True when this came from the cache rather than a fresh model call. */
  cached: boolean;
}

/**
 * Identity of the graph's content, not of the request.
 *
 * Keys are sorted before hashing so the fingerprint does not change when
 * Snowflake returns the same rows in a different order. Without that, every
 * page load would miss the cache and buy another Cortex call for an identical
 * graph.
 */
export function fingerprintGraph(nodes: GraphNode[], edges: GraphEdge[]): string {
  const nodeKeys = nodes.map((node) => node.nodeKey).sort();
  const edgeKeys = edges.map((edge) => edge.graphEdgeKey).sort();
  return createHash("sha256")
    .update(PROMPT_VERSION)
    .update("|")
    .update(nodeKeys.join(" "))
    .update("|")
    .update(edgeKeys.join(" "))
    .digest("hex");
}

/** Keeps one prompt inside a sane token budget on a large actor graph. */
const MAX_NODES_IN_PROMPT = 60;
const MAX_EDGES_IN_PROMPT = 90;

/**
 * Renders the graph as text for the model.
 *
 * Nodes are ordered by how much evidence sits behind them, so truncating a
 * large graph drops the periphery rather than the centre. `sampleEvidenceText`
 * is included because it is the sentence that produced the edge, and therefore
 * the only thing explaining why two entities are linked at all - but it is
 * clipped hard, since a full page of dark-web prose buys nothing over its
 * first line.
 */
function describeGraph(graph: KnowledgeGraphResponse): string {
  const nodes = [...graph.nodes]
    .sort(
      (a, b) =>
        b.sightingCount + b.mentionCount - (a.sightingCount + a.mentionCount),
    )
    .slice(0, MAX_NODES_IN_PROMPT);
  const keep = new Set(nodes.map((node) => node.nodeKey));

  const edges = graph.edges
    .filter((edge) => keep.has(edge.sourceKey) && keep.has(edge.targetKey))
    .sort((a, b) => b.sightingCount - a.sightingCount)
    .slice(0, MAX_EDGES_IN_PROMPT);

  const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  const name = (key: string) => byKey.get(key)?.displayName ?? "unknown";

  const nodeLines = nodes.map((node) => {
    const flags = [
      node.nodeType,
      node.isMonitoredOrg ? "MONITORED ORG" : null,
      `${node.sightingCount} sightings`,
      `${node.docCount} docs`,
    ]
      .filter(Boolean)
      .join(", ");
    return `- ${node.displayName} (${flags})`;
  });

  const edgeLines = edges.map((edge) => {
    const evidence = edge.sampleEvidenceText?.trim().slice(0, 220) ?? "";
    const relation = `- ${name(edge.sourceKey)} -> ${edge.edgeType} -> ${name(edge.targetKey)}`;
    const meta = ` (grounding: ${edge.groundingLevel}, ${edge.sightingCount} sightings)`;
    return evidence
      ? `${relation}${meta}\n    evidence: "${evidence}"`
      : `${relation}${meta}`;
  });

  const root = graph.rootIncident;
  const header = root
    ? `This graph is scoped to one incident: "${root.title}"`
      + `${root.actorName ? `, attributed to ${root.actorName}` : ""}`
      + `${root.impactSeverityBand ? `, severity ${root.impactSeverityBand}` : ""}.`
    : `This graph aggregates ${graph.incidentCount} promoted incidents for one organization.`;

  return [
    header,
    "",
    `ENTITIES (${graph.nodes.length} total${
      nodes.length < graph.nodes.length ? `, ${nodes.length} strongest shown` : ""
    }):`,
    ...nodeLines,
    "",
    `RELATIONSHIPS (${graph.edges.length} total${
      edges.length < graph.edges.length ? `, ${edges.length} strongest shown` : ""
    }):`,
    ...edgeLines,
  ].join("\n");
}

const SYSTEM_PROMPT = [
  "You are a threat-intelligence analyst writing a short reading of a knowledge graph for a security console.",
  "",
  "The graph links entities extracted from dark-web pages: organizations, threat actors, marketplaces, and the claims made about them. Each relationship carries a grounding level describing how well the underlying evidence was verified.",
  "",
  "Write at most two short paragraphs, 120 words in total. It is read in a narrow sidebar beside the graph itself, so length is a cost paid by every reader.",
  "",
  "Cover only:",
  "- which entity sits at the centre, and what the strongest chains allege",
  "- where corroboration is genuinely weak, and what an analyst should doubt",
  "",
  "Rules:",
  "- Never state counts of any kind: not nodes, edges, sightings, documents, or corroborating sources. Those numbers are on screen already, and spending a 120-word budget re-reading them to the analyst is the single easiest way to waste it.",
  "- Preserve uncertainty exactly. If evidence is described as alleged or ungrounded, say so. Never upgrade an allegation into a fact.",
  "- Never invent an entity, a relationship, or an attribution that is not in the data given to you.",
  "- Do not quote the evidence text; describe what it says.",
  "- No headings, no bullet lists, no preamble, no closing summary. Start with the substance and stop when it runs out.",
].join("\n");

/** Cortex COMPLETE, strict: a failure throws instead of returning apology text. */
async function complete(prompt: string): Promise<string> {
  const rows = await executeQuery(
    `SELECT SNOWFLAKE.CORTEX.COMPLETE(
       ?,
       PARSE_JSON(?),
       OBJECT_CONSTRUCT('temperature', 0.2, 'max_tokens', ${MAX_TOKENS})
     ) AS RESPONSE`,
    [
      MODEL,
      JSON.stringify([
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ]),
    ],
  );

  const raw = rows[0]?.RESPONSE;
  if (!raw) throw new Error("Cortex returned no completion for the graph summary.");

  // COMPLETE with a message array answers with a JSON envelope; with a bare
  // string it answers with the string. Handle both, so a Cortex-side change in
  // shape degrades to raw text rather than rendering "[object Object]".
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    const parsed = JSON.parse(text) as {
      choices?: Array<{ messages?: string; message?: { content?: string } }>;
    };
    const choice = parsed.choices?.[0];
    const content = choice?.messages ?? choice?.message?.content;
    if (typeof content === "string" && content.trim()) return content.trim();
  } catch {
    // Not JSON: it is the completion itself.
  }
  return text.trim();
}

function scopeKeyFor(graph: KnowledgeGraphResponse): string {
  return graph.view === "incident" ? graph.rootIncident?.incidentKey ?? "-" : "";
}

async function readCached(
  orgId: string,
  graph: KnowledgeGraphResponse,
  fingerprint: string,
): Promise<GraphSummary | null> {
  const rows = await executeQuery(
    `SELECT SUMMARY, MODEL_NAME, NODE_COUNT, EDGE_COUNT,
            TO_VARCHAR(GENERATED_AT, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS GENERATED_AT
     FROM NOCTURNE.CONFIG.GRAPH_SUMMARIES
     WHERE ORG_ID = ? AND VIEW_KIND = ? AND SCOPE_KEY = ?
       AND GRAPH_FINGERPRINT = ?`,
    [orgId, graph.view, scopeKeyFor(graph), fingerprint],
  );
  const row = rows[0];
  if (!row?.SUMMARY) return null;
  return {
    summary: String(row.SUMMARY),
    generatedAt: String(row.GENERATED_AT ?? new Date().toISOString()),
    modelName: String(row.MODEL_NAME ?? MODEL),
    nodeCount: Number(row.NODE_COUNT ?? graph.nodes.length),
    edgeCount: Number(row.EDGE_COUNT ?? graph.edges.length),
    cached: true,
  };
}

/**
 * Returns the graph's summary, generating one only when the cached reading was
 * written from a different graph.
 *
 * `force` re-reads regardless, for the console's refresh control: an analyst
 * who thinks the reading is wrong needs a way to ask again without waiting for
 * the underlying graph to change.
 */
export async function summarizeGraph(
  orgId: string,
  graph: KnowledgeGraphResponse,
  options: { force?: boolean } = {},
): Promise<GraphSummary> {
  const fingerprint = fingerprintGraph(graph.nodes, graph.edges);

  if (!options.force) {
    const cached = await readCached(orgId, graph, fingerprint);
    if (cached) return cached;
  }

  if (!graph.nodes.length) {
    throw new Error("This graph has no entities to summarize yet.");
  }

  const summary = await complete(describeGraph(graph));

  // MERGE rather than INSERT: one graph keeps one summary. A superseded
  // reading is not history worth holding, because it describes a graph that no
  // longer exists.
  await executeQuery(
    `MERGE INTO NOCTURNE.CONFIG.GRAPH_SUMMARIES AS TARGET
     USING (SELECT ? AS ORG_ID, ? AS VIEW_KIND, ? AS SCOPE_KEY) AS SOURCE
       ON TARGET.ORG_ID = SOURCE.ORG_ID
      AND TARGET.VIEW_KIND = SOURCE.VIEW_KIND
      AND TARGET.SCOPE_KEY = SOURCE.SCOPE_KEY
     WHEN MATCHED THEN UPDATE SET
       GRAPH_FINGERPRINT = ?, SUMMARY = ?, NODE_COUNT = ?, EDGE_COUNT = ?,
       MODEL_NAME = ?, GENERATED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT
       (ORG_ID, VIEW_KIND, SCOPE_KEY, GRAPH_FINGERPRINT, SUMMARY,
        NODE_COUNT, EDGE_COUNT, MODEL_NAME)
       VALUES (SOURCE.ORG_ID, SOURCE.VIEW_KIND, SOURCE.SCOPE_KEY, ?, ?, ?, ?, ?)`,
    [
      orgId,
      graph.view,
      scopeKeyFor(graph),
      fingerprint,
      summary,
      graph.nodes.length,
      graph.edges.length,
      MODEL,
      fingerprint,
      summary,
      graph.nodes.length,
      graph.edges.length,
      MODEL,
    ],
  );

  return {
    summary,
    generatedAt: new Date().toISOString(),
    modelName: MODEL,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    cached: false,
  };
}

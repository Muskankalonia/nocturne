import { NextResponse } from "next/server";

import { summarizeGraph } from "@/server/graph-summary";
import { nocturneBackend } from "@/server/nocturne-backend";
import { cachedQuery, scopeKey } from "@/server/query-cache";
import {
  API_RESPONSE_HEADERS,
  INCIDENT_KEY_PATTERN,
  authenticateRequest,
  badRequest,
  readJsonBody,
  resolveWriteScope,
  serviceUnavailable,
} from "@/server/route-auth";
import type { DataScope } from "@/types";
import type { KnowledgeGraphView } from "@/types/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Natural-language reading of the knowledge graph.
 *
 * POST rather than GET, for the same reason the integration test is a POST: it
 * can reach a language model and spend money. A GET invites a prefetch or a
 * crawler to bill a Cortex call, and browsers are entitled to retry GETs
 * freely.
 *
 * The graph itself is re-fetched here rather than accepted from the request
 * body. A caller who could post their own nodes and edges would be able to put
 * arbitrary text in front of the model and have the console render the reply
 * as if it were an intelligence finding.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const body = (await readJsonBody(request)) as {
    orgId?: string;
    view?: string;
    incidentKey?: string | null;
    force?: boolean;
  } | null;

  const view = body?.view ?? "incident";
  if (view !== "incident" && view !== "actors") {
    return badRequest("The requested graph view is invalid.");
  }

  const incidentKey = body?.incidentKey ?? null;
  if (incidentKey !== null && !INCIDENT_KEY_PATTERN.test(incidentKey)) {
    return badRequest("The requested incident identifier is invalid.");
  }

  const scoped = resolveWriteScope(auth.caller, body?.orgId ?? null);
  if (!scoped.ok) return scoped.response;

  const scope: DataScope = { kind: "org", orgId: scoped.orgId };

  try {
    // Same cache key the graph route uses, so opening the page and then asking
    // for a summary does not run the graph query twice.
    const graph = await cachedQuery(
      `knowledge-graph:${scopeKey(scope)}:${view}:${incidentKey ?? "-"}`,
      () =>
        nocturneBackend.getKnowledgeGraph(
          scope,
          view as KnowledgeGraphView,
          view === "incident" ? incidentKey ?? undefined : undefined,
        ),
    );
    if (!graph) {
      return NextResponse.json(
        { error: "No promoted incident graph was found for this scope." },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }

    const summary = await summarizeGraph(scoped.orgId, graph, {
      force: body?.force === true,
    });
    return NextResponse.json(summary, { headers: API_RESPONSE_HEADERS });
  } catch (error) {
    // An empty graph is a legitimate state, not an outage, so it is reported as
    // a 400 an analyst can read rather than a 503 that looks like a fault.
    if (error instanceof Error && error.message.includes("no entities")) {
      return badRequest(error.message);
    }
    return serviceUnavailable(
      "nocturne-graph-summary",
      "summarize",
      error,
      "Generating the graph summary failed.",
    );
  }
}

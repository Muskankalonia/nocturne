import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import { cachedQuery, scopeKey, PIPELINE_CYCLE_TTL_MS } from "@/server/query-cache";
import { nocturneBackend } from "@/server/nocturne-backend";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import type { DataScope } from "@/types";
import type { KnowledgeGraphView } from "@/types/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "private, max-age=300, stale-while-revalidate=600",
  Vary: "Cookie",
};
const ORG_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const INCIDENT_KEY_PATTERN = /^[a-f0-9]{64}$/i;

function invalidSessionResponse() {
  const response = NextResponse.json(
    { error: "A valid session is required." },
    { status: 401, headers: RESPONSE_HEADERS },
  );
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  let verified;
  try {
    verified = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  } catch {
    return NextResponse.json(
      { error: "Server session configuration is unavailable." },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
  if (!verified) return invalidSessionResponse();

  const user = users.find((candidate) => candidate.username === verified.username);
  const identityMatches = Boolean(
    user
    && user.role === verified.role
    && user.orgId === verified.orgId,
  );
  if (!user || !identityMatches) return invalidSessionResponse();

  if (user.role === "ORG_USER") {
    const organization = organizations.find(
      (candidate) => candidate.orgId === user.orgId && candidate.enabled,
    );
    if (!organization) return invalidSessionResponse();
  }

  const url = new URL(request.url);
  const requestedView = url.searchParams.get("view") ?? "incident";
  if (requestedView !== "incident" && requestedView !== "actors") {
    return NextResponse.json(
      { error: "The requested graph view is invalid." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }
  const view = requestedView as KnowledgeGraphView;

  const requestedIncidentKey = url.searchParams.get("incidentKey");
  if (
    requestedIncidentKey !== null
    && !INCIDENT_KEY_PATTERN.test(requestedIncidentKey)
  ) {
    return NextResponse.json(
      { error: "The requested incident identifier is invalid." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  let scope: DataScope = verified.scope;
  const requestedOrgId = url.searchParams.get("orgId");
  if (user.role === "SUPER_ADMIN" && requestedOrgId !== null) {
    if (!ORG_ID_PATTERN.test(requestedOrgId)) {
      return NextResponse.json(
        { error: "The requested organization identifier is invalid." },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }
    scope = { kind: "org", orgId: requestedOrgId };
  }

  if (scope.kind !== "org") {
    return NextResponse.json(
      { error: "Select one organization before opening its knowledge graph." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  try {
    const incidentKey =
      view === "incident" ? requestedIncidentKey ?? undefined : undefined;
    const graph = await cachedQuery(
      `knowledge-graph:${scopeKey(scope)}:${view}:${incidentKey ?? "-"}`,
      () => nocturneBackend.getKnowledgeGraph(scope, view, incidentKey),
      PIPELINE_CYCLE_TTL_MS,
    );
    if (!graph) {
      return NextResponse.json(
        { error: "No promoted incident graph was found for this scope." },
        { status: 404, headers: RESPONSE_HEADERS },
      );
    }
    return NextResponse.json(graph, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-knowledge-graph] live query failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return NextResponse.json(
      { error: "Live knowledge-graph data is temporarily unavailable." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

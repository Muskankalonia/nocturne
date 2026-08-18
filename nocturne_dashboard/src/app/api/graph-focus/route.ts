import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { GRAPH_NODE_KEY_PATTERN, canonicalNodeKey } from "@/lib/graph-focus";
import { organizations, users } from "@/mocks/organizations";
import { nocturneBackend } from "@/server/nocturne-backend";
import { cachedQuery, scopeKey } from "@/server/query-cache";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import type { DataScope } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};
const ORG_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

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

/**
 * Which incidents contain a given graph node.
 *
 * This is the join that lets a click on the canvas filter the Command Center.
 * It answers with incident keys only — never with the rows themselves — so it
 * cannot become a second, less careful path to incident data: the page already
 * holds the rows it is entitled to from `/api/command-center`, and this call
 * only tells it which of them to keep.
 */
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
  const requestedNodeKey = url.searchParams.get("nodeKey");
  if (!requestedNodeKey || !GRAPH_NODE_KEY_PATTERN.test(requestedNodeKey)) {
    return NextResponse.json(
      { error: "The requested graph node identifier is invalid." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }
  const nodeKey = canonicalNodeKey(requestedNodeKey);

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

  // Fleet scope has no single graph to resolve against, and the graph screens
  // that produce these clicks are org-scoped for the same reason.
  if (scope.kind !== "org") {
    return NextResponse.json(
      { error: "Select one organization before filtering by a graph entity." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  try {
    const resolution = await cachedQuery(
      `graph-focus:${scopeKey(scope)}:${nodeKey}`,
      () => nocturneBackend.resolveGraphFocus(scope, nodeKey),
    );
    return NextResponse.json(resolution, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-graph-focus] live query failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return NextResponse.json(
      { error: "Graph entity resolution is temporarily unavailable." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

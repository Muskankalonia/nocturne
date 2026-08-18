import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import { cachedQuery, scopeKey } from "@/server/query-cache";
import { nocturneBackend } from "@/server/nocturne-backend";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import type { DataScope } from "@/types";
import type {
  CommandCenterGraphFilter,
  CommandCenterGraphFilterType,
} from "@/types/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};
const ORG_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
/** Bounds the cache-key space so a hostile client cannot blow up the cache. */
const MAX_FLEET_SELECTION = 50;
const MAX_GRAPH_FILTER_KEY_LENGTH = 512;
const MAX_GRAPH_FILTER_LABEL_LENGTH = 240;
const COMMAND_CENTER_GRAPH_FILTER_TYPES = new Set<CommandCenterGraphFilterType>([
  "actor_alias",
  "claim",
  "data_asset",
  "domain",
  "edge",
  "marketplace",
  "organization",
  "product",
]);

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

function parseGraphFilter(
  searchParams: URLSearchParams,
): CommandCenterGraphFilter | NextResponse | null {
  const rawType = searchParams.get("graphFilterType");
  const rawKey = searchParams.get("graphFilterKey");
  const rawLabel = searchParams.get("graphFilterLabel");

  if (rawType === null && rawKey === null && rawLabel === null) return null;
  if (
    rawType === null
    || rawKey === null
    || !COMMAND_CENTER_GRAPH_FILTER_TYPES.has(rawType as CommandCenterGraphFilterType)
    || rawKey.length === 0
    || rawKey.length > MAX_GRAPH_FILTER_KEY_LENGTH
    || (rawLabel !== null && rawLabel.length > MAX_GRAPH_FILTER_LABEL_LENGTH)
  ) {
    return NextResponse.json(
      { error: "The requested graph filter is invalid." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  return {
    filterType: rawType as CommandCenterGraphFilterType,
    filterKey: rawKey,
    filterLabel: rawLabel && rawLabel.trim().length > 0 ? rawLabel : null,
  };
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
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

  const graphFilter = parseGraphFilter(searchParams);
  if (graphFilter instanceof NextResponse) return graphFilter;

  const requestedOrgId = searchParams.get("orgId");
  let scope: DataScope = verified.scope;
  if (user.role === "SUPER_ADMIN" && requestedOrgId !== null) {
    if (!ORG_ID_PATTERN.test(requestedOrgId)) {
      return NextResponse.json(
        { error: "The requested organization identifier is invalid." },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }
    scope = { kind: "org", orgId: requestedOrgId };
  }

  // Fleet subset selection. Only meaningful for a fleet request, and only ever
  // subtractive — it filters rows this session was already entitled to, so it
  // is safe to take from the client. Org scope ignores it entirely.
  let include: ReadonlySet<string> | undefined;
  if (scope.kind === "fleet") {
    const raw = searchParams.get("orgIds");
    if (raw !== null) {
      const ids = raw.split(",").map((id) => id.trim()).filter(Boolean);
      if (ids.length > MAX_FLEET_SELECTION || ids.some((id) => !ORG_ID_PATTERN.test(id))) {
        return NextResponse.json(
          { error: "The requested organization selection is invalid." },
          { status: 400, headers: RESPONSE_HEADERS },
        );
      }
      include = new Set(ids);
    }
  }

  // The selection is part of the cache key: without it a narrowed fleet result
  // would be served to the next caller asking for the whole fleet.
  const selectionKey = include ? [...include].sort().join("+") : "default";
  const graphFilterKey = graphFilter
    ? `${graphFilter.filterType}:${graphFilter.filterKey}`
    : "none";

  try {
    const data = await cachedQuery(
      `command-center:${scopeKey(scope)}:sel=${selectionKey}:graph=${graphFilterKey}`,
      () => nocturneBackend.getCommandCenter(scope, include, graphFilter),
    );
    if (scope.kind === "org" && data.organizations.length === 0) {
      return NextResponse.json(
        { error: "No enabled dashboard organization was found for this scope." },
        { status: 404, headers: RESPONSE_HEADERS },
      );
    }
    return NextResponse.json(data, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-command-center] live query failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return NextResponse.json(
      { error: "Live dashboard data is temporarily unavailable." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

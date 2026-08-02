import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import { nocturneBackend } from "@/server/nocturne-backend";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};
const INCIDENT_KEY_PATTERN = /^[a-f0-9]{64}$/i;

interface IncidentRouteContext {
  params: Promise<{ incidentKey: string }>;
}

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

export async function GET(
  _request: Request,
  context: IncidentRouteContext,
) {
  const { incidentKey } = await context.params;
  if (!INCIDENT_KEY_PATTERN.test(incidentKey)) {
    return NextResponse.json(
      { error: "The requested incident identifier is invalid." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

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

  try {
    const detail = await nocturneBackend.getIncidentDetail(
      verified.scope,
      incidentKey,
    );
    if (!detail) {
      // Missing and out-of-scope incidents intentionally share one response so
      // callers cannot probe another organization's incident identifiers.
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404, headers: RESPONSE_HEADERS },
      );
    }
    return NextResponse.json(detail, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-incident-detail] live query failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return NextResponse.json(
      { error: "Live incident data is temporarily unavailable." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

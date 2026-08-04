import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import {
  ConfigValidationError,
  listMonitoredOrganizations,
  normalizeMonitoredOrganizationUpdate,
  updateMonitoredOrganization,
} from "@/server/nocturne-backend";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import type { DataScope, User } from "@/types";

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
 * Resolves the caller from the signed cookie. Mirrors the read routes: the
 * session is the only authority on identity, never anything the client sends.
 */
async function authenticate(): Promise<
  { ok: true; user: User; scope: DataScope } | { ok: false; response: NextResponse }
> {
  const cookieStore = await cookies();
  let verified;
  try {
    verified = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Server session configuration is unavailable." },
        { status: 500, headers: RESPONSE_HEADERS },
      ),
    };
  }
  if (!verified) return { ok: false, response: invalidSessionResponse() };

  const user = users.find((candidate) => candidate.username === verified.username);
  const identityMatches = Boolean(
    user && user.role === verified.role && user.orgId === verified.orgId,
  );
  if (!user || !identityMatches) {
    return { ok: false, response: invalidSessionResponse() };
  }

  if (user.role === "ORG_USER") {
    const organization = organizations.find(
      (candidate) => candidate.orgId === user.orgId && candidate.enabled,
    );
    if (!organization) return { ok: false, response: invalidSessionResponse() };
  }

  return { ok: true, user, scope: verified.scope };
}

function unavailable(context: string, error: unknown) {
  console.error(
    `[nocturne-monitored-organizations] ${context} failed:`,
    error instanceof Error ? error.message : "unknown server error",
  );
  return NextResponse.json(
    { error: "Live organization configuration is temporarily unavailable." },
    { status: 503, headers: RESPONSE_HEADERS },
  );
}

export async function GET() {
  const auth = await authenticate();
  if (!auth.ok) return auth.response;

  try {
    // Scope comes from the session: an org user can only ever read their own row.
    const records = await listMonitoredOrganizations(auth.scope);
    return NextResponse.json(
      { organizations: records, fetchedAt: new Date().toISOString() },
      { headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    return unavailable("read", error);
  }
}

export async function PUT(request: Request) {
  const auth = await authenticate();
  if (!auth.ok) return auth.response;

  const requestedOrgId = new URL(request.url).searchParams.get("orgId");
  if (!requestedOrgId || !ORG_ID_PATTERN.test(requestedOrgId)) {
    return NextResponse.json(
      { error: "A valid orgId query parameter is required." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  // Tenant isolation is enforced here, server-side, against the session — the
  // client's orgId is a request, not a grant.
  if (auth.user.role !== "SUPER_ADMIN" && auth.user.orgId !== requestedOrgId) {
    return NextResponse.json(
      { error: "You can only edit your own organization." },
      { status: 403, headers: RESPONSE_HEADERS },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "A JSON body is required." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  let update;
  try {
    update = normalizeMonitoredOrganizationUpdate(body);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }
    throw error;
  }

  try {
    const record = await updateMonitoredOrganization(requestedOrgId, update);
    if (!record) {
      return NextResponse.json(
        { error: "That organization is not configured for monitoring." },
        { status: 404, headers: RESPONSE_HEADERS },
      );
    }
    return NextResponse.json({ organization: record }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    return unavailable("write", error);
  }
}

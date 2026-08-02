import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import type { DataScope, Session, User } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function scopeForUser(user: User): DataScope {
  return user.role === "SUPER_ADMIN"
    ? { kind: "fleet" }
    : { kind: "org", orgId: user.orgId! };
}

function enabledOrganizationFor(user: User) {
  if (user.role !== "ORG_USER") return null;
  return organizations.find((organization) => organization.orgId === user.orgId);
}

function sessionForUser(user: User, issuedAt: string): Session {
  return {
    user: { ...user, lastSignInAt: issuedAt },
    scope: scopeForUser(user),
    issuedAt,
  };
}

function unauthorized() {
  return NextResponse.json(
    { error: "That username and password combination was not recognized." },
    { status: 401, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "A JSON username and password are required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (!body || typeof body !== "object") return unauthorized();
  const submitted = body as Record<string, unknown>;
  if (
    typeof submitted.username !== "string"
    || typeof submitted.password !== "string"
  ) {
    return unauthorized();
  }

  const username = submitted.username.trim().toLowerCase();
  const user = users.find((candidate) => candidate.username === username);
  if (!user || submitted.password !== username) return unauthorized();

  const organization = enabledOrganizationFor(user);
  if (user.role === "ORG_USER" && !organization) {
    return NextResponse.json(
      { error: "This organization is no longer configured." },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }
  if (organization && !organization.enabled) {
    return NextResponse.json(
      {
        error: `Monitoring is paused for ${organization.canonicalName}. Contact your administrator to re-enable it.`,
      },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }

  const now = new Date();
  let token: string;
  try {
    token = createSessionToken(user, now);
  } catch {
    return NextResponse.json(
      { error: "Server session configuration is unavailable." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }

  const response = NextResponse.json(
    { session: sessionForUser(user, now.toISOString()) },
    { headers: NO_STORE_HEADERS },
  );
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions);
  return response;
}

export async function GET() {
  const cookieStore = await cookies();
  let verified;
  try {
    verified = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  } catch {
    verified = null;
  }

  const user = verified
    ? users.find((candidate) => candidate.username === verified.username)
    : undefined;
  const organization = user ? enabledOrganizationFor(user) : null;
  const identityMatches = Boolean(
    verified
    && user
    && user.role === verified.role
    && user.orgId === verified.orgId
    && (user.role === "SUPER_ADMIN" || organization?.enabled),
  );

  if (!verified || !user || !identityMatches) {
    const response = NextResponse.json(
      { error: "No valid session is available." },
      { status: 401, headers: NO_STORE_HEADERS },
    );
    response.cookies.set(SESSION_COOKIE_NAME, "", {
      ...sessionCookieOptions,
      maxAge: 0,
    });
    return response;
  }

  return NextResponse.json(
    { session: sessionForUser(user, verified.issuedAt) },
    { headers: NO_STORE_HEADERS },
  );
}

export async function DELETE() {
  const response = new NextResponse(null, {
    status: 204,
    headers: NO_STORE_HEADERS,
  });
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}


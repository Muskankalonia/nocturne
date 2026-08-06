import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import { getUserProfile } from "@/server/nocturne-backend";
import { initialsFromName } from "@/lib/format";
import {
  checkLoginRate,
  clientKey,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/server/rate-limit";
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

/**
 * Overlay the saved profile onto the directory record.
 *
 * A profile lookup must never be able to sign someone out: if the warehouse is
 * unreachable, the session still issues with directory defaults. Presentation
 * degrades, authentication does not.
 */
async function withStoredProfile(user: User): Promise<User> {
  try {
    const profile = await getUserProfile(user.username);
    if (!profile) return user;
    const displayName = profile.displayName ?? user.displayName;
    return {
      ...user,
      displayName,
      initials: initialsFromName(displayName, user.initials),
      email: profile.email ?? user.email,
      position: profile.position ?? user.position,
    };
  } catch (error) {
    console.error(
      "[nocturne-auth] profile overlay unavailable, using directory defaults:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return user;
  }
}

/**
 * The demo scheme derives each password from the username plus a shared
 * suffix, so `admin` signs in with `admin<suffix>`.
 *
 * The suffix comes from the environment rather than from this file on purpose.
 * Once the console is reachable without an IP allowlist, a suffix committed to
 * the repository is a published password — anyone who can read the source can
 * sign in. Keep the real value in .env.local and in the Cloud Run environment.
 *
 * With the variable unset the password is simply the username, which keeps
 * local development working without extra setup.
 */
function expectedPassword(username: string): string {
  return `${username}${process.env.NOCTURNE_DEMO_PASSWORD_SUFFIX ?? ""}`;
}

/**
 * Reject a sign-in and count it against the caller's throttle. Every failing
 * path goes through here so that a malformed body is as expensive to retry as a
 * wrong password — otherwise the cheap paths become the ones worth guessing on.
 */
function unauthorized(rateKey: string) {
  recordLoginFailure(rateKey);
  return NextResponse.json(
    { error: "That username and password combination was not recognized." },
    { status: 401, headers: NO_STORE_HEADERS },
  );
}

export async function POST(request: Request) {
  // Throttle before parsing anything: a blocked caller should cost as little as
  // possible, and the check must not depend on the shape of their payload.
  const rateKey = clientKey(request.headers);
  const verdict = checkLoginRate(rateKey);
  if (!verdict.allowed) {
    return NextResponse.json(
      {
        error:
          `Too many failed sign-in attempts. Try again in `
          + `${Math.ceil(verdict.retryAfter / 60)} minute(s).`,
      },
      {
        status: 429,
        headers: { ...NO_STORE_HEADERS, "Retry-After": String(verdict.retryAfter) },
      },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "A JSON username and password are required." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  if (!body || typeof body !== "object") return unauthorized(rateKey);
  const submitted = body as Record<string, unknown>;
  if (
    typeof submitted.username !== "string"
    || typeof submitted.password !== "string"
  ) {
    return unauthorized(rateKey);
  }

  const username = submitted.username.trim().toLowerCase();
  const user = users.find((candidate) => candidate.username === username);
  if (!user || submitted.password !== expectedPassword(username)) {
    return unauthorized(rateKey);
  }

  // Correct credentials clear the record, so an ordinary user who mistypes a
  // few times and then succeeds is never left throttled.
  recordLoginSuccess(rateKey);

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
    { session: sessionForUser(await withStoredProfile(user), now.toISOString()) },
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
    { session: sessionForUser(await withStoredProfile(user), verified.issuedAt) },
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


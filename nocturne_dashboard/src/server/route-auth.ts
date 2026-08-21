import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import type { DataScope, User } from "@/types";

if (typeof window !== "undefined") {
  throw new Error("Nocturne route authentication may only run on the server.");
}

/**
 * The session check every API route performs, in one place.
 *
 * The read routes each grew their own copy of this and they have already
 * drifted slightly. The triage actions below are *writes* — they mark incidents
 * mitigated, open Jira tickets, and email a SOC — so a subtly different
 * authenticator on one of them is a materially worse bug than a duplicated one
 * on a read. Everything that mutates goes through this function.
 *
 * The rules it enforces, unchanged from the read routes:
 *   - identity comes from the signed HttpOnly cookie and nothing else;
 *   - the cookie's claims must still match the user directory, so revoking a
 *     user takes effect without waiting for their session to expire;
 *   - an ORG_USER whose organization has been disabled is signed out.
 */

export const API_RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};

export const ORG_ID_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
export const INCIDENT_KEY_PATTERN = /^[a-f0-9]{64}$/i;
/** VW_BREACH_MONITOR keys are either an incident key or a SHA2 of one. */
export const MONITOR_KEY_PATTERN = /^[a-f0-9]{64}$/i;

export interface AuthenticatedCaller {
  user: User;
  /** Scope from the session. Never widened by anything the client sends. */
  scope: DataScope;
  username: string;
}

export type AuthResult =
  | { ok: true; caller: AuthenticatedCaller }
  | { ok: false; response: NextResponse };

export function invalidSessionResponse(): NextResponse {
  const response = NextResponse.json(
    { error: "A valid session is required." },
    { status: 401, headers: API_RESPONSE_HEADERS },
  );
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}

export async function authenticateRequest(): Promise<AuthResult> {
  const cookieStore = await cookies();
  let verified;
  try {
    verified = verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Server session configuration is unavailable." },
        { status: 500, headers: API_RESPONSE_HEADERS },
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

  return {
    ok: true,
    caller: { user, scope: verified.scope, username: user.username },
  };
}

/**
 * Resolves which organization a write applies to.
 *
 * A super admin at fleet scope has no implicit organization, so a write has to
 * name one; an ORG_USER's is fixed by their session and any `orgId` they send
 * is checked against it rather than trusted. This is the one place tenant
 * isolation is decided for every mutating route.
 */
export function resolveWriteScope(
  caller: AuthenticatedCaller,
  requestedOrgId: string | null,
): { ok: true; orgId: string } | { ok: false; response: NextResponse } {
  if (requestedOrgId !== null && !ORG_ID_PATTERN.test(requestedOrgId)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "The requested organization identifier is invalid." },
        { status: 400, headers: API_RESPONSE_HEADERS },
      ),
    };
  }

  if (caller.user.role === "SUPER_ADMIN") {
    if (!requestedOrgId) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "An orgId is required when acting at fleet scope." },
          { status: 400, headers: API_RESPONSE_HEADERS },
        ),
      };
    }
    const organization = organizations.find(
      (candidate) => candidate.orgId === requestedOrgId && candidate.enabled,
    );
    if (!organization) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: "The requested organization is not enabled." },
          { status: 404, headers: API_RESPONSE_HEADERS },
        ),
      };
    }
    return { ok: true, orgId: requestedOrgId };
  }

  const ownOrgId = caller.user.orgId!;
  if (requestedOrgId && requestedOrgId !== ownOrgId) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "You can only act on your own organization." },
        { status: 403, headers: API_RESPONSE_HEADERS },
      ),
    };
  }
  return { ok: true, orgId: ownOrgId };
}

/** Logs the cause server-side and returns a response that reveals none of it. */
export function serviceUnavailable(
  label: string,
  context: string,
  error: unknown,
  message = "This action is temporarily unavailable.",
): NextResponse {
  console.error(
    `[${label}] ${context} failed:`,
    error instanceof Error ? error.message : "unknown server error",
  );
  return NextResponse.json(
    { error: message },
    { status: 503, headers: API_RESPONSE_HEADERS },
  );
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json(
    { error: message },
    { status: 400, headers: API_RESPONSE_HEADERS },
  );
}

export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * The absolute base URL of this console, for links that leave the app.
 *
 * A Jira ticket or a Slack message is read somewhere else entirely, so a
 * relative path in one is useless. This used to depend solely on
 * NOCTURNE_CONSOLE_URL and fall back to an empty string, which produced a link
 * like `/leaks/<key>` and gave no sign anything was wrong until somebody
 * clicked it in a ticket.
 *
 * The request already knows the origin it was reached on, so that is the
 * fallback. Forwarded headers come first because Cloud Run behind Firebase
 * Hosting sees an internal URL, not the address the user typed. The environment
 * variable still wins where it is set, since a deployment reachable on several
 * hostnames may want links pinned to the canonical one.
 */
export function resolveConsoleBaseUrl(request?: Request): string {
  const configured = process.env.NOCTURNE_CONSOLE_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;

  if (request) {
    const forwardedHost = request.headers.get("x-forwarded-host");
    const host = forwardedHost ?? request.headers.get("host");
    if (host) {
      const proto =
        request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
        // Anything not obviously local is assumed to be TLS-terminated.
        ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https");
      return `${proto}://${host}`;
    }
    try {
      return new URL(request.url).origin;
    } catch {
      // Fall through to the warning below.
    }
  }

  console.error(
    "[nocturne] NOCTURNE_CONSOLE_URL is not set and no request origin was "
    + "available; outbound links will be relative and will not resolve.",
  );
  return "";
}

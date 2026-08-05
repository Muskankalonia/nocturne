import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { users } from "@/mocks/organizations";
import {
  ConfigValidationError,
  DEFAULT_ALERT_BANDS,
  getUserProfile,
  normalizeUserProfileUpdate,
  saveUserProfile,
} from "@/server/nocturne-backend";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";
import type { User } from "@/types";
import type { UserProfileRecord } from "@/types/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
};

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
 * There is no `username` parameter anywhere in this route, and that is the
 * point: the only account a request can read or write is the one the signed
 * cookie names. Nothing a client sends can redirect it at another user.
 */
async function authenticate(): Promise<
  { ok: true; user: User } | { ok: false; response: NextResponse }
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
  return { ok: true, user };
}

function unavailable(context: string, error: unknown) {
  console.error(
    `[nocturne-user-profile] ${context} failed:`,
    error instanceof Error ? error.message : "unknown server error",
  );
  return NextResponse.json(
    { error: "Profile settings are temporarily unavailable." },
    { status: 503, headers: RESPONSE_HEADERS },
  );
}

/** The stored row if there is one, otherwise the directory defaults. */
function withDirectoryDefaults(user: User, stored: UserProfileRecord | null) {
  return {
    username: user.username,
    displayName: stored?.displayName ?? user.displayName,
    email: stored?.email ?? user.email,
    position: stored?.position ?? user.position,
    // The backend already resolves an unconfigured NULL to the default bands.
    // Passing that through matters: if the UI defaulted to "off" while the
    // dispatcher defaulted to "on", the switches would understate what is
    // actually being emailed.
    alertBands: stored?.alertBands ?? [...DEFAULT_ALERT_BANDS],
    weeklyDigest: stored?.weeklyDigest ?? true,
    updatedAt: stored?.updatedAt ?? null,
  };
}

export async function GET() {
  const auth = await authenticate();
  if (!auth.ok) return auth.response;

  try {
    const stored = await getUserProfile(auth.user.username);
    return NextResponse.json(
      { profile: withDirectoryDefaults(auth.user, stored) },
      { headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    return unavailable("read", error);
  }
}

export async function PUT(request: Request) {
  const auth = await authenticate();
  if (!auth.ok) return auth.response;

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
    update = normalizeUserProfileUpdate(body);
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
    const stored = await saveUserProfile(auth.user.username, update);
    return NextResponse.json(
      { profile: withDirectoryDefaults(auth.user, stored) },
      { headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    return unavailable("write", error);
  }
}

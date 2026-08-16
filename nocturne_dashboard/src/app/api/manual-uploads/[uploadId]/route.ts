import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { organizations, users } from "@/mocks/organizations";
import { nocturneBackend } from "@/server/nocturne-backend";
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
const UPLOAD_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

interface ManualUploadStatusRouteContext {
  params: Promise<{ uploadId: string }>;
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
  request: Request,
  context: ManualUploadStatusRouteContext,
) {
  const { uploadId } = await context.params;
  if (!UPLOAD_ID_PATTERN.test(uploadId)) {
    return NextResponse.json(
      { error: "The requested upload identifier is invalid." },
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

  const requestedOrgId = new URL(request.url).searchParams.get("orgId");
  let scope: DataScope = verified.scope;
  if (user.role === "SUPER_ADMIN" && requestedOrgId !== null) {
    if (!ORG_ID_PATTERN.test(requestedOrgId)) {
      return NextResponse.json(
        { error: "The requested organization identifier is invalid." },
        { status: 400, headers: RESPONSE_HEADERS },
      );
    }
    const organization = organizations.find(
      (candidate) => candidate.orgId === requestedOrgId && candidate.enabled,
    );
    if (!organization) {
      return NextResponse.json(
        { error: "The requested organization is not enabled." },
        { status: 404, headers: RESPONSE_HEADERS },
      );
    }
    scope = { kind: "org", orgId: requestedOrgId };
  }

  if (scope.kind !== "org") {
    return NextResponse.json(
      { error: "Select one organization to inspect a paste-dump run." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  try {
    const status = await nocturneBackend.getManualUploadStatus(scope, uploadId);
    return NextResponse.json(status, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-manual-upload-status] live query failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return NextResponse.json(
      { error: "Live paste-dump status is temporarily unavailable." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

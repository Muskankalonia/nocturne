import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { users } from "@/mocks/organizations";
import { executePipelineRun } from "@/server/nocturne-backend";
import { invalidateQueryCache } from "@/server/query-cache";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };

/**
 * Manually kicks the ingestion task.
 *
 * The pipeline is normally self-driving: a five-minute scheduled task lands new
 * GCS batches and every AI stage is stream-triggered behind it. This exists for
 * a demo, where waiting out a refresh cycle in front of an audience is not an
 * option.
 *
 * Two deliberate limits. It is SUPER_ADMIN only — a tenant user cannot spend
 * warehouse credits on the account that hosts them. And it starts only the
 * ingest task rather than forcing every AI stage: the downstream tasks fire
 * from their own streams once there is data, so this cannot be used to replay
 * paid extraction over material that was already processed.
 */
const COOLDOWN_MS = 60_000;
let lastRunAt = 0;

function unauthorized() {
  const response = NextResponse.json(
    { error: "A valid session is required." },
    { status: 401, headers: RESPONSE_HEADERS },
  );
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions, maxAge: 0 });
  return response;
}

export async function POST() {
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
  if (!verified) return unauthorized();

  const user = users.find((candidate) => candidate.username === verified.username);
  if (!user || user.role !== verified.role || user.orgId !== verified.orgId) {
    return unauthorized();
  }
  if (user.role !== "SUPER_ADMIN") {
    return NextResponse.json(
      { error: "Only a fleet administrator can start a pipeline run." },
      { status: 403, headers: RESPONSE_HEADERS },
    );
  }

  // Each run costs warehouse time. A cooldown stops an impatient click from
  // queueing the same work several times over.
  const now = Date.now();
  const waited = now - lastRunAt;
  if (waited < COOLDOWN_MS) {
    return NextResponse.json(
      {
        error: `A run was started ${Math.round(waited / 1000)}s ago. Wait ${Math.ceil(
          (COOLDOWN_MS - waited) / 1000,
        )}s before starting another.`,
      },
      { status: 429, headers: RESPONSE_HEADERS },
    );
  }
  lastRunAt = now;

  try {
    const result = await executePipelineRun();
    // The next read should see whatever landed, rather than a cached snapshot
    // taken before the run.
    invalidateQueryCache("command-center");
    invalidateQueryCache("breach-monitor");
    invalidateQueryCache("pipeline");
    return NextResponse.json(result, { headers: RESPONSE_HEADERS });
  } catch (error) {
    lastRunAt = 0; // a failed start should not hold the cooldown
    console.error(
      "[nocturne-pipeline-run] failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return NextResponse.json(
      { error: "Could not start the pipeline run." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

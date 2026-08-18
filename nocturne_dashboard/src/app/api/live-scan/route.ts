import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import type { LiveScanListResponse, LiveScanStartResponse } from "@/lib/live-scan";
import { users } from "@/mocks/organizations";
import {
  CrawlerApiError,
  CrawlerConfigError,
  listCrawlerExecutions,
  startCrawlerRun,
} from "@/server/crawler-job";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store", Vary: "Cookie" };

/**
 * Stops a double-click from spending two crawls. Short, because the real guard
 * is the already-running check below — this one only covers the window between
 * `jobs:run` returning and the new execution becoming visible to `list`.
 */
const COOLDOWN_MS = 20_000;
let lastRunAt = 0;

function unauthorized() {
  const response = NextResponse.json(
    { error: "A valid session is required." },
    { status: 401, headers: RESPONSE_HEADERS },
  );
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions, maxAge: 0 });
  return response;
}

/**
 * A live crawl is account-wide: the deployed crawler image walks every enabled
 * organization in MONITORED_ORGANIZATIONS in one pass. So this is fleet-admin
 * only, the same rule the manual ingest kick uses — a tenant user must not be
 * able to spend the host account's compute, and must not be able to start work
 * that reaches into other tenants' scopes.
 */
async function requireFleetAdmin(): Promise<
  { ok: true } | { ok: false; response: NextResponse }
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
  if (!verified) return { ok: false, response: unauthorized() };

  const user = users.find((candidate) => candidate.username === verified.username);
  if (!user || user.role !== verified.role || user.orgId !== verified.orgId) {
    return { ok: false, response: unauthorized() };
  }
  if (user.role !== "SUPER_ADMIN") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Only a fleet administrator can start a live leak scan." },
        { status: 403, headers: RESPONSE_HEADERS },
      ),
    };
  }
  return { ok: true };
}

function failure(error: unknown, fallback: string) {
  console.error(
    "[nocturne-live-scan] failed:",
    error instanceof Error ? error.message : "unknown server error",
  );
  // Same split the upload route makes: a misconfigured server needs an
  // administrator, an unreachable one needs patience, and telling an analyst to
  // retry a missing IAM binding wastes everybody's afternoon.
  if (error instanceof CrawlerConfigError) {
    return NextResponse.json(
      { error: error.message },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
  if (error instanceof CrawlerApiError && error.status === 400) {
    return NextResponse.json(
      { error: "Not a valid crawler execution." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }
  return NextResponse.json(
    { error: fallback },
    { status: 503, headers: RESPONSE_HEADERS },
  );
}

export async function POST() {
  const auth = await requireFleetAdmin();
  if (!auth.ok) return auth.response;

  const now = Date.now();
  const waited = now - lastRunAt;
  if (waited < COOLDOWN_MS) {
    return NextResponse.json(
      { error: `A scan was just started. Wait ${Math.ceil((COOLDOWN_MS - waited) / 1000)}s.` },
      { status: 429, headers: RESPONSE_HEADERS },
    );
  }

  try {
    // One crawl at a time. Two concurrent Tor crawls fight over exit capacity
    // and produce two partial batches instead of one good one, so an analyst
    // who asks for a second scan gets attached to the one already running
    // rather than told "no".
    const running = (await listCrawlerExecutions(5)).find(
      (execution) => execution.state === "running" || execution.state === "pending",
    );
    if (running) {
      const response: LiveScanStartResponse = {
        executionId: running.executionId,
        statusUrl: `/api/live-scan/${running.executionId}`,
        message: "A live scan is already running. Showing that run.",
      };
      return NextResponse.json(response, { status: 200, headers: RESPONSE_HEADERS });
    }

    lastRunAt = now;
    const execution = await startCrawlerRun();
    const response: LiveScanStartResponse = {
      executionId: execution.executionId,
      statusUrl: `/api/live-scan/${execution.executionId}`,
      message: "Live leak scan started. Tor takes about 90 seconds to bootstrap.",
    };
    return NextResponse.json(response, { status: 202, headers: RESPONSE_HEADERS });
  } catch (error) {
    lastRunAt = 0; // a start that failed should not hold the cooldown
    return failure(error, "Could not start the live leak scan.");
  }
}

export async function GET() {
  const auth = await requireFleetAdmin();
  if (!auth.ok) return auth.response;

  try {
    const response: LiveScanListResponse = {
      executions: await listCrawlerExecutions(8),
      fetchedAt: new Date().toISOString(),
    };
    return NextResponse.json(response, { headers: RESPONSE_HEADERS });
  } catch (error) {
    return failure(error, "Live scan history is temporarily unavailable.");
  }
}

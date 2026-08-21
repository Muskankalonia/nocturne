import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  deriveLiveScanCascade,
  deriveLiveScanStages,
  isLiveScanTerminal,
  type LiveScanCascadeCounts,
  type LiveScanStatusResponse,
} from "@/lib/live-scan";
import { users } from "@/mocks/organizations";
import {
  CrawlerApiError,
  CrawlerConfigError,
  fetchCrawlerLogs,
  getCrawlerExecution,
} from "@/server/crawler-job";
import { copyLiveCrawlerRunToRaw, getCrawlRunCascade } from "@/server/nocturne-backend";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  verifySessionToken,
} from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store", Vary: "Cookie" };
const EXECUTION_ID_PATTERN = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;
const GCS_OUTPUT_PATTERN = /\bOutput:\s*(gs:\/\/[^\s]+)/i;
const handoffPromises = new Map<
  string,
  Promise<Awaited<ReturnType<typeof copyLiveCrawlerRunToRaw>>>
>();

interface LiveScanStatusRouteContext {
  params: Promise<{ executionId: string }>;
}

function unauthorized() {
  const response = NextResponse.json(
    { error: "A valid session is required." },
    { status: 401, headers: RESPONSE_HEADERS },
  );
  response.cookies.set(SESSION_COOKIE_NAME, "", { ...sessionCookieOptions, maxAge: 0 });
  return response;
}

function latestCrawlerOutputPath(logs: { text: string }[]): string | null {
  for (const line of [...logs].reverse()) {
    const match = GCS_OUTPUT_PATTERN.exec(line.text);
    if (match?.[1]) return match[1].replace(/[),.;]+$/, "");
  }
  return null;
}

async function runSnowflakeHandoffOnce(executionId: string, outputPath: string | null) {
  let handoff = handoffPromises.get(executionId);
  if (!handoff) {
    handoff = copyLiveCrawlerRunToRaw(executionId, outputPath).then((result) => {
      // If the object is visible in GCS but Snowflake has not exposed load
      // history / rows yet, try again on the next poll rather than caching a
      // temporary zero forever.
      if (result.rawRows === 0) handoffPromises.delete(executionId);
      return result;
    });
    handoff.catch(() => handoffPromises.delete(executionId));
    handoffPromises.set(executionId, handoff);
  }
  return handoff;
}

export async function GET(request: Request, context: LiveScanStatusRouteContext) {
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
  const { executionId } = await context.params;
  if (!EXECUTION_ID_PATTERN.test(executionId)) {
    return NextResponse.json(
      { error: "The requested execution identifier is invalid." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  const url = new URL(request.url);
  const since = url.searchParams.get("since");

  try {
    // Status and logs together: two round trips from the browser would let the
    // rail and the console disagree by one poll interval, which shows up as a
    // stage lighting up a beat before the line that explains it.
    // Raw crawler stdout names every organization in the sweep and every onion
    // host it touched. A run of one organization only ever names that one, so
    // its owner may read it; a scheduled fleet sweep names them all and stays
    // fleet-only.
    //
    // Checked against the execution's own ORG_ID override rather than anything
    // the caller sent, and after the execution is fetched, so a guessed
    // execution id cannot be used to read another tenant's run.
    const execution = await getCrawlerExecution(executionId);
    if (user.role !== "SUPER_ADMIN" && execution.orgId !== user.orgId) {
      return NextResponse.json(
        {
          error: execution.orgId
            ? "That scan belongs to another organization."
            : "Fleet-wide scan logs are restricted to fleet administrators.",
        },
        { status: 403, headers: RESPONSE_HEADERS },
      );
    }

    // The execution is already in hand from the ownership check above; only the
    // logs are still outstanding.
    const logs = await fetchCrawlerLogs(executionId, { since });

    let snowflakeHandoff: Awaited<ReturnType<typeof copyLiveCrawlerRunToRaw>> | null = null;
    const handoffLogs: LiveScanStatusResponse["handoffLogs"] = [];
    if (execution.state === "succeeded") {
      try {
        snowflakeHandoff = await runSnowflakeHandoffOnce(
          execution.executionId,
          latestCrawlerOutputPath(logs),
        );
        handoffLogs.push({
          id:
            snowflakeHandoff.rawRows > 0
              ? `snowflake-handoff-${execution.executionId}-loaded`
              : `snowflake-handoff-${execution.executionId}-waiting`,
          timestamp: snowflakeHandoff.copiedAt,
          text: `Snowflake handoff: ${snowflakeHandoff.detail}`,
          tone: snowflakeHandoff.rawRows > 0 ? "ok" : "ion",
          stage: snowflakeHandoff.rawRows > 0 ? "handoff" : null,
        });
      } catch (handoffError) {
        handoffLogs.push({
          id: `snowflake-handoff-${execution.executionId}-failed`,
          timestamp: new Date().toISOString(),
          text: `Snowflake handoff failed: ${
            handoffError instanceof Error ? handoffError.message : "unknown error"
          }`,
          tone: "critical",
          stage: null,
        });
      }
    }

    // Where the batch has reached in L0-L4, once there is a batch to ask about.
    // Only worth a query after Cloud Run exited: before that the crawler has
    // written nothing to GCS, so the answer is always "no rows" and every poll
    // would spend a warehouse round trip proving it. Failure here is not fatal
    // to the response — the crawl rail above it is still the whole story of the
    // run, and losing the cascade counts should not cost an analyst their logs.
    let cascade: LiveScanCascadeCounts | null = null;
    if (execution.state === "succeeded") {
      try {
        cascade = await getCrawlRunCascade(execution.executionId);
      } catch (cascadeError) {
        console.warn(
          "[nocturne-live-scan-status] cascade counts unavailable:",
          cascadeError instanceof Error ? cascadeError.message : "unknown server error",
        );
      }
    }

    const stageLogs = handoffLogs.length > 0 ? [...logs, ...handoffLogs] : logs;
    const response: LiveScanStatusResponse = {
      execution,
      // Derived from this window of logs only. The client re-derives from its
      // full buffer, which is the authoritative rail; this value is what a
      // caller polling the API directly would want.
      stages: deriveLiveScanStages(execution, stageLogs),
      logs,
      handoffLogs,
      snowflakeHandoff,
      cascade,
      cascadeStages: deriveLiveScanCascade(cascade),
      cursor: logs.length > 0 ? logs[logs.length - 1].timestamp : null,
      isTerminal: isLiveScanTerminal(execution),
      fetchedAt: new Date().toISOString(),
    };
    return NextResponse.json(response, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-live-scan-status] failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    if (error instanceof CrawlerConfigError) {
      return NextResponse.json(
        { error: error.message },
        { status: 500, headers: RESPONSE_HEADERS },
      );
    }
    if (error instanceof CrawlerApiError && error.status === 404) {
      return NextResponse.json(
        { error: "That crawler execution no longer exists." },
        { status: 404, headers: RESPONSE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: "Live scan status is temporarily unavailable." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

import { NextResponse } from "next/server";

import {
  API_RESPONSE_HEADERS,
  MONITOR_KEY_PATTERN,
  authenticateRequest,
  badRequest,
  readJsonBody,
  resolveWriteScope,
  serviceUnavailable,
} from "@/server/route-auth";
import {
  findMonitorRow,
  getScreenshot,
  recordAction,
  requestScreenshot,
} from "@/server/triage-actions";
import type { PageScreenshot } from "@/types/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Headless-browser captures of a needs-review page, so an admin can see what
 * the page actually says before ruling on it.
 *
 *   GET  ?orgId=…&monitorKey=…  — current capture state, for polling.
 *   POST { orgId, monitorKey }  — queue a capture.
 *
 * The console never fetches the page itself. It writes a row to
 * NOCTURNE.CONFIG.PAGE_SCREENSHOTS and a worker with Tor in front of it does
 * the fetching, out of process. That split is not an implementation detail: the
 * console runs on Cloud Run with no Tor route and privileged Snowflake
 * credentials in its environment, and it is the last process that should be
 * rendering an adversary's page.
 *
 * The URL to capture comes from VW_BREACH_MONITOR, looked up by monitor key —
 * never from the request. A caller who could name the URL would have a
 * server-side request forgery with an anonymity network attached.
 */

/** The image is proxied, never linked: see the note in src/server/gcs.ts. */
function viewUrlFor(orgId: string, monitorKey: string): string {
  return `/api/screenshots/${encodeURIComponent(monitorKey)}/image?orgId=${encodeURIComponent(orgId)}`;
}

function present(
  screenshot: (PageScreenshot & { objectUri: string | null }) | null,
): PageScreenshot | null {
  if (!screenshot) return null;
  const { objectUri, ...rest } = screenshot;
  return {
    ...rest,
    viewUrl:
      objectUri && screenshot.status === "captured"
        ? viewUrlFor(screenshot.orgId, screenshot.monitorKey)
        : null,
  };
}

export async function GET(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const monitorKey = params.get("monitorKey");
  if (!monitorKey || !MONITOR_KEY_PATTERN.test(monitorKey)) {
    return badRequest("A valid monitorKey is required.");
  }

  const scoped = resolveWriteScope(auth.caller, params.get("orgId"));
  if (!scoped.ok) return scoped.response;

  try {
    const screenshot = await getScreenshot(scoped.orgId, monitorKey);
    return NextResponse.json(
      { screenshot: present(screenshot) },
      { headers: API_RESPONSE_HEADERS },
    );
  } catch (error) {
    return serviceUnavailable(
      "nocturne-screenshots",
      "read",
      error,
      "Reading the capture status failed.",
    );
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const body = (await readJsonBody(request)) as {
    orgId?: string;
    monitorKey?: string;
    refresh?: boolean;
  } | null;

  const monitorKey = body?.monitorKey;
  if (!monitorKey || !MONITOR_KEY_PATTERN.test(monitorKey)) {
    return badRequest("A valid monitorKey is required.");
  }

  const scoped = resolveWriteScope(auth.caller, body?.orgId ?? null);
  if (!scoped.ok) return scoped.response;

  try {
    const row = await findMonitorRow(scoped.orgId, monitorKey);
    if (!row) {
      return NextResponse.json(
        { error: "That monitor row was not found." },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }
    if (!row.url) {
      return badRequest("That row has no source URL to capture.");
    }

    await requestScreenshot({
      orgId: scoped.orgId,
      monitorKey,
      dedupeKey: row.dedupeKey,
      url: row.url,
      requestedBy: auth.caller.username,
      refresh: body?.refresh === true,
    });
    const screenshot = await getScreenshot(scoped.orgId, monitorKey);

    await recordAction({
      orgId: scoped.orgId,
      incidentKey: row.incidentKey,
      action: "request_screenshot",
      actor: auth.caller.username,
      outcome: "success",
      summary: `Queued a page capture for review of "${row.title.slice(0, 80)}"`,
      detail: { monitorKey, refresh: body?.refresh === true },
    });

    return NextResponse.json(
      { screenshot: present(screenshot) },
      { headers: API_RESPONSE_HEADERS },
    );
  } catch (error) {
    return serviceUnavailable(
      "nocturne-screenshots",
      "queue capture",
      error,
      "Queueing the page capture failed.",
    );
  }
}

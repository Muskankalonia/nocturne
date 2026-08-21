import { NextResponse } from "next/server";

import { invalidateIncidentViews } from "@/server/query-cache";

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
  clearReviewDecision,
  findMonitorRow,
  recordAction,
  recordReviewDecision,
} from "@/server/triage-actions";
import type { ReviewDecision } from "@/types/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NOTE_LENGTH = 500;

/**
 * The admin's verdict on a needs-review row, after looking at the captured page.
 *
 *   POST   { orgId, monitorKey, decision, note? }  — record a ruling
 *   DELETE ?orgId=…&monitorKey=…                   — withdraw it
 *
 * Recording a ruling changes what the Breach Monitor shows for that row, but it
 * does not rewrite what the cascade concluded: VW_BREACH_MONITOR keeps the
 * pipeline's own verdict in PIPELINE_MONITOR_STATUS alongside the effective
 * one. A product whose entire claim is that its reasoning is inspectable cannot
 * quietly overwrite that reasoning when a human disagrees with it.
 *
 * Any signed-in user may rule on a row in their own organization. This was
 * briefly restricted to super admins, which was inconsistent: marking an
 * incident mitigated removes it from the same queues and was never restricted,
 * and an analyst who can dispatch a SOC alert about their own data can
 * certainly say it is not theirs. Tenant isolation is the real boundary, and it
 * is enforced below by resolveWriteScope plus the findMonitorRow lookup —
 * neither of which trusts the caller's orgId.
 */

function isDecision(value: unknown): value is ReviewDecision {
  return value === "confirmed_breach" || value === "not_a_breach";
}

export async function POST(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const body = (await readJsonBody(request)) as {
    orgId?: string;
    monitorKey?: string;
    decision?: unknown;
    note?: unknown;
  } | null;

  const monitorKey = body?.monitorKey;
  if (!monitorKey || !MONITOR_KEY_PATTERN.test(monitorKey)) {
    return badRequest("A valid monitorKey is required.");
  }
  if (!isDecision(body?.decision)) {
    return badRequest("decision must be confirmed_breach or not_a_breach.");
  }

  const scoped = resolveWriteScope(auth.caller, body?.orgId ?? null);
  if (!scoped.ok) return scoped.response;

  const note =
    typeof body?.note === "string" && body.note.trim()
      ? body.note.trim().slice(0, MAX_NOTE_LENGTH)
      : null;

  try {
    const row = await findMonitorRow(scoped.orgId, monitorKey);
    if (!row) {
      return NextResponse.json(
        { error: "That monitor row was not found." },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }

    await recordReviewDecision({
      orgId: scoped.orgId,
      monitorKey,
      decision: body!.decision as ReviewDecision,
      note,
      decidedBy: auth.caller.username,
    });

    invalidateIncidentViews();

    await recordAction({
      orgId: scoped.orgId,
      incidentKey: row.incidentKey,
      action: "review_decision",
      actor: auth.caller.username,
      outcome: "success",
      summary: `Ruled ${
        body!.decision === "confirmed_breach" ? "a confirmed breach" : "not a breach"
      }: "${row.title.slice(0, 80)}"`,
      detail: { monitorKey, decision: body!.decision, note },
    });

    return NextResponse.json(
      {
        monitorKey,
        decision: body!.decision,
        decidedBy: auth.caller.username,
        decidedAt: new Date().toISOString(),
      },
      { headers: API_RESPONSE_HEADERS },
    );
  } catch (error) {
    return serviceUnavailable(
      "nocturne-review-decision",
      "record",
      error,
      "Recording the review decision failed.",
    );
  }
}

export async function DELETE(request: Request) {
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
    await clearReviewDecision(scoped.orgId, monitorKey);
    invalidateIncidentViews();
    await recordAction({
      orgId: scoped.orgId,
      action: "review_decision",
      actor: auth.caller.username,
      outcome: "success",
      summary: "Withdrew a review decision; the row returns to the cascade's verdict",
      detail: { monitorKey },
    });
    return NextResponse.json({ monitorKey, decision: null }, { headers: API_RESPONSE_HEADERS });
  } catch (error) {
    return serviceUnavailable(
      "nocturne-review-decision",
      "withdraw",
      error,
      "Withdrawing the review decision failed.",
    );
  }
}

import { NextResponse } from "next/server";

import {
  propagateMitigation,
  propagateUnmitigation,
} from "@/server/integrations/soc-dispatch";
import {
  API_RESPONSE_HEADERS,
  INCIDENT_KEY_PATTERN,
  authenticateRequest,
  badRequest,
  readJsonBody,
  resolveWriteScope,
  serviceUnavailable,
} from "@/server/route-auth";
import {
  getIncidentActionState,
  recordAction,
  setIncidentRemediation,
} from "@/server/triage-actions";
import type { MitigationResponse } from "@/types/triage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NOTE_LENGTH = 500;

interface RouteContext {
  params: Promise<{ incidentKey: string }>;
}

/**
 * Mark one incident mitigated (POST) or reopen it (DELETE).
 *
 * The write to Snowflake happens first and the external systems follow. That
 * ordering is deliberate: if Jira is unreachable, the analyst's decision is
 * still recorded and the console reports "mitigated, ticket not closed" —
 * which is recoverable. The other order would leave a closed ticket for an
 * incident the warehouse still calls open, which nothing here would ever
 * reconcile.
 */

function noteFrom(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>).note;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.slice(0, MAX_NOTE_LENGTH) : null;
}

function orgIdFrom(request: Request, body: unknown): string | null {
  const fromQuery = new URL(request.url).searchParams.get("orgId");
  if (fromQuery) return fromQuery;
  if (body && typeof body === "object") {
    const raw = (body as Record<string, unknown>).orgId;
    if (typeof raw === "string") return raw;
  }
  return null;
}

export async function POST(request: Request, context: RouteContext) {
  return applyMitigation(request, context, true);
}

export async function DELETE(request: Request, context: RouteContext) {
  return applyMitigation(request, context, false);
}

async function applyMitigation(
  request: Request,
  context: RouteContext,
  mitigated: boolean,
) {
  const { incidentKey } = await context.params;
  if (!INCIDENT_KEY_PATTERN.test(incidentKey)) {
    return badRequest("The requested incident identifier is invalid.");
  }

  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  // DELETE bodies are legal but rarely sent; treat a missing one as empty
  // rather than as a malformed request.
  const body = await readJsonBody(request);
  const scoped = resolveWriteScope(auth.caller, orgIdFrom(request, body));
  if (!scoped.ok) return scoped.response;

  try {
    const before = await getIncidentActionState(scoped.orgId, incidentKey);
    if (!before) {
      // Same response for "no such incident" and "not yours", so incident keys
      // stay unprobeable across tenants.
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }

    await setIncidentRemediation({
      orgId: scoped.orgId,
      incidentKey,
      // Reopening returns the incident to "investigating" rather than "new":
      // somebody has demonstrably looked at it, and pretending otherwise would
      // put it back at the top of an untouched-incidents queue.
      status: mitigated ? "mitigated" : "investigating",
      actor: auth.caller.username,
      note: noteFrom(body),
      via: "console",
    });

    let jira = null;
    if (mitigated) {
      jira = await propagateMitigation({
        orgId: scoped.orgId,
        incidentKey,
        actor: auth.caller.username,
        state: before,
      });
    } else {
      await propagateUnmitigation({
        orgId: scoped.orgId,
        incidentKey,
        actor: auth.caller.username,
        state: before,
      });
    }

    const after = await getIncidentActionState(scoped.orgId, incidentKey);

    await recordAction({
      orgId: scoped.orgId,
      incidentKey,
      action: mitigated ? "mark_mitigated" : "unmark_mitigated",
      actor: auth.caller.username,
      outcome: jira && !jira.delivered && jira.configured ? "partial" : "success",
      summary: mitigated
        ? `Marked mitigated by ${auth.caller.username}${
            jira?.delivered ? ` · closed ${jira.externalId}` : ""
          }`
        : `Reopened by ${auth.caller.username}`,
      detail: { jiraIssueKey: before.jiraIssueKey, jiraError: jira?.error ?? null },
    });

    const response: MitigationResponse = {
      incidentKey,
      state: after ?? before,
      jira,
    };
    return NextResponse.json(response, { headers: API_RESPONSE_HEADERS });
  } catch (error) {
    return serviceUnavailable(
      "nocturne-mitigate",
      mitigated ? "mark mitigated" : "unmark mitigated",
      error,
      "Updating the incident status failed. Nothing was changed.",
    );
  }
}

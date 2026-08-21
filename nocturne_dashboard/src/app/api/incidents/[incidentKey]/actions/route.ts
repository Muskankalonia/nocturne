import { NextResponse } from "next/server";

import { isMailConfigured } from "@/server/alert-mailer";
import {
  resolveJiraConfig,
  resolveSlackConfig,
} from "@/server/integration-settings";
import {
  API_RESPONSE_HEADERS,
  INCIDENT_KEY_PATTERN,
  authenticateRequest,
  badRequest,
  resolveWriteScope,
  serviceUnavailable,
} from "@/server/route-auth";
import { getIncidentActionState } from "@/server/triage-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ incidentKey: string }>;
}

/**
 * One incident's action state, plus which channels this deployment can actually
 * reach.
 *
 * The console needs the second part to label its buttons honestly. Offering
 * "Dispatch SOC alert" on a deployment with no email, Jira, or Slack configured
 * produces a button that succeeds at doing nothing, which is worse than a
 * disabled one that says why.
 */
export async function GET(request: Request, context: RouteContext) {
  const { incidentKey } = await context.params;
  if (!INCIDENT_KEY_PATTERN.test(incidentKey)) {
    return badRequest("The requested incident identifier is invalid.");
  }

  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const scoped = resolveWriteScope(
    auth.caller,
    new URL(request.url).searchParams.get("orgId"),
  );
  if (!scoped.ok) return scoped.response;

  try {
    const [state, jira, slack] = await Promise.all([
      getIncidentActionState(scoped.orgId, incidentKey),
      resolveJiraConfig(scoped.orgId),
      resolveSlackConfig(scoped.orgId),
    ]);
    if (!state) {
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }

    return NextResponse.json(
      {
        state,
        channels: {
          email: isMailConfigured(),
          jira: jira !== null,
          slack: slack !== null,
        },
        fetchedAt: new Date().toISOString(),
      },
      { headers: API_RESPONSE_HEADERS },
    );
  } catch (error) {
    return serviceUnavailable(
      "nocturne-incident-actions",
      "read",
      error,
      "Reading the incident action state failed.",
    );
  }
}

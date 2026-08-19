import { NextResponse } from "next/server";

import {
  NoRecipientsError,
  dispatchSocAlert,
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
import { getIncidentActionState, recordAction } from "@/server/triage-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ incidentKey: string }>;
}

/**
 * "Dispatch SOC alert" — emails the organization's recipients, opens a Jira
 * ticket, and posts to Slack, for whichever of those are configured.
 *
 * Re-dispatch requires `force: true` in the body. The console asks for a
 * confirmation before setting it. Without that gate, a double-click pages a
 * SOC twice, and a page that arrives twice for the same incident is how a team
 * learns to stop reading them.
 */
export async function POST(request: Request, context: RouteContext) {
  const { incidentKey } = await context.params;
  if (!INCIDENT_KEY_PATTERN.test(incidentKey)) {
    return badRequest("The requested incident identifier is invalid.");
  }

  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const body = (await readJsonBody(request)) as {
    orgId?: string;
    force?: boolean;
  } | null;

  const scoped = resolveWriteScope(
    auth.caller,
    body?.orgId ?? new URL(request.url).searchParams.get("orgId"),
  );
  if (!scoped.ok) return scoped.response;

  try {
    const state = await getIncidentActionState(scoped.orgId, incidentKey);
    if (!state) {
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }

    if (state.hasBeenDispatched && body?.force !== true) {
      return NextResponse.json(
        {
          error: "This incident has already been dispatched.",
          alreadyDispatched: true,
          state,
        },
        { status: 409, headers: API_RESPONSE_HEADERS },
      );
    }

    const result = await dispatchSocAlert({
      orgId: scoped.orgId,
      incidentKey,
      actor: auth.caller.username,
    });

    const configured = result.results.filter((channel) => channel.configured);
    await recordAction({
      orgId: scoped.orgId,
      incidentKey,
      action: "dispatch_soc_alert",
      actor: auth.caller.username,
      outcome: result.outcome,
      summary: configured.length
        ? `Dispatched to ${configured
            .map((channel) => `${channel.channel}${channel.delivered ? "" : " (failed)"}`)
            .join(", ")}`
        : "No delivery channel is configured on this deployment.",
      detail: {
        channels: result.results.map((channel) => ({
          channel: channel.channel,
          configured: channel.configured,
          delivered: channel.delivered,
          externalId: channel.externalId,
        })),
      },
    });

    return NextResponse.json(result, { headers: API_RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof NoRecipientsError) {
      return NextResponse.json(
        { error: error.message },
        { status: 404, headers: API_RESPONSE_HEADERS },
      );
    }
    return serviceUnavailable(
      "nocturne-soc-dispatch",
      "dispatch",
      error,
      "Dispatching the SOC alert failed.",
    );
  }
}

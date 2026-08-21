import { NextResponse } from "next/server";

import {
  resolveJiraConfig,
  resolveSlackConfig,
} from "@/server/integration-settings";
import {
  testJiraConnection,
  testSlackConnection,
} from "@/server/integrations/test-connection";
import {
  API_RESPONSE_HEADERS,
  authenticateRequest,
  badRequest,
  readJsonBody,
  resolveWriteScope,
  serviceUnavailable,
} from "@/server/route-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Checks the saved configuration against the live provider.
 *
 * POST rather than GET because it reaches out to a third party, which is a side
 * effect even when every call is a read — it consumes the provider's rate
 * budget and appears in their audit log.
 *
 * It tests what is *stored*, not what is currently typed into the form. That is
 * the honest thing to verify: the stored value is what a dispatch will use at
 * three in the morning, and a test that passed against an unsaved draft would
 * be reassuring about a configuration that does not exist.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const body = (await readJsonBody(request)) as {
    provider?: string;
    orgId?: string;
  } | null;

  const provider = body?.provider;
  if (provider !== "jira" && provider !== "slack") {
    return badRequest("provider must be jira or slack.");
  }

  const scoped = resolveWriteScope(auth.caller, body?.orgId ?? null);
  if (!scoped.ok) return scoped.response;

  try {
    if (provider === "jira") {
      const config = await resolveJiraConfig(scoped.orgId);
      if (!config) {
        return NextResponse.json(
          {
            provider,
            ok: false,
            summary: "Jira is not configured for this organization yet.",
            checks: [],
          },
          { headers: API_RESPONSE_HEADERS },
        );
      }
      return NextResponse.json(await testJiraConnection(config), {
        headers: API_RESPONSE_HEADERS,
      });
    }

    const config = await resolveSlackConfig(scoped.orgId);
    if (!config) {
      return NextResponse.json(
        {
          provider,
          ok: false,
          summary: "Slack is not configured for this organization yet.",
          checks: [],
        },
        { headers: API_RESPONSE_HEADERS },
      );
    }
    return NextResponse.json(await testSlackConnection(config), {
      headers: API_RESPONSE_HEADERS,
    });
  } catch (error) {
    return serviceUnavailable(
      "nocturne-integration-test",
      `${provider} test`,
      error,
      "The connection test could not be run.",
    );
  }
}

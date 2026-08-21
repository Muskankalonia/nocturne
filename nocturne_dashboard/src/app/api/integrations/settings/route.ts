import { NextResponse } from "next/server";

import {
  IntegrationValidationError,
  deleteIntegrationSettings,
  listIntegrationSettings,
  normalizeIntegrationInput,
  saveIntegrationSettings,
} from "@/server/integration-settings";
import {
  API_RESPONSE_HEADERS,
  authenticateRequest,
  badRequest,
  readJsonBody,
  resolveWriteScope,
  serviceUnavailable,
} from "@/server/route-auth";
import { isSecretStorageConfigured } from "@/server/secrets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Jira and Slack credentials for one organization.
 *
 *   GET    ?orgId=…                        — current configuration, secrets masked
 *   PUT    { provider, settings, secrets } — save; omitted secrets are kept
 *   DELETE ?provider=…&orgId=…             — disconnect and erase the credential
 *
 * The response never contains a stored secret, in any form that could be
 * reassembled — not even for the user who typed it. A saved token is reported
 * as a boolean and a masked hint, which is all the form needs to show that
 * something is configured without becoming a way to read it back out.
 */

export async function GET(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const scoped = resolveWriteScope(
    auth.caller,
    new URL(request.url).searchParams.get("orgId"),
  );
  if (!scoped.ok) return scoped.response;

  try {
    const integrations = await listIntegrationSettings(scoped.orgId);
    return NextResponse.json(
      {
        orgId: scoped.orgId,
        integrations,
        // The form disables its credential fields when the server has no key,
        // rather than accepting a token it would fail to store.
        secretStorageReady: isSecretStorageConfigured(),
        fetchedAt: new Date().toISOString(),
      },
      { headers: API_RESPONSE_HEADERS },
    );
  } catch (error) {
    return serviceUnavailable(
      "nocturne-integration-settings",
      "read",
      error,
      "Reading the integration settings failed.",
    );
  }
}

export async function PUT(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("A JSON body is required.");

  const scoped = resolveWriteScope(
    auth.caller,
    (body as { orgId?: string }).orgId ?? null,
  );
  if (!scoped.ok) return scoped.response;

  let input;
  try {
    input = normalizeIntegrationInput(body);
  } catch (error) {
    if (error instanceof IntegrationValidationError) {
      return badRequest(error.message);
    }
    throw error;
  }

  try {
    await saveIntegrationSettings(scoped.orgId, {
      ...input,
      actor: auth.caller.username,
    });
    const integrations = await listIntegrationSettings(scoped.orgId);
    return NextResponse.json({ integrations }, { headers: API_RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof IntegrationValidationError) {
      return badRequest(error.message);
    }
    return serviceUnavailable(
      "nocturne-integration-settings",
      "write",
      error,
      "Saving the integration settings failed.",
    );
  }
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const provider = params.get("provider");
  if (provider !== "jira" && provider !== "slack") {
    return badRequest("provider must be jira or slack.");
  }

  const scoped = resolveWriteScope(auth.caller, params.get("orgId"));
  if (!scoped.ok) return scoped.response;

  try {
    await deleteIntegrationSettings(scoped.orgId, provider);
    const integrations = await listIntegrationSettings(scoped.orgId);
    return NextResponse.json({ integrations }, { headers: API_RESPONSE_HEADERS });
  } catch (error) {
    return serviceUnavailable(
      "nocturne-integration-settings",
      "delete",
      error,
      "Disconnecting the integration failed.",
    );
  }
}

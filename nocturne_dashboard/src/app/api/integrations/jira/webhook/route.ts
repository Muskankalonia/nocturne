import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { postSlackFollowUp } from "@/server/integrations/slack";
import {
  findIncidentByJiraIssue,
  getIncidentActionState,
  recordAction,
  recordIntegration,
  setIncidentRemediation,
} from "@/server/triage-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };
/** Jira webhook bodies are small; anything larger is not one. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Inbound half of the Jira close-sync: a ticket moved to Done marks its
 * incident mitigated in Nocturne.
 *
 * This is the only route in the console that accepts instructions from an
 * external system, so it is the one place where the request body is treated as
 * hostile input throughout:
 *
 *   - authentication is a shared secret, either as an HMAC over the raw body
 *     (JIRA_WEBHOOK_SECRET, preferred) or a bearer token, compared in constant
 *     time;
 *   - the body's claim about *which* incident is never trusted. The issue key
 *     is looked up in INCIDENT_INTEGRATIONS, and an issue Nocturne did not open
 *     resolves to nothing and is ignored;
 *   - only one state change is reachable from here — mitigated — regardless of
 *     what the payload asks for.
 *
 * Configure in Jira: Settings → System → Webhooks, events `jira:issue_updated`,
 * URL `<console>/api/integrations/jira/webhook?token=…` or with the secret set
 * as an `X-Hub-Signature-256` header.
 */

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isAuthorized(request: Request, rawBody: string): boolean {
  const secret = process.env.JIRA_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 16) {
    console.error(
      "[nocturne-jira-webhook] JIRA_WEBHOOK_SECRET is unset or too short; rejecting.",
    );
    return false;
  }

  const signature = request.headers.get("x-hub-signature-256");
  if (signature) {
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
    return constantTimeEquals(signature, expected);
  }

  // Fallback for Jira Cloud automations that cannot sign: the same secret as a
  // bearer token or query parameter. Weaker — it is replayable — but the only
  // action it can drive is idempotent.
  const header = request.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (bearer) return constantTimeEquals(bearer, secret);

  const token = new URL(request.url).searchParams.get("token") ?? "";
  return token ? constantTimeEquals(token, secret) : false;
}

interface JiraWebhookBody {
  webhookEvent?: string;
  issue?: {
    key?: string;
    fields?: {
      status?: { name?: string; statusCategory?: { key?: string } };
      resolution?: { name?: string } | null;
    };
  };
  changelog?: { items?: Array<{ field?: string; toString?: string }> };
}

/**
 * Jira workflows name their columns whatever they like, so "closed" is decided
 * by the status *category* — `done` is one of Jira's three fixed categories and
 * survives a project renaming its column to "Shipped".
 */
function isClosed(body: JiraWebhookBody): boolean {
  const category = body.issue?.fields?.status?.statusCategory?.key;
  if (category === "done") return true;
  return Boolean(body.issue?.fields?.resolution);
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Payload too large." },
      { status: 413, headers: RESPONSE_HEADERS },
    );
  }

  if (!isAuthorized(request, rawBody)) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401, headers: RESPONSE_HEADERS },
    );
  }

  let body: JiraWebhookBody;
  try {
    body = JSON.parse(rawBody) as JiraWebhookBody;
  } catch {
    return NextResponse.json(
      { error: "A JSON body is required." },
      { status: 400, headers: RESPONSE_HEADERS },
    );
  }

  const issueKey = body.issue?.key;
  // Jira's own key format. Rejecting anything else keeps a crafted key out of
  // the lookup, and the lookup binds it anyway.
  if (!issueKey || !/^[A-Z][A-Z0-9_]{1,20}-\d{1,10}$/.test(issueKey)) {
    return NextResponse.json({ ignored: "no-issue-key" }, { headers: RESPONSE_HEADERS });
  }

  if (!isClosed(body)) {
    // Every other transition is a legitimate event we simply do not act on.
    // 200, not an error: a webhook that returns failures gets disabled by Jira.
    return NextResponse.json({ ignored: "not-closed" }, { headers: RESPONSE_HEADERS });
  }

  try {
    const link = await findIncidentByJiraIssue(issueKey);
    if (!link) {
      return NextResponse.json(
        { ignored: "unknown-issue" },
        { headers: RESPONSE_HEADERS },
      );
    }

    const state = await getIncidentActionState(link.orgId, link.incidentKey);
    if (state?.remediationStatus === "mitigated") {
      // Already there. Jira fires several events for one transition, and this
      // is what stops the second from re-writing MITIGATED_AT.
      return NextResponse.json(
        { ignored: "already-mitigated" },
        { headers: RESPONSE_HEADERS },
      );
    }

    await setIncidentRemediation({
      orgId: link.orgId,
      incidentKey: link.incidentKey,
      status: "mitigated",
      actor: `jira:${issueKey}`,
      note: `Closed in Jira (${body.issue?.fields?.status?.name ?? "done"}).`,
      via: "jira",
    });

    await recordIntegration({
      orgId: link.orgId,
      incidentKey: link.incidentKey,
      channel: "jira",
      externalId: issueKey,
      externalUrl: state?.jiraIssueUrl ?? null,
      state: "closed",
      error: null,
      actor: `jira:${issueKey}`,
    });

    if (state?.slackState) {
      void postSlackFollowUp(
        `:white_check_mark: *Mitigated* — ${state.organizationName}: ${state.title}\nClosed in Jira as ${issueKey}.`,
        state.slackMessageTs,
      ).catch(() => undefined);
    }

    await recordAction({
      orgId: link.orgId,
      incidentKey: link.incidentKey,
      action: "mark_mitigated",
      actor: `jira:${issueKey}`,
      outcome: "success",
      summary: `Marked mitigated because ${issueKey} was closed in Jira`,
      detail: { issueKey, status: body.issue?.fields?.status?.name ?? null },
    });

    return NextResponse.json(
      { mitigated: true, incidentKey: link.incidentKey },
      { headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    console.error(
      "[nocturne-jira-webhook] processing failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    // 503 rather than 500: Jira retries on 5xx, and this failure mode is a
    // warehouse blip that a retry genuinely fixes.
    return NextResponse.json(
      { error: "Processing failed." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

import { createHmac, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { postSlackFollowUp } from "@/server/integrations/slack";
import { resolveSlackConfig } from "@/server/integration-settings";
import {
  clearReviewDecision,
  findIncidentByJiraIssue,
  getIncidentActionState,
  recordAction,
  recordIntegration,
  recordReviewDecision,
  setIncidentRemediation,
} from "@/server/triage-actions";
import { invalidateIncidentViews } from "@/server/query-cache";
import type { RemediationStatus } from "@/types";
import type { ReviewDecision } from "@/types/triage";

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
 * What a Jira column means in Nocturne's vocabulary.
 *
 * A board mirroring Nocturne's statuses should drive them, not just the one
 * "done" transition. Two independent axes live behind these names:
 *
 *   remediation — has this been worked?  new / investigating / mitigated
 *   review      — is this ours at all?   confirmed_breach / not_a_breach
 *
 * A ticket sits in one column at a time, so a move sets one axis and leaves the
 * other alone. Dragging to "Confirmed Breach" says nothing about whether the
 * work is done, and dragging to "Mitigated" says nothing about whether the
 * finding was ever disputed.
 */
type JiraSyncAction =
  | { axis: "remediation"; status: RemediationStatus }
  | { axis: "review"; decision: ReviewDecision }
  | { axis: "review"; decision: null }
  | null;

/** Lowercased, punctuation and spacing removed, so "In-Progress" === "in progress". */
function normalizeStatusName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, " ").trim();
}

/**
 * Matched on the column's *name* first, because a board that has deliberately
 * mirrored Nocturne's statuses is telling us exactly what it means. Only when a
 * name is unrecognised does the fixed Jira status category decide, which keeps
 * the original behaviour for boards using a stock workflow.
 */
const STATUS_MAP: Record<string, JiraSyncAction> = {
  // Worked and closed out.
  mitigated: { axis: "remediation", status: "mitigated" },
  remediated: { axis: "remediation", status: "mitigated" },
  contained: { axis: "remediation", status: "mitigated" },
  resolved: { axis: "remediation", status: "mitigated" },
  done: { axis: "remediation", status: "mitigated" },
  closed: { axis: "remediation", status: "mitigated" },

  // In flight.
  investigating: { axis: "remediation", status: "investigating" },
  "in progress": { axis: "remediation", status: "investigating" },
  triage: { axis: "remediation", status: "investigating" },
  "in review": { axis: "remediation", status: "investigating" },

  // Untouched.
  new: { axis: "remediation", status: "new" },
  open: { axis: "remediation", status: "new" },
  "to do": { axis: "remediation", status: "new" },
  todo: { axis: "remediation", status: "new" },
  backlog: { axis: "remediation", status: "new" },
  reopened: { axis: "remediation", status: "new" },

  // The analyst's verdict on whether this is the organization's breach.
  "confirmed breach": { axis: "review", decision: "confirmed_breach" },
  confirmed: { axis: "review", decision: "confirmed_breach" },
  "confirmed yours": { axis: "review", decision: "confirmed_breach" },
  dismissed: { axis: "review", decision: "not_a_breach" },
  "not a breach": { axis: "review", decision: "not_a_breach" },
  "false positive": { axis: "review", decision: "not_a_breach" },
  "wont do": { axis: "review", decision: "not_a_breach" },
  rejected: { axis: "review", decision: "not_a_breach" },

  // Back to undecided: withdraw the ruling and let the cascade's verdict stand.
  "needs review": { axis: "review", decision: null },
  "needs confirmation": { axis: "review", decision: null },
  review: { axis: "review", decision: null },
};

function resolveSyncAction(body: JiraWebhookBody): JiraSyncAction {
  const name = body.issue?.fields?.status?.name;
  if (name) {
    const mapped = STATUS_MAP[normalizeStatusName(name)];
    if (mapped !== undefined) return mapped;
  }

  // Unrecognised column. Jira's status *category* is one of three fixed values
  // and survives any renaming, so it is the safe fallback — and it preserves
  // the behaviour boards had before this mapping existed.
  const category = body.issue?.fields?.status?.statusCategory?.key;
  if (category === "done" || body.issue?.fields?.resolution) {
    return { axis: "remediation", status: "mitigated" };
  }
  if (category === "indeterminate") {
    return { axis: "remediation", status: "investigating" };
  }
  return null;
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

  const action = resolveSyncAction(body);
  if (!action) {
    // A column we have no mapping for. 200, not an error: a webhook that
    // returns failures gets disabled by Jira, and this is a legitimate event we
    // simply do not act on.
    return NextResponse.json({ ignored: "unmapped-status" }, { headers: RESPONSE_HEADERS });
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
    const statusName = body.issue?.fields?.status?.name ?? "its new column";

    if (action.axis === "remediation") {
      if (state?.remediationStatus === action.status) {
        // Jira fires several events for one transition; this is what stops the
        // second from rewriting MITIGATED_AT.
        return NextResponse.json(
          { ignored: "already-in-state", state: action.status },
          { headers: RESPONSE_HEADERS },
        );
      }

      await setIncidentRemediation({
        orgId: link.orgId,
        incidentKey: link.incidentKey,
        status: action.status,
        actor: `jira:${issueKey}`,
        note: `Moved to "${statusName}" in Jira.`,
        via: "jira",
      });

      // Only a move into a done column reflects back onto the ticket itself.
      // Anything else was driven *by* the board and needs no echo.
      if (action.status === "mitigated") {
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
          const slack = await resolveSlackConfig(link.orgId);
          if (slack) {
            void postSlackFollowUp(
              slack,
              `:white_check_mark: *Mitigated* — ${state.organizationName}: ${state.title}\nClosed in Jira as ${issueKey}.`,
              state.slackMessageTs,
            ).catch(() => undefined);
          }
        }
      }
    } else {
      if ((state?.reviewDecision ?? null) === action.decision) {
        return NextResponse.json(
          { ignored: "already-in-state", decision: action.decision },
          { headers: RESPONSE_HEADERS },
        );
      }

      if (action.decision === null) {
        await clearReviewDecision(link.orgId, link.incidentKey);
      } else {
        await recordReviewDecision({
          orgId: link.orgId,
          monitorKey: link.incidentKey,
          decision: action.decision,
          note: `Moved to "${statusName}" in Jira.`,
          decidedBy: `jira:${issueKey}`,
        });
      }
    }

    invalidateIncidentViews();

    await recordAction({
      orgId: link.orgId,
      incidentKey: link.incidentKey,
      action: action.axis === "remediation"
        ? (action.status === "mitigated" ? "mark_mitigated" : "unmark_mitigated")
        : "review_decision",
      actor: `jira:${issueKey}`,
      outcome: "success",
      summary: `${issueKey} moved to "${statusName}" in Jira`,
      detail: {
        issueKey,
        status: statusName,
        axis: action.axis,
        applied: action.axis === "remediation" ? action.status : action.decision,
      },
    });

    return NextResponse.json(
      {
        applied: action.axis === "remediation" ? action.status : action.decision,
        axis: action.axis,
        incidentKey: link.incidentKey,
      },
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

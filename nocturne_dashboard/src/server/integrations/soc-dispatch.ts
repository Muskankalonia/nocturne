import { isMailConfigured, queueAlertEmail } from "@/server/alert-mailer";
import { claimAlertDelivery } from "@/server/nocturne-backend";
import {
  closeJiraIssue,
  commentOnJiraIssue,
  createJiraIssue,
  isJiraConfigured,
} from "@/server/integrations/jira";
import {
  isSlackConfigured,
  postSlackAlert,
  postSlackFollowUp,
} from "@/server/integrations/slack";
import {
  getIncidentActionState,
  getIncidentAlertPayloads,
  recordIntegration,
} from "@/server/triage-actions";
import type { PendingAlert } from "@/types/dashboard";
import type {
  IncidentActionState,
  IntegrationDispatchResult,
  SocDispatchResponse,
  TriageOutcome,
} from "@/types/triage";

if (typeof window !== "undefined") {
  throw new Error("Nocturne SOC dispatch may only run on the server.");
}

/**
 * Fans one incident out to every configured channel, and records what each one
 * did.
 *
 * The controlling design decision is that channels are independent. Jira being
 * down must not stop the SOC email, and a Slack workspace nobody has connected
 * must not make the button look broken. Each channel is attempted, each result
 * is written to NOCTURNE.CONFIG.INCIDENT_INTEGRATIONS on its own, and the
 * caller is told exactly which ones landed.
 */

export function consoleIncidentUrl(incidentKey: string): string {
  const base = process.env.NOCTURNE_CONSOLE_URL?.trim().replace(/\/$/, "") ?? "";
  return `${base}/leaks/${encodeURIComponent(incidentKey)}`;
}

function notConfigured(channel: IntegrationDispatchResult["channel"]): IntegrationDispatchResult {
  return {
    channel,
    configured: false,
    delivered: false,
    externalId: null,
    externalUrl: null,
    error: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * Emails every recipient configured for the organization.
 *
 * A delivery claim is taken for each one even though this dispatch is not
 * gated on it. The claim is what stops the scheduled sweep from mailing the
 * same incident again an hour later; skipping it would mean an analyst who
 * pages the team manually causes a second, automatic page.
 */
async function dispatchEmail(
  alerts: PendingAlert[],
): Promise<IntegrationDispatchResult> {
  if (!isMailConfigured()) return notConfigured("email");
  if (!alerts.length) {
    return {
      channel: "email",
      configured: true,
      delivered: false,
      externalId: null,
      externalUrl: null,
      error: "No recipient has an email address on their Nocturne profile.",
    };
  }

  const failures: string[] = [];
  let sent = 0;
  for (const alert of alerts) {
    try {
      await queueAlertEmail(alert);
      sent += 1;
      // Best-effort, and after the send: losing this race only means the sweep
      // may also mail, which is far better than claiming and then failing to
      // send, which would silence the alert entirely.
      void claimAlertDelivery(alert).catch(() => undefined);
    } catch (error) {
      failures.push(`${alert.username}: ${message(error)}`);
    }
  }

  return {
    channel: "email",
    configured: true,
    delivered: sent > 0,
    externalId: null,
    externalUrl: null,
    error: failures.length ? failures.join("; ") : null,
  };
}

async function dispatchJira(
  alert: PendingAlert,
  existing: IncidentActionState | null,
): Promise<IntegrationDispatchResult> {
  if (!isJiraConfigured()) return notConfigured("jira");

  // An incident already has at most one ticket. Re-dispatching adds a comment
  // to it rather than opening a duplicate that a SOC would then have to
  // reconcile by hand.
  if (existing?.jiraIssueKey) {
    await commentOnJiraIssue(
      existing.jiraIssueKey,
      "Nocturne: SOC alert re-dispatched for this incident from the console.",
    );
    return {
      channel: "jira",
      configured: true,
      delivered: true,
      externalId: existing.jiraIssueKey,
      externalUrl: existing.jiraIssueUrl,
      error: null,
    };
  }

  try {
    const issue = await createJiraIssue(alert, consoleIncidentUrl(alert.incidentKey));
    return {
      channel: "jira",
      configured: true,
      delivered: true,
      externalId: issue.key,
      externalUrl: issue.url,
      error: null,
    };
  } catch (error) {
    return {
      channel: "jira",
      configured: true,
      delivered: false,
      externalId: null,
      externalUrl: null,
      error: message(error),
    };
  }
}

async function dispatchSlack(alert: PendingAlert): Promise<IntegrationDispatchResult> {
  if (!isSlackConfigured()) return notConfigured("slack");
  try {
    const posted = await postSlackAlert(alert, consoleIncidentUrl(alert.incidentKey));
    return {
      channel: "slack",
      configured: true,
      delivered: true,
      // The message timestamp is the thread anchor; a mitigation reply needs it.
      externalId: posted.ts,
      externalUrl: posted.url,
      error: null,
    };
  } catch (error) {
    return {
      channel: "slack",
      configured: true,
      delivered: false,
      externalId: null,
      externalUrl: null,
      error: message(error),
    };
  }
}

function summarizeOutcome(results: IntegrationDispatchResult[]): TriageOutcome {
  const attempted = results.filter((result) => result.configured);
  if (!attempted.length) return "failed";
  const delivered = attempted.filter((result) => result.delivered);
  if (delivered.length === attempted.length) return "success";
  return delivered.length ? "partial" : "failed";
}

export class NoRecipientsError extends Error {}

export async function dispatchSocAlert(input: {
  orgId: string;
  incidentKey: string;
  actor: string;
}): Promise<SocDispatchResponse> {
  const alerts = await getIncidentAlertPayloads(input.orgId, input.incidentKey);
  const existing = await getIncidentActionState(input.orgId, input.incidentKey);

  // Every channel but email renders one message about the incident, so any
  // recipient row supplies the incident facts. Email is the one that needs all
  // of them. When there are no profiles at all, fall back to a synthetic
  // payload built from the action state so Jira and Slack still fire — a SOC
  // with no console profiles is a normal state during onboarding.
  const representative: PendingAlert | null =
    alerts[0]
    ?? (existing
      ? {
          incidentKey: existing.incidentKey,
          orgId: existing.orgId,
          organizationName: existing.organizationName,
          title: existing.title,
          sourceUrl: "",
          severityBand: existing.impactSeverityBand ?? "informational",
          severityScore: null,
          firstSeen: null,
          username: input.actor,
          email: "",
          displayName: input.actor,
          leakTypes: [],
          quantityClaimed: null,
          evidenceConfidenceScore: null,
          triagePriorityScore: null,
          actorName: null,
          insightHeadline: null,
          executiveSummary: null,
          recommendedActions: [],
        }
      : null);

  if (!representative) {
    throw new NoRecipientsError("That incident is not available for this organization.");
  }

  const [email, jira, slack] = await Promise.all([
    dispatchEmail(alerts),
    dispatchJira(representative, existing),
    dispatchSlack(representative),
  ]);
  const results = [email, jira, slack];

  await Promise.all(
    results
      .filter((result) => result.configured)
      .map((result) =>
        recordIntegration({
          orgId: input.orgId,
          incidentKey: input.incidentKey,
          channel: result.channel,
          externalId: result.externalId,
          externalUrl: result.externalUrl,
          state: result.delivered
            ? result.channel === "jira"
              ? "open"
              : "sent"
            : "failed",
          error: result.error,
          actor: input.actor,
        }).catch((error) => {
          console.error(
            `[nocturne-soc-dispatch] recording ${result.channel} failed:`,
            message(error),
          );
        }),
      ),
  );

  return {
    incidentKey: input.incidentKey,
    orgId: input.orgId,
    outcome: summarizeOutcome(results),
    results,
    dispatchedAt: new Date().toISOString(),
  };
}

/**
 * Propagates a console-side mitigation outwards: closes the Jira ticket and
 * replies in the Slack thread that raised the alarm.
 *
 * Returns the Jira result so the console can say "marked mitigated, but the
 * ticket did not close" rather than implying both happened. Slack is
 * best-effort and silent — a missing all-clear reply is not worth failing a
 * mitigation over.
 */
export async function propagateMitigation(input: {
  orgId: string;
  incidentKey: string;
  actor: string;
  state: IncidentActionState;
}): Promise<IntegrationDispatchResult | null> {
  const { state } = input;

  if (state.slackState !== null) {
    void postSlackFollowUp(
      `:white_check_mark: *Mitigated* — ${state.organizationName}: ${state.title}\nMarked by ${input.actor} in Nocturne.`,
      state.slackMessageTs,
    ).catch(() => undefined);
  }

  if (!state.jiraIssueKey) return null;
  if (!isJiraConfigured()) {
    return {
      channel: "jira",
      configured: false,
      delivered: false,
      externalId: state.jiraIssueKey,
      externalUrl: state.jiraIssueUrl,
      error: null,
    };
  }

  try {
    await closeJiraIssue(state.jiraIssueKey);
    await recordIntegration({
      orgId: input.orgId,
      incidentKey: input.incidentKey,
      channel: "jira",
      externalId: state.jiraIssueKey,
      externalUrl: state.jiraIssueUrl,
      state: "closed",
      error: null,
      actor: input.actor,
    });
    return {
      channel: "jira",
      configured: true,
      delivered: true,
      externalId: state.jiraIssueKey,
      externalUrl: state.jiraIssueUrl,
      error: null,
    };
  } catch (error) {
    return {
      channel: "jira",
      configured: true,
      delivered: false,
      externalId: state.jiraIssueKey,
      externalUrl: state.jiraIssueUrl,
      error: message(error),
    };
  }
}

/**
 * The inverse: an incident un-marked in the console reopens the conversation.
 * The Jira ticket is not transitioned back — a workflow may have no path from
 * done to in-progress, and guessing one is how automation corrupts a board. A
 * comment is left instead, and the SOC decides.
 */
export async function propagateUnmitigation(input: {
  orgId: string;
  incidentKey: string;
  actor: string;
  state: IncidentActionState;
}): Promise<void> {
  if (input.state.jiraIssueKey && isJiraConfigured()) {
    await commentOnJiraIssue(
      input.state.jiraIssueKey,
      `Nocturne: ${input.actor} reopened this incident in the console. It is no longer marked mitigated.`,
    );
    await recordIntegration({
      orgId: input.orgId,
      incidentKey: input.incidentKey,
      channel: "jira",
      externalId: input.state.jiraIssueKey,
      externalUrl: input.state.jiraIssueUrl,
      state: "open",
      error: null,
      actor: input.actor,
    }).catch(() => undefined);
  }

  if (input.state.slackState !== null) {
    void postSlackFollowUp(
      `:warning: *Reopened* — ${input.state.organizationName}: ${input.state.title}\nUnmarked by ${input.actor} in Nocturne.`,
      input.state.slackMessageTs,
    ).catch(() => undefined);
  }
}

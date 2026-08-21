import { isMailConfigured, queueAlertEmail } from "@/server/alert-mailer";
import { claimAlertDelivery } from "@/server/nocturne-backend";
import {
  closeJiraIssue,
  commentOnJiraIssue,
  createJiraIssue,
} from "@/server/integrations/jira";
import { postSlackAlert, postSlackFollowUp } from "@/server/integrations/slack";
import {
  resolveJiraConfig,
  resolveSlackConfig,
} from "@/server/integration-settings";
import {
  getIncidentActionState,
  getIncidentAlertFacts,
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

export function consoleIncidentUrl(baseUrl: string, incidentKey: string): string {
  return `${baseUrl.replace(/\/$/, "")}/leaks/${encodeURIComponent(incidentKey)}`;
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
  orgId: string,
  baseUrl: string,
  alert: PendingAlert,
  existing: IncidentActionState | null,
): Promise<IntegrationDispatchResult> {
  const config = await resolveJiraConfig(orgId);
  if (!config) return notConfigured("jira");

  // An incident already has at most one ticket. Re-dispatching adds a comment
  // to it rather than opening a duplicate that a SOC would then have to
  // reconcile by hand.
  if (existing?.jiraIssueKey) {
    await commentOnJiraIssue(
      config,
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
    const issue = await createJiraIssue(
      config,
      alert,
      consoleIncidentUrl(baseUrl, alert.incidentKey),
    );
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

async function dispatchSlack(
  orgId: string,
  baseUrl: string,
  alert: PendingAlert,
): Promise<IntegrationDispatchResult> {
  const config = await resolveSlackConfig(orgId);
  if (!config) return notConfigured("slack");
  try {
    const posted = await postSlackAlert(
      config,
      alert,
      consoleIncidentUrl(baseUrl, alert.incidentKey),
    );
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
  /** Absolute origin for links that leave the console. */
  consoleBaseUrl: string;
}): Promise<SocDispatchResponse> {
  const alerts = await getIncidentAlertPayloads(input.orgId, input.incidentKey);
  const existing = await getIncidentActionState(input.orgId, input.incidentKey);

  // Every channel but email renders one message about the incident, so any
  // recipient row supplies the incident facts. Email is the one that needs all
  // of them.
  //
  // When no profile carries an email there are no recipient rows, but the
  // incident is still fully described in the warehouse — so the facts are
  // fetched on their own rather than synthesised. Building a placeholder here
  // is what produced Jira tickets and Slack posts with a severity band and
  // nothing else: no score, no confidence, no exposed-data types, no actor, no
  // summary. A SOC with no console profiles is a normal state during
  // onboarding, and it is exactly when a complete alert matters most.
  const representative: PendingAlert | null =
    alerts[0]
    ?? (await getIncidentAlertFacts(input.orgId, input.incidentKey).then((facts) =>
      facts
        ? {
            ...facts,
            // No addressee: the actor stands in so the payload type is honest
            // about who triggered this, and the email channel has already been
            // told there is nobody to write to.
            username: input.actor,
            email: "",
            displayName: input.actor,
          }
        : null,
    ));

  if (!representative) {
    throw new NoRecipientsError("That incident is not available for this organization.");
  }

  const [email, jira, slack] = await Promise.all([
    dispatchEmail(alerts),
    dispatchJira(input.orgId, input.consoleBaseUrl, representative, existing),
    dispatchSlack(input.orgId, input.consoleBaseUrl, representative),
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
    void resolveSlackConfig(input.orgId)
      .then((config) =>
        config
          ? postSlackFollowUp(
              config,
              `:white_check_mark: *Mitigated* — ${state.organizationName}: ${state.title}\nMarked by ${input.actor} in Nocturne.`,
              state.slackMessageTs,
            )
          : undefined,
      )
      .catch(() => undefined);
  }

  if (!state.jiraIssueKey) return null;
  const config = await resolveJiraConfig(input.orgId);
  if (!config) {
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
    await closeJiraIssue(config, state.jiraIssueKey);
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
  const jira = input.state.jiraIssueKey
    ? await resolveJiraConfig(input.orgId)
    : null;
  if (input.state.jiraIssueKey && jira) {
    await commentOnJiraIssue(
      jira,
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
    void resolveSlackConfig(input.orgId)
      .then((config) =>
        config
          ? postSlackFollowUp(
              config,
              `:warning: *Reopened* — ${input.state.organizationName}: ${input.state.title}\nUnmarked by ${input.actor} in Nocturne.`,
              input.state.slackMessageTs,
            )
          : undefined,
      )
      .catch(() => undefined);
  }
}

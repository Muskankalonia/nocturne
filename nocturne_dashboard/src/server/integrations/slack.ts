import { severityColor } from "@/theme/tokens";
import type { ResolvedSlackConfig } from "@/server/integration-settings";
import type { PendingAlert } from "@/types/dashboard";

if (typeof window !== "undefined") {
  throw new Error("Nocturne Slack integration may only run on the server.");
}

/**
 * Slack notification for a confirmed breach.
 *
 * Two transports, in preference order:
 *
 *   bot token + channel — chat.postMessage. Returns a message timestamp, which
 *     is what lets a later mitigation reply in-thread rather than posting a
 *     second unconnected message into the channel.
 *   incoming webhook — simpler to set up, but Slack returns no message
 *     reference, so follow-ups post standalone.
 *
 * Configuration is per-organization and resolved by the caller; see
 * `resolveSlackConfig` in server/integration-settings.ts.
 */

export type SlackConfig = ResolvedSlackConfig;

export interface SlackMessageRef {
  /** Message timestamp for threading. Null on the webhook transport. */
  ts: string | null;
  /** Permalink when one can be derived; null otherwise. */
  url: string | null;
}

const REQUEST_TIMEOUT_MS = 10_000;


/**
 * Turns Slack's error codes into something an analyst can act on.
 *
 * Slack's vocabulary describes its own internals, not the user's mistake:
 * `channel_not_found` is what a *private* channel returns when the app is not a
 * member, because Slack will not confirm such a channel exists. Reported
 * verbatim it reads as "you typed the wrong ID", and sends people to re-check a
 * setting that was correct all along.
 */
function describeSlackError(code: string, channelId?: string): string {
  const channel = channelId ? ` (${channelId})` : "";
  switch (code) {
    case "channel_not_found":
      return (
        `Slack could not find that channel${channel}. If it is private, the app `
        + `must be invited before it can post: run /invite @your-app-name in the `
        + `channel. If it is public, check the ID belongs to this workspace.`
      );
    case "not_in_channel":
      return (
        `The app is not a member of that channel${channel}. Run /invite `
        + `@your-app-name in the channel, or add it under Channel settings → `
        + `Integrations.`
      );
    case "is_archived":
      return `That channel${channel} is archived, so nothing can be posted to it.`;
    case "invalid_auth":
    case "token_revoked":
      return "Slack rejected the bot token. It may have been revoked — generate a new one and save it again.";
    case "account_inactive":
      return "The Slack app has been disabled in this workspace.";
    case "missing_scope":
      return "The bot token is missing the chat:write scope. Add it in the Slack app's OAuth settings and reinstall.";
    case "rate_limited":
      return "Slack is rate limiting this app; the alert was not posted.";
    default:
      return `Slack rejected the message: ${code}`;
  }
}

async function post(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** "82 · critical", or "— · critical" when the cascade scored no number. */
function scoreWithBand(score: number | null, band: string): string {
  return `${score ?? "—"} · ${band}`;
}

/** Grouped thousands, because "21000000" is not a number anyone reads. */
function records(quantity: number | null): string {
  return quantity === null ? "not stated" : quantity.toLocaleString("en-US");
}

/** Date only. The hour a listing was first seen is noise in a channel. */
function firstSeen(value: string | null): string {
  if (!value) return "unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

/** Slack rejects a text object over 3000 characters outright. */
function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/**
 * Block Kit payload. Like the email and the Jira ticket, this carries the
 * classification and the model's summary and never a verbatim excerpt — a
 * channel is the widest audience of the three.
 *
 * The scored fields are the point of the message. An analyst reading this in a
 * channel is deciding whether to stop what they are doing, and "critical" alone
 * does not support that decision: the severity score, the evidence confidence,
 * how much data is claimed, and whether the actor is a known name are what
 * separate a credible 21M-record breach from an unattributed repost. Anything
 * the cascade did not conclude says so in words rather than rendering an empty
 * dash, so a missing value is distinguishable from a value of nothing.
 */
function blocksFor(alert: PendingAlert, consoleUrl: string) {
  const band = alert.severityBand.toUpperCase();
  const headline = alert.insightHeadline?.trim() || alert.title;
  const fields = [
    `*Organization*\n${alert.organizationName}`,
    `*Actor*\n${alert.actorName ?? "unattributed"}`,
    `*Impact severity*\n${scoreWithBand(alert.severityScore, alert.severityBand)}`,
    `*Evidence confidence*\n${alert.evidenceConfidenceScore ?? "—"}`,
    `*Triage priority*\n${alert.triagePriorityScore ?? "—"}`,
    `*Records claimed*\n${records(alert.quantityClaimed)}`,
    `*Exposed data*\n${
      alert.leakTypes.length ? alert.leakTypes.join(", ") : "not yet classified"
    }`,
    `*First seen*\n${firstSeen(alert.firstSeen)}`,
  ];

  // Up to three. A channel post is a summons to the console, not the runbook.
  const actions = alert.recommendedActions
    .map((action) => action.trim())
    .filter(Boolean)
    .slice(0, 3);

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${band} · Confirmed breach`, emoji: false },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${clamp(headline, 2900)}*` },
    },
    // The listing's own title, when the model wrote its own headline above.
    // Analysts search channels for the string they saw on the source.
    ...(headline !== alert.title && alert.title.trim()
      ? [
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `Listing: ${clamp(alert.title.trim(), 300)}` },
            ],
          },
        ]
      : []),
    ...(alert.executiveSummary?.trim()
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: clamp(alert.executiveSummary.trim(), 2900) },
          },
        ]
      : []),
    { type: "section", fields: fields.map((text) => ({ type: "mrkdwn", text })) },
    ...(actions.length
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: clamp(
                `*Recommended actions*\n${actions.map((action) => `• ${action}`).join("\n")}`,
                2900,
              ),
            },
          },
        ]
      : []),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Open in Nocturne" },
          url: consoleUrl,
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Evidence stays in the console — this message contains no leaked material.",
        },
      ],
    },
  ];
}

export async function postSlackAlert(
  config: SlackConfig,
  alert: PendingAlert,
  consoleUrl: string,
): Promise<SlackMessageRef> {

  const band = alert.severityBand.toUpperCase();
  const fallback = `[${band}] ${alert.organizationName}: ${
    alert.insightHeadline?.trim() || alert.title
  }`;
  const blocks = blocksFor(alert, consoleUrl);

  if (config.transport === "webhook") {
    const response = await post(config.webhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: fallback,
        blocks,
        // The colour bar is the fastest severity signal in a busy channel.
        attachments: [{ color: severityColor[alert.severityBand], blocks: [] }],
      }),
    });
    if (!response.ok) {
      throw new Error(`Slack webhook responded ${response.status}.`);
    }
    return { ts: null, url: null };
  }

  const response = await post("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: config.channelId, text: fallback, blocks }),
  });

  // chat.postMessage answers 200 with ok:false on a real failure, so the HTTP
  // status alone is not the result.
  const body = (await response.json()) as {
    ok?: boolean;
    ts?: string;
    error?: string;
  };
  if (!response.ok || !body.ok) {
    throw new Error(
      describeSlackError(body.error ?? String(response.status), config.channelId),
    );
  }

  const permalink =
    config.workspaceUrl && body.ts
      ? `${config.workspaceUrl}/archives/${config.channelId}/p${body.ts.replace(".", "")}`
      : null;
  return { ts: body.ts ?? null, url: permalink };
}

/**
 * Follow-up note, threaded under the original alert when a timestamp is known.
 * Used when an incident is mitigated so the channel that got the alarm also
 * gets the all-clear.
 */
export async function postSlackFollowUp(
  config: SlackConfig,
  message: string,
  threadTs: string | null,
): Promise<void> {

  if (config.transport === "webhook") {
    await post(config.webhookUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    return;
  }

  await post("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: config.channelId,
      text: message,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });
}

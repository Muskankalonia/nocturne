import { severityColor } from "@/theme/tokens";
import type { PendingAlert } from "@/types/dashboard";

if (typeof window !== "undefined") {
  throw new Error("Nocturne Slack integration may only run on the server.");
}

/**
 * Slack notification for a confirmed breach.
 *
 * Two transports, in preference order:
 *
 *   SLACK_BOT_TOKEN + SLACK_CHANNEL_ID — chat.postMessage. Returns a message
 *     timestamp, which is what lets a later mitigation reply in-thread rather
 *     than posting a second unconnected message into the channel.
 *   SLACK_WEBHOOK_URL — an incoming webhook. Simpler to set up, but Slack
 *     returns no message reference, so follow-ups post standalone.
 *
 * Neither set means Slack is not configured, which is not an error.
 */

const REQUEST_TIMEOUT_MS = 10_000;

export type SlackTransport = "bot" | "webhook";

export interface SlackConfig {
  transport: SlackTransport;
  botToken?: string;
  channelId?: string;
  webhookUrl?: string;
  workspaceUrl?: string;
}

export interface SlackMessageRef {
  /** Message timestamp for threading. Null on the webhook transport. */
  ts: string | null;
  /** Permalink when one can be derived; null otherwise. */
  url: string | null;
}

export function slackConfig(): SlackConfig | null {
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const channelId = process.env.SLACK_CHANNEL_ID?.trim();
  const workspaceUrl = process.env.SLACK_WORKSPACE_URL?.trim().replace(/\/$/, "");
  if (botToken && channelId) {
    return { transport: "bot", botToken, channelId, workspaceUrl };
  }

  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
      console.error("[nocturne-slack] SLACK_WEBHOOK_URL is not a Slack host; disabling.");
      return null;
    }
    return { transport: "webhook", webhookUrl, workspaceUrl };
  }
  return null;
}

export function isSlackConfigured(): boolean {
  return slackConfig() !== null;
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

/**
 * Block Kit payload. Like the email and the Jira ticket, this carries the
 * classification and the model's summary and never a verbatim excerpt — a
 * channel is the widest audience of the three.
 */
function blocksFor(alert: PendingAlert, consoleUrl: string) {
  const band = alert.severityBand.toUpperCase();
  const headline = alert.insightHeadline?.trim() || alert.title;
  const fields = [
    `*Organization*\n${alert.organizationName}`,
    `*Impact severity*\n${alert.severityScore ?? "—"} · ${alert.severityBand}`,
    `*Evidence confidence*\n${alert.evidenceConfidenceScore ?? "—"}`,
    `*Triage priority*\n${alert.triagePriorityScore ?? "—"}`,
    `*Exposed data*\n${alert.leakTypes.length ? alert.leakTypes.join(", ") : "not yet classified"}`,
    `*Actor*\n${alert.actorName ?? "unattributed"}`,
  ];

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${band} · Confirmed breach`, emoji: false },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${headline}*` },
    },
    ...(alert.executiveSummary?.trim()
      ? [
          {
            type: "section",
            text: { type: "mrkdwn", text: alert.executiveSummary.trim().slice(0, 2900) },
          },
        ]
      : []),
    { type: "section", fields: fields.map((text) => ({ type: "mrkdwn", text })) },
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
  alert: PendingAlert,
  consoleUrl: string,
): Promise<SlackMessageRef> {
  const config = slackConfig();
  if (!config) throw new Error("Slack is not configured.");

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
    throw new Error(`Slack rejected the message: ${body.error ?? response.status}`);
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
  message: string,
  threadTs: string | null,
): Promise<void> {
  const config = slackConfig();
  if (!config) return;

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

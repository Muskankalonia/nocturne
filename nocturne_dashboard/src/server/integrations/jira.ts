import type { ResolvedJiraConfig } from "@/server/integration-settings";
import type { PendingAlert } from "@/types/dashboard";

if (typeof window !== "undefined") {
  throw new Error("Nocturne Jira integration may only run on the server.");
}

/**
 * Jira Cloud REST v3, for opening and closing an incident's ticket.
 *
 * This module no longer resolves its own configuration. Credentials are
 * per-organization and live in NOCTURNE.CONFIG.INTEGRATION_SETTINGS, so the
 * caller resolves them for the tenant it is acting on and passes them in. That
 * keeps a single global `process.env` read from quietly deciding which Jira
 * project a given tenant's incidents land in.
 *
 * See `resolveJiraConfig` in server/integration-settings.ts, which falls back
 * to the JIRA_* environment variables when a tenant has saved nothing.
 */

export type JiraConfig = ResolvedJiraConfig;

export interface JiraIssueRef {
  key: string;
  url: string;
}

const REQUEST_TIMEOUT_MS = 12_000;

function authHeader(config: JiraConfig): string {
  const encoded = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  return `Basic ${encoded}`;
}

async function jiraFetch(
  config: JiraConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${config.baseUrl}/rest/api/3${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: authHeader(config),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

/** Jira's error bodies are verbose and can echo credentials context; trim them. */
async function describeFailure(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    detail =
      body.errorMessages?.join("; ")
      || Object.values(body.errors ?? {}).join("; ")
      || "";
  } catch {
    detail = "";
  }
  return `Jira responded ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`;
}

/** Atlassian Document Format — Jira v3 rejects plain strings for descriptions. */
function adf(paragraphs: Array<string | { bullets: string[] }>) {
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((entry) =>
      typeof entry === "string"
        ? { type: "paragraph", content: [{ type: "text", text: entry }] }
        : {
            type: "bulletList",
            content: entry.bullets.map((bullet) => ({
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: bullet }] },
              ],
            })),
          },
    ),
  };
}

/**
 * The ticket body carries the classification, the scores, and the model's own
 * summary — never a verbatim excerpt from the source page. Same rule as the
 * alert email, and for the same reason: a Jira project has a much wider
 * audience than the console, and leaked material should not be what widens it.
 */
function describeIncident(alert: PendingAlert, consoleUrl: string) {
  const facts = [
    `Organization: ${alert.organizationName}`,
    `Impact severity: ${alert.severityScore ?? "—"} (${alert.severityBand})`,
    `Evidence confidence: ${alert.evidenceConfidenceScore ?? "—"}`,
    `Triage priority: ${alert.triagePriorityScore ?? "—"}`,
    `Exposed data: ${alert.leakTypes.length ? alert.leakTypes.join(", ") : "not yet classified"}`,
    `Records claimed: ${alert.quantityClaimed?.toLocaleString() ?? "not stated"} (seller's claim)`,
    `Attributed actor: ${alert.actorName ?? "unattributed"}`,
    `First seen: ${alert.firstSeen?.slice(0, 10) ?? "unknown"}`,
  ];

  const paragraphs: Array<string | { bullets: string[] }> = [
    alert.executiveSummary?.trim() || alert.title,
    { bullets: facts },
  ];
  if (alert.recommendedActions.length) {
    paragraphs.push("Recommended actions");
    paragraphs.push({ bullets: alert.recommendedActions.slice(0, 6) });
  }
  paragraphs.push(`Evidence and the source page: ${consoleUrl}`);
  paragraphs.push(
    "Raised by Nocturne. This ticket intentionally contains no verbatim leaked material.",
  );
  return adf(paragraphs);
}

export async function createJiraIssue(
  config: JiraConfig,
  alert: PendingAlert,
  consoleUrl: string,
): Promise<JiraIssueRef> {

  const headline = alert.insightHeadline?.trim() || alert.title;
  const response = await jiraFetch(config, "/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: config.projectKey },
        issuetype: { name: config.issueType },
        summary: `[Nocturne · ${alert.severityBand.toUpperCase()}] ${
          alert.organizationName
        }: ${headline.slice(0, 200)}`,
        description: describeIncident(alert, consoleUrl),
        labels: [
          "nocturne",
          `nocturne-org-${alert.orgId}`,
          `nocturne-severity-${alert.severityBand}`,
        ],
      },
    }),
  });

  if (!response.ok) throw new Error(await describeFailure(response));
  const created = (await response.json()) as { key?: string };
  if (!created.key) throw new Error("Jira accepted the issue but returned no key.");
  return { key: created.key, url: `${config.baseUrl}/browse/${created.key}` };
}

/**
 * Moves an issue to its done state.
 *
 * Jira transitions are per-workflow and named by the project, not global, so
 * the target is resolved by name from the issue's own available transitions
 * rather than by a hardcoded id. An issue already in a done state has no such
 * transition available, which is reported as success — the caller asked for it
 * to be closed, and it is.
 */
export async function closeJiraIssue(
  config: JiraConfig,
  issueKey: string,
): Promise<void> {

  const listed = await jiraFetch(config, `/issue/${encodeURIComponent(issueKey)}/transitions`);
  if (!listed.ok) throw new Error(await describeFailure(listed));

  const body = (await listed.json()) as {
    transitions?: Array<{
      id: string;
      name: string;
      to?: { name?: string; statusCategory?: { key?: string } };
    }>;
  };
  const transitions = body.transitions ?? [];

  const wanted = config.doneTransition.toLowerCase();
  const target =
    transitions.find((t) => t.name.toLowerCase() === wanted)
    // Fall back to any transition landing in Jira's "done" status category,
    // which survives a project that renamed its column to "Resolved".
    || transitions.find((t) => t.to?.statusCategory?.key === "done");

  if (!target) {
    const current = await jiraFetch(config, `/issue/${encodeURIComponent(issueKey)}?fields=status`);
    if (current.ok) {
      const issue = (await current.json()) as {
        fields?: { status?: { statusCategory?: { key?: string } } };
      };
      if (issue.fields?.status?.statusCategory?.key === "done") return;
    }
    throw new Error(
      `No transition to "${config.doneTransition}" is available on ${issueKey}.`,
    );
  }

  const moved = await jiraFetch(config, `/issue/${encodeURIComponent(issueKey)}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: target.id } }),
  });
  if (!moved.ok) throw new Error(await describeFailure(moved));
}

/** Best-effort note on the ticket. Never fails the action that triggered it. */
export async function commentOnJiraIssue(
  config: JiraConfig,
  issueKey: string,
  comment: string,
): Promise<void> {
  try {
    await jiraFetch(config, `/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: adf([comment]) }),
    });
  } catch (error) {
    console.warn(
      "[nocturne-jira] comment failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

export function jiraIssueUrl(config: JiraConfig, issueKey: string): string {
  return `${config.baseUrl}/browse/${issueKey}`;
}

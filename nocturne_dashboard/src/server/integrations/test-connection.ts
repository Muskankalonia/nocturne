import type { JiraConfig } from "@/server/integrations/jira";
import type { SlackConfig } from "@/server/integrations/slack";

if (typeof window !== "undefined") {
  throw new Error("Nocturne connection tests may only run on the server.");
}

/**
 * Read-only checks against Jira and Slack, so a misconfiguration surfaces on
 * the settings screen rather than on the first real incident.
 *
 * Everything here is a GET. A test that posted a message would prove more, but
 * it would also put a fake breach alert in a SOC channel every time somebody
 * pressed a button, and an alert channel that cries wolf is worse than an
 * unverified one.
 *
 * The checks are deliberately granular. "Connection failed" sends someone back
 * to re-paste a token that was never wrong; "authenticated as X, but the app is
 * not a member of that channel" tells them the one thing to go and do.
 */

const TIMEOUT_MS = 12_000;

export type CheckStatus = "pass" | "warn" | "fail";

export interface ConnectionCheck {
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ConnectionTestResult {
  provider: "jira" | "slack";
  ok: boolean;
  summary: string;
  checks: ConnectionCheck[];
}

async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function fail(label: string, detail: string): ConnectionCheck {
  return { label, status: "fail", detail };
}

function reason(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") {
    return "The request timed out.";
  }
  return error instanceof Error ? error.message : "Unknown error.";
}

/* ── Jira ──────────────────────────────────────────────────────────────────── */

export async function testJiraConnection(
  config: JiraConfig,
): Promise<ConnectionTestResult> {
  const checks: ConnectionCheck[] = [];
  const auth = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`;
  const headers = { Authorization: auth, Accept: "application/json" };

  // 1. Does the credential work at all?
  let authenticated = false;
  try {
    const response = await timedFetch(`${config.baseUrl}/rest/api/3/myself`, { headers });
    if (response.ok) {
      const me = (await response.json()) as { displayName?: string; emailAddress?: string };
      authenticated = true;
      checks.push({
        label: "Authentication",
        status: "pass",
        detail: `Signed in as ${me.displayName ?? config.email}.`,
      });
    } else if (response.status === 401) {
      checks.push(fail(
        "Authentication",
        "Jira rejected the email and API token. Check the token has not been revoked, and that it belongs to this email address.",
      ));
    } else if (response.status === 403) {
      checks.push(fail(
        "Authentication",
        "The credential is valid but this account is not permitted to use the API.",
      ));
    } else {
      checks.push(fail("Authentication", `Jira responded ${response.status}.`));
    }
  } catch (error) {
    checks.push(fail(
      "Authentication",
      `Could not reach ${config.baseUrl}. ${reason(error)}`,
    ));
  }

  if (!authenticated) {
    return {
      provider: "jira",
      ok: false,
      summary: "Jira could not be reached with these credentials.",
      checks,
    };
  }

  // 2. Is the project visible to this account?
  let issueTypes: string[] = [];
  try {
    const response = await timedFetch(
      `${config.baseUrl}/rest/api/3/project/${encodeURIComponent(config.projectKey)}`,
      { headers },
    );
    if (response.ok) {
      const project = (await response.json()) as {
        name?: string;
        issueTypes?: Array<{ name?: string }>;
      };
      issueTypes = (project.issueTypes ?? [])
        .map((type) => type.name ?? "")
        .filter(Boolean);
      checks.push({
        label: "Project",
        status: "pass",
        detail: `${config.projectKey} — ${project.name ?? "found"}.`,
      });
    } else if (response.status === 404) {
      checks.push(fail(
        "Project",
        `No project "${config.projectKey}" is visible to this account. Check the key, and that the account has access to it.`,
      ));
    } else {
      checks.push(fail("Project", `Jira responded ${response.status}.`));
    }
  } catch (error) {
    checks.push(fail("Project", reason(error)));
  }

  // 3. Will the issue type it opens tickets as actually exist?
  if (issueTypes.length) {
    const matches = issueTypes.some(
      (type) => type.toLowerCase() === config.issueType.toLowerCase(),
    );
    checks.push({
      label: "Issue type",
      status: matches ? "pass" : "fail",
      detail: matches
        ? `"${config.issueType}" is available in this project.`
        : `"${config.issueType}" is not one of this project's issue types (${issueTypes.join(", ")}).`,
    });
  }

  // 4. Is there a column to close a ticket into? This is the check worth having:
  //    a wrong transition name only shows up when someone marks an incident
  //    mitigated and the ticket silently stays open.
  try {
    const response = await timedFetch(
      `${config.baseUrl}/rest/api/3/project/${encodeURIComponent(config.projectKey)}/statuses`,
      { headers },
    );
    if (response.ok) {
      const body = (await response.json()) as Array<{
        name?: string;
        statuses?: Array<{ name?: string; statusCategory?: { key?: string } }>;
      }>;
      const statuses = body.flatMap((type) => type.statuses ?? []);
      const named = statuses.some(
        (status) => status.name?.toLowerCase() === config.doneTransition.toLowerCase(),
      );
      const anyDone = statuses.some(
        (status) => status.statusCategory?.key === "done",
      );
      checks.push({
        label: "Done transition",
        status: named ? "pass" : anyDone ? "warn" : "fail",
        detail: named
          ? `"${config.doneTransition}" exists in this project's workflow.`
          : anyDone
            ? `No status named "${config.doneTransition}", but the project has a done column, which will be used as a fallback when closing a ticket.`
            : "This project has no done status, so marking an incident mitigated will not be able to close its ticket.",
      });
    }
  } catch {
    // Non-fatal: some Jira configurations restrict this endpoint, and the
    // fallback in closeJiraIssue handles a missing name anyway.
  }

  const failed = checks.filter((check) => check.status === "fail");
  return {
    provider: "jira",
    ok: failed.length === 0,
    summary: failed.length
      ? failed[0]!.detail
      : `Connected to ${config.projectKey}. Tickets will open here.`,
    checks,
  };
}

/* ── Slack ─────────────────────────────────────────────────────────────────── */

export async function testSlackConnection(
  config: SlackConfig,
): Promise<ConnectionTestResult> {
  const checks: ConnectionCheck[] = [];

  if (config.transport === "webhook") {
    // An incoming webhook exposes no read API at all: the only way to know it
    // works is to post through it, which would put a message in the channel.
    checks.push({
      label: "Webhook",
      status: "warn",
      detail:
        "An incoming webhook cannot be verified without posting to the channel, so this is not tested. A bot token can be checked properly, and can also thread mitigation replies under the original alert.",
    });
    return {
      provider: "slack",
      ok: true,
      summary: "A webhook is configured. It cannot be verified without posting.",
      checks,
    };
  }

  const headers = { Authorization: `Bearer ${config.botToken}` };

  // 1. Is the token live, and which workspace does it belong to?
  let authenticated = false;
  let botName = "the app";
  try {
    const response = await timedFetch("https://slack.com/api/auth.test", { headers });
    const body = (await response.json()) as {
      ok?: boolean;
      team?: string;
      user?: string;
      error?: string;
    };
    if (body.ok) {
      authenticated = true;
      botName = body.user ?? botName;
      checks.push({
        label: "Bot token",
        status: "pass",
        detail: `Authenticated as ${body.user} in the ${body.team} workspace.`,
      });
    } else {
      checks.push(fail(
        "Bot token",
        body.error === "invalid_auth" || body.error === "token_revoked"
          ? "Slack rejected the bot token. Generate a new one and save it again."
          : `Slack rejected the token: ${body.error}`,
      ));
    }
  } catch (error) {
    checks.push(fail("Bot token", reason(error)));
  }

  if (!authenticated) {
    return {
      provider: "slack",
      ok: false,
      summary: "Slack rejected the bot token.",
      checks,
    };
  }

  // 2. Can the app see the channel, and is it a member? This is the check that
  //    would have caught the channel_not_found case: a valid token, the right
  //    workspace, and an app that has simply never been invited.
  try {
    const response = await timedFetch(
      `https://slack.com/api/conversations.info?channel=${encodeURIComponent(config.channelId ?? "")}`,
      { headers },
    );
    const body = (await response.json()) as {
      ok?: boolean;
      error?: string;
      channel?: {
        name?: string;
        is_member?: boolean;
        is_private?: boolean;
        is_archived?: boolean;
      };
    };

    if (body.ok && body.channel) {
      const channel = body.channel;
      if (channel.is_archived) {
        checks.push(fail("Channel", `#${channel.name} is archived.`));
      } else if (channel.is_member === false) {
        checks.push(fail(
          "Channel",
          `The app is not a member of #${channel.name}. Run /invite @${botName} in that channel.`,
        ));
      } else {
        checks.push({
          label: "Channel",
          status: "pass",
          detail: `#${channel.name}${channel.is_private ? " (private)" : ""} — the app is a member.`,
        });
      }
    } else if (body.error === "missing_scope") {
      // Posting does not need this scope, so a failure to read is a warning
      // rather than an error — but say plainly what it costs.
      checks.push({
        label: "Channel",
        status: "warn",
        detail:
          "The token cannot read channel details, so membership could not be verified. Add the channels:read and groups:read scopes to check this before an incident depends on it.",
      });
    } else if (body.error === "channel_not_found") {
      checks.push(fail(
        "Channel",
        `Slack cannot see channel ${config.channelId}. If it is private, run /invite @${botName} in it — Slack hides private channels from apps that are not members. If it is public, check the ID belongs to this workspace.`,
      ));
    } else {
      checks.push(fail("Channel", `Slack responded: ${body.error}`));
    }
  } catch (error) {
    checks.push(fail("Channel", reason(error)));
  }

  const failed = checks.filter((check) => check.status === "fail");
  return {
    provider: "slack",
    ok: failed.length === 0,
    summary: failed.length ? failed[0]!.detail : "Slack is ready to receive alerts.",
    checks,
  };
}

import { executeQuery } from "@/server/nocturne-backend";
import {
  decryptSecret,
  encryptSecret,
  isSecretStorageConfigured,
  maskSecret,
} from "@/server/secrets";

if (typeof window !== "undefined") {
  throw new Error("Nocturne integration settings may only run on the server.");
}

/**
 * Per-organization Jira and Slack configuration, stored in Snowflake.
 *
 * These used to come from the environment, which made them a deployment concern
 * and identical for every tenant. They are neither: each organization has its
 * own Jira project and Slack channel, and the person who knows those values is
 * an analyst rather than whoever last edited the service definition.
 *
 * Environment variables are kept as a fallback rather than removed. A
 * deployment that already configures Jira through the environment keeps working
 * untouched, and a tenant that saves its own settings simply overrides it. The
 * precedence is always: this organization's saved row, then the environment,
 * then "not configured".
 */

export type IntegrationProvider = "jira" | "slack";

/** Non-secret fields, safe to return to a browser. */
export interface JiraSettings {
  baseUrl: string;
  email: string;
  projectKey: string;
  issueType: string;
  doneTransition: string;
}

export interface SlackSettings {
  channelId: string;
  workspaceUrl: string;
  /** Present only when the webhook transport is in use. */
  webhookConfigured: boolean;
}

/** One provider as the settings screen sees it. Secrets are masked. */
export interface IntegrationSettingsView {
  provider: IntegrationProvider;
  enabled: boolean;
  /** True when the effective config can actually reach the provider. */
  configured: boolean;
  /** 'saved' when this organization stored it, 'environment' when inherited. */
  source: "saved" | "environment" | "none";
  settings: Record<string, string>;
  /** Masked hints, keyed by secret field: { apiToken: "••••4f2a" }. */
  secretHints: Record<string, string>;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Fully resolved config with plaintext secrets. Never leaves the server. */
export interface ResolvedJiraConfig extends JiraSettings {
  apiToken: string;
}

export interface ResolvedSlackConfig {
  transport: "bot" | "webhook";
  botToken?: string;
  channelId?: string;
  webhookUrl?: string;
  workspaceUrl?: string;
}

interface StoredRow {
  enabled: boolean;
  settings: Record<string, unknown>;
  secrets: Record<string, string>;
  updatedBy: string | null;
  updatedAt: string | null;
}

function parseJson(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function str(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  const text = String(value);
  return text.trim().toUpperCase() === "NULL" ? fallback : text;
}

async function readRow(
  orgId: string,
  provider: IntegrationProvider,
): Promise<StoredRow | null> {
  const rows = await executeQuery(
    `SELECT
       ENABLED,
       SETTINGS,
       SECRETS,
       UPDATED_BY,
       TO_VARCHAR(UPDATED_AT, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS UPDATED_AT
     FROM NOCTURNE.CONFIG.INTEGRATION_SETTINGS
     WHERE ORG_ID = ? AND PROVIDER = ?`,
    [orgId, provider],
  );
  if (!rows.length) return null;
  const row = rows[0]!;
  return {
    enabled: String(row.ENABLED).toLowerCase() === "true",
    settings: parseJson(row.SETTINGS),
    secrets: parseJson(row.SECRETS) as Record<string, string>,
    updatedBy: str(row.UPDATED_BY) || null,
    updatedAt: str(row.UPDATED_AT) || null,
  };
}

/**
 * Decrypts one stored secret, or returns null.
 *
 * A credential that fails to decrypt — because the key was rotated, or the row
 * was written by a different deployment — is treated as absent rather than
 * thrown. The integration then reports "not configured", which is recoverable
 * by re-entering it, instead of turning every dispatch into a 500.
 */
function secret(row: StoredRow | null, field: string): string | null {
  const stored = row?.secrets?.[field];
  if (!stored) return null;
  try {
    return decryptSecret(String(stored));
  } catch (error) {
    console.error(
      `[nocturne-integrations] could not decrypt ${field}:`,
      error instanceof Error ? error.message : "unknown error",
    );
    return null;
  }
}

/* ── resolution: saved row first, environment second ───────────────────────── */

export async function resolveJiraConfig(
  orgId: string,
): Promise<ResolvedJiraConfig | null> {
  let row: StoredRow | null = null;
  try {
    row = await readRow(orgId, "jira");
  } catch (error) {
    // A warehouse blip must not silently disable a working environment config.
    console.error(
      "[nocturne-integrations] reading Jira settings failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }

  if (row && row.enabled) {
    const apiToken = secret(row, "apiToken");
    const baseUrl = str(row.settings.baseUrl).replace(/\/$/, "");
    const email = str(row.settings.email);
    const projectKey = str(row.settings.projectKey);
    if (apiToken && baseUrl && email && projectKey) {
      return {
        baseUrl,
        email,
        apiToken,
        projectKey,
        issueType: str(row.settings.issueType, "Task"),
        doneTransition: str(row.settings.doneTransition, "Done"),
      };
    }
  }
  // An explicitly disabled row means "off for this tenant", and must not fall
  // through to an environment default that would switch it back on.
  if (row && !row.enabled) return null;

  const baseUrl = process.env.JIRA_BASE_URL?.trim().replace(/\/$/, "");
  const email = process.env.JIRA_EMAIL?.trim();
  const apiToken = process.env.JIRA_API_TOKEN?.trim();
  const projectKey = process.env.JIRA_PROJECT_KEY?.trim();
  if (!baseUrl || !email || !apiToken || !projectKey) return null;
  return {
    baseUrl,
    email,
    apiToken,
    projectKey,
    issueType: process.env.JIRA_ISSUE_TYPE?.trim() || "Task",
    doneTransition: process.env.JIRA_DONE_TRANSITION?.trim() || "Done",
  };
}

export async function resolveSlackConfig(
  orgId: string,
): Promise<ResolvedSlackConfig | null> {
  let row: StoredRow | null = null;
  try {
    row = await readRow(orgId, "slack");
  } catch (error) {
    console.error(
      "[nocturne-integrations] reading Slack settings failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }

  if (row && row.enabled) {
    const botToken = secret(row, "botToken");
    const channelId = str(row.settings.channelId);
    const workspaceUrl = str(row.settings.workspaceUrl).replace(/\/$/, "");
    if (botToken && channelId) {
      return { transport: "bot", botToken, channelId, workspaceUrl };
    }
    const webhookUrl = secret(row, "webhookUrl");
    if (webhookUrl) return { transport: "webhook", webhookUrl, workspaceUrl };
  }
  if (row && !row.enabled) return null;

  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  const channelId = process.env.SLACK_CHANNEL_ID?.trim();
  const workspaceUrl = process.env.SLACK_WORKSPACE_URL?.trim().replace(/\/$/, "");
  if (botToken && channelId) {
    return { transport: "bot", botToken, channelId, workspaceUrl };
  }
  const webhookUrl = process.env.SLACK_WEBHOOK_URL?.trim();
  if (webhookUrl) return { transport: "webhook", webhookUrl, workspaceUrl };
  return null;
}

/* ── the settings screen ───────────────────────────────────────────────────── */

export async function listIntegrationSettings(
  orgId: string,
): Promise<IntegrationSettingsView[]> {
  const [jiraRow, slackRow, jira, slack] = await Promise.all([
    readRow(orgId, "jira"),
    readRow(orgId, "slack"),
    resolveJiraConfig(orgId),
    resolveSlackConfig(orgId),
  ]);

  const jiraSaved = Boolean(jiraRow);
  const slackSaved = Boolean(slackRow);

  return [
    {
      provider: "jira",
      enabled: jiraRow?.enabled ?? true,
      configured: jira !== null,
      source: jiraSaved ? "saved" : jira ? "environment" : "none",
      settings: {
        baseUrl: str(jiraRow?.settings.baseUrl),
        email: str(jiraRow?.settings.email),
        projectKey: str(jiraRow?.settings.projectKey),
        issueType: str(jiraRow?.settings.issueType, "Task"),
        doneTransition: str(jiraRow?.settings.doneTransition, "Done"),
      },
      secretHints: jiraRow?.secrets?.apiToken ? { apiToken: "••••" } : {},
      updatedBy: jiraRow?.updatedBy ?? null,
      updatedAt: jiraRow?.updatedAt ?? null,
    },
    {
      provider: "slack",
      enabled: slackRow?.enabled ?? true,
      configured: slack !== null,
      source: slackSaved ? "saved" : slack ? "environment" : "none",
      settings: {
        channelId: str(slackRow?.settings.channelId),
        workspaceUrl: str(slackRow?.settings.workspaceUrl),
      },
      secretHints: {
        ...(slackRow?.secrets?.botToken ? { botToken: "••••" } : {}),
        ...(slackRow?.secrets?.webhookUrl ? { webhookUrl: "••••" } : {}),
      },
      updatedBy: slackRow?.updatedBy ?? null,
      updatedAt: slackRow?.updatedAt ?? null,
    },
  ];
}

export class IntegrationValidationError extends Error {}

function requireHttps(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new IntegrationValidationError(`${label} must be a full URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new IntegrationValidationError(`${label} must use https.`);
  }
  return value.replace(/\/$/, "");
}

export interface IntegrationWriteInput {
  provider: IntegrationProvider;
  enabled: boolean;
  settings: Record<string, string>;
  /**
   * Only the secrets being changed. A field left out keeps whatever is stored,
   * which is what lets the form round-trip without ever holding the plaintext.
   */
  secrets: Record<string, string>;
  actor: string;
}

export function normalizeIntegrationInput(body: unknown): IntegrationWriteInput {
  if (!body || typeof body !== "object") {
    throw new IntegrationValidationError("A JSON body is required.");
  }
  const input = body as Record<string, unknown>;
  const provider = input.provider;
  if (provider !== "jira" && provider !== "slack") {
    throw new IntegrationValidationError("provider must be jira or slack.");
  }

  const rawSettings = (input.settings ?? {}) as Record<string, unknown>;
  const rawSecrets = (input.secrets ?? {}) as Record<string, unknown>;
  const text = (value: unknown, max = 400) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};

  if (provider === "jira") {
    settings.baseUrl = text(rawSettings.baseUrl);
    settings.email = text(rawSettings.email, 254);
    settings.projectKey = text(rawSettings.projectKey, 40).toUpperCase();
    settings.issueType = text(rawSettings.issueType, 60) || "Task";
    settings.doneTransition = text(rawSettings.doneTransition, 60) || "Done";

    if (settings.baseUrl) requireHttps(settings.baseUrl, "The Jira URL");
    if (settings.projectKey && !/^[A-Z][A-Z0-9_]{0,20}$/.test(settings.projectKey)) {
      throw new IntegrationValidationError(
        "The Jira project key looks wrong — it is usually a short code such as SOC.",
      );
    }
    const token = text(rawSecrets.apiToken, 1000);
    if (token) secrets.apiToken = token;
  } else {
    settings.channelId = text(rawSettings.channelId, 40);
    settings.workspaceUrl = text(rawSettings.workspaceUrl);
    if (settings.workspaceUrl) {
      requireHttps(settings.workspaceUrl, "The Slack workspace URL");
    }

    const botToken = text(rawSecrets.botToken, 500);
    if (botToken) {
      if (!botToken.startsWith("xoxb-")) {
        throw new IntegrationValidationError(
          "A Slack bot token starts with xoxb-. Paste the Bot User OAuth Token.",
        );
      }
      secrets.botToken = botToken;
    }
    const webhookUrl = text(rawSecrets.webhookUrl, 500);
    if (webhookUrl) {
      if (!webhookUrl.startsWith("https://hooks.slack.com/")) {
        throw new IntegrationValidationError(
          "A Slack webhook URL starts with https://hooks.slack.com/.",
        );
      }
      secrets.webhookUrl = webhookUrl;
    }
  }

  return {
    provider,
    enabled: input.enabled !== false,
    settings,
    secrets,
    actor: "",
  };
}

/**
 * Writes one provider's configuration.
 *
 * Secrets are merged rather than replaced, so a form that submits only the
 * fields a user retyped does not wipe the ones they left alone. Encryption
 * happens here, immediately before the value is bound into the statement — the
 * plaintext never reaches the SQL text or a log line.
 */
export async function saveIntegrationSettings(
  orgId: string,
  input: IntegrationWriteInput,
): Promise<void> {
  if (Object.keys(input.secrets).length && !isSecretStorageConfigured()) {
    throw new IntegrationValidationError(
      "This server cannot store credentials because NOCTURNE_SECRET_KEY is not "
      + "set. Ask an administrator to configure it.",
    );
  }

  const existing = await readRow(orgId, input.provider);
  const mergedSecrets: Record<string, string> = { ...(existing?.secrets ?? {}) };
  for (const [field, value] of Object.entries(input.secrets)) {
    mergedSecrets[field] = encryptSecret(value);
  }
  // Slack's two transports are mutually exclusive; saving one clears the other
  // so the resolver is never choosing between two live credentials.
  if (input.provider === "slack") {
    if (input.secrets.botToken) delete mergedSecrets.webhookUrl;
    if (input.secrets.webhookUrl) delete mergedSecrets.botToken;
  }

  await executeQuery(
    `MERGE INTO NOCTURNE.CONFIG.INTEGRATION_SETTINGS AS TARGET
     USING (SELECT ? AS ORG_ID, ? AS PROVIDER) AS SOURCE
       ON TARGET.ORG_ID = SOURCE.ORG_ID AND TARGET.PROVIDER = SOURCE.PROVIDER
     WHEN MATCHED THEN UPDATE SET
       ENABLED = ?,
       SETTINGS = CAST(PARSE_JSON(?) AS VARIANT),
       SECRETS = CAST(PARSE_JSON(?) AS VARIANT),
       UPDATED_BY = ?,
       UPDATED_AT = CURRENT_TIMESTAMP()
     WHEN NOT MATCHED THEN INSERT
       (ORG_ID, PROVIDER, ENABLED, SETTINGS, SECRETS, UPDATED_BY)
       VALUES (
         SOURCE.ORG_ID, SOURCE.PROVIDER, ?,
         CAST(PARSE_JSON(?) AS VARIANT), CAST(PARSE_JSON(?) AS VARIANT), ?
       )`,
    [
      orgId,
      input.provider,
      input.enabled,
      JSON.stringify(input.settings),
      JSON.stringify(mergedSecrets),
      input.actor,
      input.enabled,
      JSON.stringify(input.settings),
      JSON.stringify(mergedSecrets),
      input.actor,
    ],
  );
}

/** Removes a provider's row, so the stored credential stops existing. */
export async function deleteIntegrationSettings(
  orgId: string,
  provider: IntegrationProvider,
): Promise<void> {
  await executeQuery(
    `DELETE FROM NOCTURNE.CONFIG.INTEGRATION_SETTINGS
     WHERE ORG_ID = ? AND PROVIDER = ?`,
    [orgId, provider],
  );
}

export { maskSecret };

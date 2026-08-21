"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  Stack,
  Switch,
  TextField,
  Typography,
  alpha,
} from "@mui/material";
import {
  AlertTriangle,
  CheckCircle2,
  Link2Off,
  Mail,
  PlugZap,
  Save,
  XCircle,
} from "lucide-react";

import { Panel } from "@/components/ui/Panel";
import { PageHeader, Tag } from "@/components/ui/Primitives";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { useAuth } from "@/contexts/AuthContext";
import { colors, fonts, layout } from "@/theme/tokens";
import type { SeverityBand } from "@/types";

/**
 * Integrations: where an analyst connects Jira and Slack, and chooses which
 * breaches reach their inbox.
 *
 * Two different scopes share this screen, and the copy says so rather than
 * leaving it to be discovered. Jira and Slack are organization-wide — saving a
 * project key changes where every colleague's tickets land. Email alerting is
 * per-person, on the signed-in user's own profile.
 */

interface IntegrationView {
  provider: "jira" | "slack";
  enabled: boolean;
  configured: boolean;
  source: "saved" | "environment" | "none";
  settings: Record<string, string>;
  secretHints: Record<string, string>;
  updatedBy: string | null;
  updatedAt: string | null;
}

interface ConnectionCheck {
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface ConnectionTestResult {
  provider: "jira" | "slack";
  ok: boolean;
  summary: string;
  checks: ConnectionCheck[];
}

const ALERT_BANDS: SeverityBand[] = ["critical", "high", "medium", "low"];

export default function IntegrationsSettingsPage() {
  const { session } = useAuth();
  const orgId = session?.scope.kind === "org" ? session.scope.orgId : null;

  const [integrations, setIntegrations] = useState<IntegrationView[]>([]);
  const [secretStorageReady, setSecretStorageReady] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, ConnectionTestResult>>({});

  // Jira draft
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraProject, setJiraProject] = useState("");
  const [jiraIssueType, setJiraIssueType] = useState("Task");
  const [jiraDone, setJiraDone] = useState("Done");
  const [jiraToken, setJiraToken] = useState("");

  // Slack draft
  const [slackChannel, setSlackChannel] = useState("");
  const [slackWorkspace, setSlackWorkspace] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackWebhook, setSlackWebhook] = useState("");

  // Per-user email alerting, kept on the signed-in user's profile.
  const [alertEmail, setAlertEmail] = useState<string | null>(null);
  const [alertBands, setAlertBands] = useState<SeverityBand[]>([]);
  const [weeklyDigest, setWeeklyDigest] = useState(true);
  const [alertsSaving, setAlertsSaving] = useState(false);
  const [alertError, setAlertError] = useState<string | null>(null);

  const query = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";

  const apply = useCallback((rows: IntegrationView[]) => {
    setIntegrations(rows);
    const jira = rows.find((row) => row.provider === "jira");
    const slack = rows.find((row) => row.provider === "slack");
    if (jira) {
      setJiraBaseUrl(jira.settings.baseUrl ?? "");
      setJiraEmail(jira.settings.email ?? "");
      setJiraProject(jira.settings.projectKey ?? "");
      setJiraIssueType(jira.settings.issueType || "Task");
      setJiraDone(jira.settings.doneTransition || "Done");
    }
    if (slack) {
      setSlackChannel(slack.settings.channelId ?? "");
      setSlackWorkspace(slack.settings.workspaceUrl ?? "");
    }
    // Typed secrets are never echoed back, so the inputs clear on every load.
    setJiraToken("");
    setSlackBotToken("");
    setSlackWebhook("");
  }, []);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [integrationsResponse, profileResponse] = await Promise.all([
        fetch(`/api/integrations/settings${query}`, {
          cache: "no-store",
          credentials: "same-origin",
        }),
        fetch("/api/user-profile", { cache: "no-store", credentials: "same-origin" }),
      ]);

      const body = await integrationsResponse.json();
      if (!integrationsResponse.ok) {
        throw new Error(body?.error ?? "Unable to load integration settings.");
      }
      apply(body.integrations ?? []);
      setSecretStorageReady(body.secretStorageReady !== false);
      setError(null);

      if (profileResponse.ok) {
        const profile = (await profileResponse.json()).profile;
        setAlertEmail(profile?.email ?? null);
        setAlertBands(profile?.alertBands ?? []);
        setWeeklyDigest(profile?.weeklyDigest ?? true);
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Unable to load settings.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [apply, query, session]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (
      provider: "jira" | "slack",
      settings: Record<string, string>,
      secrets: Record<string, string>,
    ) => {
      setSaving(provider);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch("/api/integrations/settings", {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgId, provider, enabled: true, settings, secrets }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? "Saving failed.");
        apply(body.integrations ?? []);
        setNotice(
          `${provider === "jira" ? "Jira" : "Slack"} settings saved for this organization.`,
        );
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Saving failed.");
      } finally {
        setSaving(null);
      }
    },
    [apply, orgId],
  );

  const disconnect = useCallback(
    async (provider: "jira" | "slack") => {
      setSaving(provider);
      setError(null);
      setNotice(null);
      try {
        const params = new URLSearchParams({ provider });
        if (orgId) params.set("orgId", orgId);
        const response = await fetch(`/api/integrations/settings?${params}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? "Disconnecting failed.");
        apply(body.integrations ?? []);
        setNotice(
          `${provider === "jira" ? "Jira" : "Slack"} disconnected and its credential erased.`,
        );
      } catch (disconnectError) {
        setError(
          disconnectError instanceof Error
            ? disconnectError.message
            : "Disconnecting failed.",
        );
      } finally {
        setSaving(null);
      }
    },
    [apply, orgId],
  );

  const test = useCallback(
    async (provider: "jira" | "slack") => {
      setTesting(provider);
      setError(null);
      try {
        const response = await fetch("/api/integrations/settings/test", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, orgId }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? "The test could not be run.");
        setTests((current) => ({ ...current, [provider]: body }));
      } catch (testError) {
        setError(
          testError instanceof Error ? testError.message : "The test could not be run.",
        );
      } finally {
        setTesting(null);
      }
    },
    [orgId],
  );

  const saveAlerts = useCallback(
    async (bands: SeverityBand[], digest: boolean) => {
      const previousBands = alertBands;
      const previousDigest = weeklyDigest;
      setAlertBands(bands);
      setWeeklyDigest(digest);
      setAlertsSaving(true);
      setAlertError(null);
      try {
        const response = await fetch("/api/user-profile", {
          method: "PUT",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: session?.user.displayName ?? "",
            email: alertEmail,
            position: session?.user.position ?? null,
            alertBands: bands,
            weeklyDigest: digest,
          }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.error ?? "Could not save your alert preferences.");
        }
      } catch (saveError) {
        // Put the switches back where they were: a toggle that stays flipped
        // after a failed save is a promise of emails that will never arrive.
        setAlertBands(previousBands);
        setWeeklyDigest(previousDigest);
        setAlertError(
          saveError instanceof Error ? saveError.message : "Could not save.",
        );
      } finally {
        setAlertsSaving(false);
      }
    },
    [alertBands, alertEmail, session, weeklyDigest],
  );

  const jira = useMemo(
    () => integrations.find((row) => row.provider === "jira"),
    [integrations],
  );
  const slack = useMemo(
    () => integrations.find((row) => row.provider === "slack"),
    [integrations],
  );

  if (isLoading) {
    return (
      <Stack gap={2}>
        <PageHeader title="Integrations" />
        <Panel>
          <Stack alignItems="center" sx={{ py: 6 }}>
            <CircularProgress size={22} />
          </Stack>
        </Panel>
      </Stack>
    );
  }

  return (
    <Stack gap={2}>
      <PageHeader
        title="Integrations"
        subtitle="Connect Jira and Slack, and choose which breaches reach your inbox."
      />

      {!secretStorageReady && (
        <Alert severity="warning" sx={{ fontSize: 12.5 }}>
          This server has no encryption key configured, so credentials cannot be
          saved. An administrator needs to set <code>NOCTURNE_SECRET_KEY</code>{" "}
          (generate one with <code>openssl rand -base64 32</code>) and restart.
        </Alert>
      )}
      {notice && (
        <Alert severity="success" onClose={() => setNotice(null)} sx={{ fontSize: 12.5 }}>
          {notice}
        </Alert>
      )}
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ fontSize: 12.5 }}>
          {error}
        </Alert>
      )}

      <Box sx={{ display: "grid", gap: `${layout.gap}px`, gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" } }}>
        <Panel title="Jira" meta={<StatusMeta view={jira} />}>
          <Stack gap={1.4}>
            <Typography sx={{ fontSize: 12, color: colors.text2, lineHeight: 1.65 }}>
              Dispatching a SOC alert opens a ticket here, and marking the
              incident mitigated closes it. Applies to everyone in this
              organization.
            </Typography>
            <Field label="Jira URL">
              <TextField
                size="small" fullWidth placeholder="https://your-domain.atlassian.net"
                value={jiraBaseUrl} onChange={(e) => setJiraBaseUrl(e.target.value)}
              />
            </Field>
            <Field label="Account email">
              <TextField
                size="small" fullWidth placeholder="soc@company.com"
                value={jiraEmail} onChange={(e) => setJiraEmail(e.target.value)}
              />
            </Field>
            <Stack direction="row" gap={1.2}>
              <Field label="Project key">
                <TextField
                  size="small" fullWidth placeholder="SOC"
                  value={jiraProject} onChange={(e) => setJiraProject(e.target.value)}
                />
              </Field>
              <Field label="Issue type">
                <TextField
                  size="small" fullWidth value={jiraIssueType}
                  onChange={(e) => setJiraIssueType(e.target.value)}
                />
              </Field>
              <Field label="Done transition">
                <TextField
                  size="small" fullWidth value={jiraDone}
                  onChange={(e) => setJiraDone(e.target.value)}
                />
              </Field>
            </Stack>
            <Field
              label={jira?.secretHints.apiToken ? "API token — saved" : "API token"}
            >
              <TextField
                size="small" fullWidth type="password"
                disabled={!secretStorageReady}
                placeholder={
                  jira?.secretHints.apiToken
                    ? "Stored. Type a new token to replace it."
                    : "Paste the token from id.atlassian.com"
                }
                value={jiraToken}
                onChange={(e) => setJiraToken(e.target.value)}
              />
            </Field>
            <Stack direction="row" gap={1}>
              <Button
                size="small" variant="contained" disabled={saving !== null}
                startIcon={
                  saving === "jira" ? <CircularProgress size={13} color="inherit" /> : <Save size={14} />
                }
                onClick={() =>
                  void save(
                    "jira",
                    {
                      baseUrl: jiraBaseUrl, email: jiraEmail, projectKey: jiraProject,
                      issueType: jiraIssueType, doneTransition: jiraDone,
                    },
                    jiraToken ? { apiToken: jiraToken } : {},
                  )
                }
              >
                Save Jira
              </Button>
              <Button
                size="small" variant="outlined"
                disabled={saving !== null || testing !== null || !jira?.configured}
                startIcon={
                  testing === "jira"
                    ? <CircularProgress size={13} color="inherit" />
                    : <PlugZap size={14} />
                }
                onClick={() => void test("jira")}
                sx={{ borderColor: colors.edgeHi, color: colors.text2 }}
              >
                Test connection
              </Button>
              {jira?.source === "saved" && (
                <Button
                  size="small" variant="text" disabled={saving !== null}
                  startIcon={<Link2Off size={14} />}
                  onClick={() => void disconnect("jira")}
                  sx={{ color: colors.text3 }}
                >
                  Disconnect
                </Button>
              )}
            </Stack>
            <TestResult result={tests.jira} />
          </Stack>
        </Panel>

        <Panel title="Slack" meta={<StatusMeta view={slack} />}>
          <Stack gap={1.4}>
            <Typography sx={{ fontSize: 12, color: colors.text2, lineHeight: 1.65 }}>
              Confirmed breaches post to a channel, and mitigations reply in the
              same thread. A bot token is preferred — a webhook cannot thread.
            </Typography>
            <Field label="Channel ID">
              <TextField
                size="small" fullWidth placeholder="C01234567"
                value={slackChannel} onChange={(e) => setSlackChannel(e.target.value)}
              />
            </Field>
            <Field label="Workspace URL (optional)">
              <TextField
                size="small" fullWidth placeholder="https://your-workspace.slack.com"
                value={slackWorkspace} onChange={(e) => setSlackWorkspace(e.target.value)}
              />
            </Field>
            <Field
              label={slack?.secretHints.botToken ? "Bot token — saved" : "Bot token"}
            >
              <TextField
                size="small" fullWidth type="password"
                disabled={!secretStorageReady}
                placeholder={
                  slack?.secretHints.botToken
                    ? "Stored. Type a new token to replace it."
                    : "xoxb-…"
                }
                value={slackBotToken}
                onChange={(e) => setSlackBotToken(e.target.value)}
              />
            </Field>
            <Divider sx={{ borderColor: colors.edge }}>
              <Typography sx={{ fontFamily: fonts.mono, fontSize: 9, color: colors.text3 }}>
                OR
              </Typography>
            </Divider>
            <Field
              label={slack?.secretHints.webhookUrl ? "Webhook URL — saved" : "Webhook URL"}
            >
              <TextField
                size="small" fullWidth type="password"
                disabled={!secretStorageReady}
                placeholder={
                  slack?.secretHints.webhookUrl
                    ? "Stored. Type a new URL to replace it."
                    : "https://hooks.slack.com/services/…"
                }
                value={slackWebhook}
                onChange={(e) => setSlackWebhook(e.target.value)}
              />
            </Field>
            <Stack direction="row" gap={1}>
              <Button
                size="small" variant="contained" disabled={saving !== null}
                startIcon={
                  saving === "slack" ? <CircularProgress size={13} color="inherit" /> : <Save size={14} />
                }
                onClick={() =>
                  void save(
                    "slack",
                    { channelId: slackChannel, workspaceUrl: slackWorkspace },
                    {
                      ...(slackBotToken ? { botToken: slackBotToken } : {}),
                      ...(slackWebhook ? { webhookUrl: slackWebhook } : {}),
                    },
                  )
                }
              >
                Save Slack
              </Button>
              <Button
                size="small" variant="outlined"
                disabled={saving !== null || testing !== null || !slack?.configured}
                startIcon={
                  testing === "slack"
                    ? <CircularProgress size={13} color="inherit" />
                    : <PlugZap size={14} />
                }
                onClick={() => void test("slack")}
                sx={{ borderColor: colors.edgeHi, color: colors.text2 }}
              >
                Test connection
              </Button>
              {slack?.source === "saved" && (
                <Button
                  size="small" variant="text" disabled={saving !== null}
                  startIcon={<Link2Off size={14} />}
                  onClick={() => void disconnect("slack")}
                  sx={{ color: colors.text3 }}
                >
                  Disconnect
                </Button>
              )}
            </Stack>
            <TestResult result={tests.slack} />
          </Stack>
        </Panel>
      </Box>

      <Panel
        title="Breach alerts — email"
        meta={alertsSaving ? "SAVING…" : alertEmail ? `TO ${alertEmail}` : "NO EMAIL SET"}
      >
        <Stack gap={1.4}>
          <Stack direction="row" gap={1} alignItems="flex-start">
            <Mail size={14} color={colors.text3} style={{ marginTop: 3 }} />
            <Typography sx={{ fontSize: 12, color: colors.text2, lineHeight: 1.65 }}>
              Unlike Jira and Slack above, these are <b>your own</b> preferences —
              they change what you are emailed, not what your colleagues receive.
              {!alertEmail && " Add an email address to your profile in Settings to enable them."}
            </Typography>
          </Stack>
          {ALERT_BANDS.map((band) => (
            <Stack key={band} direction="row" alignItems="center" gap={1.2}>
              <Switch
                checked={alertBands.includes(band)}
                onChange={(event) =>
                  void saveAlerts(
                    event.target.checked
                      ? [...alertBands, band]
                      : alertBands.filter((value) => value !== band),
                    weeklyDigest,
                  )
                }
                disabled={!alertEmail || alertsSaving}
                size="small"
                color="secondary"
              />
              <Typography sx={{ fontSize: 12.5, color: colors.text2 }}>Email me on</Typography>
              <SeverityChip band={band} />
            </Stack>
          ))}
          <Divider sx={{ borderColor: colors.edge, my: 0.5 }} />
          <Stack direction="row" alignItems="center" gap={1.2}>
            <Switch
              checked={weeklyDigest}
              onChange={(event) => void saveAlerts(alertBands, event.target.checked)}
              disabled={!alertEmail || alertsSaving}
              size="small"
              color="secondary"
            />
            <Typography sx={{ fontSize: 12.5, color: colors.text2 }}>
              Weekly report, with the PDF attached
            </Typography>
          </Stack>
          {alertError && (
            <Typography sx={{ fontSize: 11.5, color: colors.critical }}>
              {alertError}
            </Typography>
          )}
        </Stack>
      </Panel>

      <Panel>
        <Typography sx={{ fontSize: 11.5, color: colors.text3, lineHeight: 1.7 }}>
          Tokens are encrypted with AES-256-GCM before they are written to
          Snowflake, and the key lives only in the application environment — a
          warehouse administrator reading the table sees ciphertext. Saved
          credentials are never sent back to a browser, not even to the person
          who entered them; the fields above show only whether something is
          stored. Nothing Nocturne sends to Jira or Slack contains verbatim
          leaked material.
        </Typography>
      </Panel>
    </Stack>
  );
}

function TestResult({ result }: { result: ConnectionTestResult | undefined }) {
  if (!result) return null;
  const tone = result.ok ? colors.verified : colors.critical;
  return (
    <Stack
      gap={0.8}
      sx={{
        p: 1.2,
        borderRadius: `${layout.radiusSm}px`,
        border: `1px solid ${alpha(tone, 0.35)}`,
        backgroundColor: alpha(tone, 0.06),
      }}
    >
      <Stack direction="row" gap={0.7} alignItems="flex-start">
        {result.ok ? (
          <CheckCircle2 size={13} color={colors.verified} style={{ marginTop: 2 }} />
        ) : (
          <XCircle size={13} color={colors.critical} style={{ marginTop: 2 }} />
        )}
        <Typography sx={{ fontSize: 12, color: colors.text1, lineHeight: 1.55 }}>
          {result.summary}
        </Typography>
      </Stack>
      {result.checks.map((check) => (
        <Stack key={check.label} direction="row" gap={0.7} alignItems="flex-start" sx={{ pl: 2.4 }}>
          {check.status === "pass" ? (
            <CheckCircle2 size={11} color={colors.verified} style={{ marginTop: 3 }} />
          ) : check.status === "warn" ? (
            <AlertTriangle size={11} color={colors.high} style={{ marginTop: 3 }} />
          ) : (
            <XCircle size={11} color={colors.critical} style={{ marginTop: 3 }} />
          )}
          <Typography sx={{ fontSize: 11, color: colors.text2, lineHeight: 1.55 }}>
            <Box component="span" sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 9.5, mr: 0.7 }}>
              {check.label.toUpperCase()}
            </Box>
            {check.detail}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function StatusMeta({ view }: { view: IntegrationView | undefined }) {
  if (!view) return null;
  if (!view.configured) return <Tag tone="neutral">Not connected</Tag>;
  return (
    <Stack direction="row" gap={0.6} alignItems="center">
      <CheckCircle2 size={12} color={colors.verified} />
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.verified }}>
        {view.source === "environment" ? "FROM ENVIRONMENT" : "CONNECTED"}
      </Typography>
    </Stack>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack gap={0.7} sx={{ flex: 1, minWidth: 0 }}>
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 9.5,
          letterSpacing: "0.13em",
          textTransform: "uppercase",
          color: colors.text3,
        }}
      >
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

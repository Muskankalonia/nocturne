"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import {
  CheckCircle2,
  ExternalLink,
  RotateCcw,
  Send,
  ShieldCheck,
} from "lucide-react";

import {
  TriageRequestError,
  dispatchSocAlert,
  fetchActionState,
  markMitigated,
  unmarkMitigated,
  type ChannelAvailability,
} from "@/lib/triage-client";
import { colors, fonts } from "@/theme/tokens";
import type { IncidentActionState, SocDispatchResponse } from "@/types/triage";

/**
 * The executable half of an incident: mark it mitigated, page the SOC, and see
 * where those actions landed.
 *
 * Shared by the incident detail page and the priority queue rather than
 * duplicated, so the two can never disagree about when a button is available —
 * which matters because "Dispatch" is not idempotent from the user's point of
 * view even though the server makes it so.
 */

export interface IncidentActionBarProps {
  incidentKey: string;
  orgId: string;
  /** Rendered inline in a table row rather than as a full panel. */
  compact?: boolean;
  /** State the parent already has, to skip the initial fetch. */
  initialState?: IncidentActionState | null;
  onChanged?: (state: IncidentActionState) => void;
}

type Busy = "none" | "mitigate" | "dispatch";

export function IncidentActionBar({
  incidentKey,
  orgId,
  compact = false,
  initialState = null,
  onChanged,
}: IncidentActionBarProps) {
  const [state, setState] = useState<IncidentActionState | null>(initialState);
  const [channels, setChannels] = useState<ChannelAvailability | null>(null);
  const [busy, setBusy] = useState<Busy>("none");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmRedispatch, setConfirmRedispatch] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await fetchActionState(incidentKey, orgId);
      setState(result.state);
      setChannels(result.channels);
    } catch (loadError) {
      // A failed state read must not hide the buttons — the actions still work
      // and the server is the one enforcing their preconditions.
      setError(
        loadError instanceof Error ? loadError.message : "Unable to read action state.",
      );
    }
  }, [incidentKey, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    (next: IncidentActionState) => {
      setState(next);
      onChanged?.(next);
    },
    [onChanged],
  );

  const runMitigate = useCallback(
    async (mitigate: boolean, withNote?: string) => {
      setBusy("mitigate");
      setError(null);
      setNotice(null);
      try {
        const result = mitigate
          ? await markMitigated(incidentKey, orgId, withNote)
          : await unmarkMitigated(incidentKey, orgId);
        apply(result.state);

        if (result.jira && result.jira.configured && !result.jira.delivered) {
          // Reported rather than thrown: the mitigation *did* land, and saying
          // otherwise would have the analyst click it again.
          setNotice(
            `Marked mitigated, but ${result.jira.externalId ?? "the Jira ticket"} could not be closed: ${result.jira.error}`,
          );
        } else if (result.jira?.delivered) {
          setNotice(`Marked mitigated · closed ${result.jira.externalId} in Jira.`);
        } else {
          setNotice(mitigate ? "Marked mitigated." : "Reopened.");
        }
      } catch (actionError) {
        setError(
          actionError instanceof Error ? actionError.message : "The action failed.",
        );
      } finally {
        setBusy("none");
      }
    },
    [apply, incidentKey, orgId],
  );

  const runDispatch = useCallback(
    async (force: boolean) => {
      setBusy("dispatch");
      setError(null);
      setNotice(null);
      try {
        const result = await dispatchSocAlert(incidentKey, orgId, force);
        setNotice(describeDispatch(result));
        await load();
      } catch (actionError) {
        if (
          actionError instanceof TriageRequestError
          && actionError.status === 409
        ) {
          setConfirmRedispatch(true);
        } else {
          setError(
            actionError instanceof Error ? actionError.message : "Dispatch failed.",
          );
        }
      } finally {
        setBusy("none");
      }
    },
    [incidentKey, load, orgId],
  );

  const isMitigated = state?.remediationStatus === "mitigated";
  const noChannels = channels ? !channels.email && !channels.jira && !channels.slack : false;

  const buttons = (
    <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
      <Button
        size="small"
        variant={isMitigated ? "outlined" : "contained"}
        disabled={busy !== "none"}
        startIcon={
          busy === "mitigate" ? (
            <CircularProgress size={13} color="inherit" />
          ) : isMitigated ? (
            <RotateCcw size={14} />
          ) : (
            <ShieldCheck size={14} />
          )
        }
        onClick={() => {
          if (isMitigated) void runMitigate(false);
          else setNoteOpen(true);
        }}
        sx={
          isMitigated
            ? { borderColor: colors.edgeHi, color: colors.text2 }
            : {
                backgroundColor: alpha(colors.verified, 0.16),
                color: colors.verified,
                border: `1px solid ${alpha(colors.verified, 0.4)}`,
                "&:hover": { backgroundColor: alpha(colors.verified, 0.24) },
              }
        }
      >
        {isMitigated ? "Unmark mitigated" : "Mark as mitigated"}
      </Button>

      <Tooltip
        title={
          noChannels
            ? "No delivery channel is configured on this deployment. Set the email, Jira, or Slack environment variables."
            : state?.hasBeenDispatched
              ? "Already dispatched — you will be asked to confirm a resend."
              : "Email the SOC, open a Jira ticket, and post to Slack."
        }
      >
        <span>
          <Button
            size="small"
            variant="outlined"
            disabled={busy !== "none" || noChannels}
            startIcon={
              busy === "dispatch" ? (
                <CircularProgress size={13} color="inherit" />
              ) : (
                <Send size={14} />
              )
            }
            onClick={() => void runDispatch(false)}
            sx={{ borderColor: colors.edgeHi, color: colors.ion }}
          >
            {state?.hasBeenDispatched ? "Re-dispatch SOC alert" : "Dispatch SOC alert"}
          </Button>
        </span>
      </Tooltip>

      {state?.jiraIssueUrl && (
        <Button
          size="small"
          variant="text"
          component="a"
          href={state.jiraIssueUrl}
          target="_blank"
          rel="noreferrer noopener"
          startIcon={<ExternalLink size={13} />}
          sx={{ color: colors.text2, fontFamily: fonts.mono, fontSize: 11 }}
        >
          {state.jiraIssueKey}
        </Button>
      )}
      {state?.slackMessageUrl && (
        <Button
          size="small"
          variant="text"
          component="a"
          href={state.slackMessageUrl}
          target="_blank"
          rel="noreferrer noopener"
          startIcon={<ExternalLink size={13} />}
          sx={{ color: colors.text2, fontSize: 11 }}
        >
          Slack
        </Button>
      )}
    </Stack>
  );

  return (
    <Stack gap={compact ? 0.8 : 1.2}>
      {buttons}

      {isMitigated && state?.mitigatedAt && (
        <Stack direction="row" gap={0.6} alignItems="center">
          <CheckCircle2 size={12} color={colors.verified} />
          <Typography sx={{ fontSize: 11, color: colors.text3 }}>
            Mitigated {formatWhen(state.mitigatedAt)} by {state.mitigatedBy ?? "unknown"}
            {state.remediationUpdatedVia === "jira" && " (closed in Jira)"}
          </Typography>
        </Stack>
      )}

      {notice && (
        <Alert
          severity="info"
          onClose={() => setNotice(null)}
          sx={{ fontSize: 11.5, py: 0.2, backgroundColor: alpha(colors.ion, 0.08) }}
        >
          {notice}
        </Alert>
      )}
      {error && (
        <Alert
          severity="error"
          onClose={() => setError(null)}
          sx={{ fontSize: 11.5, py: 0.2 }}
        >
          {error}
        </Alert>
      )}

      {/* Mitigation note — optional, but it is the only place the reason for a
          closure is ever captured, so it is offered rather than assumed. */}
      <Dialog open={noteOpen} onClose={() => setNoteOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 15 }}>Mark this incident mitigated</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12, color: colors.text2, mb: 1.5 }}>
            The incident moves to the Mitigated tab
            {state?.jiraIssueKey ? ` and ${state.jiraIssueKey} is closed in Jira` : ""}.
            You can reopen it at any time.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={2}
            maxRows={5}
            size="small"
            label="Note (optional)"
            placeholder="Credentials rotated, affected accounts notified…"
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, 500))}
          />
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setNoteOpen(false)}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => {
              setNoteOpen(false);
              const submitted = note.trim();
              setNote("");
              void runMitigate(true, submitted || undefined);
            }}
          >
            Mark mitigated
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmRedispatch} onClose={() => setConfirmRedispatch(false)}>
        <DialogTitle sx={{ fontSize: 15 }}>Dispatch this alert again?</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 12.5, color: colors.text2 }}>
            This incident has already been dispatched. Sending again emails every
            recipient a second time and posts to Slack again. The existing Jira
            ticket is commented on rather than duplicated.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setConfirmRedispatch(false)}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            color="warning"
            onClick={() => {
              setConfirmRedispatch(false);
              void runDispatch(true);
            }}
          >
            Dispatch again
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

function describeDispatch(result: SocDispatchResponse): string {
  const configured = result.results.filter((channel) => channel.configured);
  if (!configured.length) {
    return "No delivery channel is configured on this deployment; nothing was sent.";
  }
  const parts = configured.map((channel) =>
    channel.delivered
      ? `${channel.channel}${channel.externalId ? ` (${channel.externalId})` : ""} ✓`
      : `${channel.channel} failed: ${channel.error ?? "unknown error"}`,
  );
  return `Dispatch ${result.outcome} — ${parts.join(" · ")}`;
}

function formatWhen(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

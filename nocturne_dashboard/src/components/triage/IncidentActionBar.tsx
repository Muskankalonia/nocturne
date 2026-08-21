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
  ShieldOff,
} from "lucide-react";

import {
  TriageRequestError,
  dispatchSocAlert,
  fetchActionState,
  markMitigated,
  submitReviewDecision,
  unmarkMitigated,
  withdrawReviewDecision,
  type ChannelAvailability,
} from "@/lib/triage-client";
import { useAuth } from "@/contexts/AuthContext";
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

type Busy = "none" | "mitigate" | "dispatch" | "dismiss";

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
  const [dismissOpen, setDismissOpen] = useState(false);
  const { session } = useAuth();
  // Any signed-in analyst may rule on their own organization's incident, the
  // same as marking one mitigated. The server scopes the write to their tenant.
  const canRule = Boolean(session);

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
        // Null only for a page-level row, which this bar is never rendered for;
        // fall back to a reload rather than clearing the state it is showing.
        if (result.state) apply(result.state);
        else await load();

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

  const runDismiss = useCallback(
    async (dismiss: boolean, reason?: string) => {
      setBusy("dismiss");
      setError(null);
      setNotice(null);
      try {
        // A confirmed incident's monitor key *is* its incident key, so one
        // decisions table serves both an unresolved page and a raised incident.
        if (dismiss) {
          await submitReviewDecision(incidentKey, orgId, "not_a_breach", reason);
          setNotice("Dismissed as not a breach. It now sits under the Dismissed tab.");
        } else {
          await withdrawReviewDecision(incidentKey, orgId);
          setNotice("Dismissal withdrawn; the cascade's own verdict applies again.");
        }
        await load();
      } catch (actionError) {
        setError(
          actionError instanceof Error ? actionError.message : "The action failed.",
        );
      } finally {
        setBusy("none");
      }
    },
    [incidentKey, load, orgId],
  );

  const isDismissed = state?.reviewDecision === "not_a_breach";
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

      {canRule && (
        <Tooltip
          title={
            isDismissed
              ? "Restore the cascade's own verdict for this incident."
              : "Rule that this is not your organization's breach. It moves to the Dismissed tab."
          }
        >
          <span>
            <Button
              size="small"
              variant="text"
              disabled={busy !== "none"}
              startIcon={
                busy === "dismiss" ? (
                  <CircularProgress size={13} color="inherit" />
                ) : (
                  <ShieldOff size={14} />
                )
              }
              onClick={() => {
                if (isDismissed) void runDismiss(false);
                else setDismissOpen(true);
              }}
              sx={{ color: colors.text2, fontSize: 11.5 }}
            >
              {isDismissed ? "Undo dismissal" : "Not a breach"}
            </Button>
          </span>
        </Tooltip>
      )}

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

      {isDismissed && (
        <Stack direction="row" gap={0.6} alignItems="center">
          <ShieldOff size={12} color={colors.text3} />
          <Typography sx={{ fontSize: 11, color: colors.text3 }}>
            Ruled not a breach by {state?.reviewDecidedBy ?? "an administrator"}.
            The cascade still classifies it as a confirmed breach; that reasoning
            is preserved.
          </Typography>
        </Stack>
      )}

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
        <DialogContent sx={{ overflowX: "hidden" }}>
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
        <DialogActions sx={{ px: 3, pb: 2.5, pt: 0 }}>
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

      <Dialog open={dismissOpen} onClose={() => setDismissOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: 15 }}>Rule that this is not a breach</DialogTitle>
        <DialogContent sx={{ overflowX: "hidden" }}>
          <Typography sx={{ fontSize: 12, color: colors.text2, mb: 1.5 }}>
            The incident moves to the Dismissed tab and leaves the active queues.
            What the cascade concluded is kept alongside your ruling and stays
            visible, and you can undo this at any time.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="Reason (optional)"
            placeholder="Resale of a 2019 dump; not our data…"
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, 500))}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, pt: 0 }}>
          <Button size="small" onClick={() => setDismissOpen(false)}>Cancel</Button>
          <Button
            size="small"
            variant="contained"
            color="error"
            onClick={() => {
              setDismissOpen(false);
              const reason = note.trim();
              setNote("");
              void runDismiss(true, reason || undefined);
            }}
          >
            Dismiss incident
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={confirmRedispatch} onClose={() => setConfirmRedispatch(false)}>
        <DialogTitle sx={{ fontSize: 15 }}>Dispatch this alert again?</DialogTitle>
        <DialogContent sx={{ overflowX: "hidden" }}>
          <Typography sx={{ fontSize: 12.5, color: colors.text2 }}>
            This incident has already been dispatched. Sending again emails every
            recipient a second time and posts to Slack again. The existing Jira
            ticket is commented on rather than duplicated.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, pt: 0 }}>
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

/**
 * What actually happened, per channel — including the channels that did
 * nothing.
 *
 * Unconfigured channels used to be filtered out entirely, which made "the SOC
 * was emailed" and "email is switched off on this deployment" render
 * identically. An analyst who has just paged their team reads this line once
 * and moves on; if it omits email, they leave believing the mail went out. A
 * dispatch summary that hides a silent channel is worse than no summary,
 * because it manufactures confidence.
 */
function describeDispatch(result: SocDispatchResponse): string {
  const configured = result.results.filter((channel) => channel.configured);
  const skipped = result.results.filter((channel) => !channel.configured);

  if (!configured.length) {
    return "No delivery channel is configured on this deployment; nothing was sent.";
  }

  const parts = configured.map((channel) =>
    channel.delivered
      ? `${channel.channel}${channel.externalId ? ` (${channel.externalId})` : ""} ✓`
      : `${channel.channel} failed: ${channel.error ?? "unknown error"}`,
  );
  const note = skipped.length
    ? ` · not configured: ${skipped.map((channel) => channel.channel).join(", ")}`
    : "";
  return `Dispatch ${result.outcome} — ${parts.join(" · ")}${note}`;
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

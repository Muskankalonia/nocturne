"use client";

import { useState } from "react";
import { CircularProgress, IconButton, Snackbar, Stack, Tooltip } from "@mui/material";
import { RotateCcw, Send, ShieldCheck } from "lucide-react";

import {
  TriageRequestError,
  dispatchSocAlert,
  markMitigated,
  unmarkMitigated,
} from "@/lib/triage-client";
import { colors } from "@/theme/tokens";
import type { RemediationStatus } from "@/types";

/**
 * Two icon buttons, for acting on an incident without leaving the queue.
 *
 * Deliberately not `IncidentActionBar`. That component fetches its own state on
 * mount, which is correct for a detail page and wrong for a table: a queue of
 * thirty rows would open thirty requests before the user has decided to touch
 * any of them. This one renders from the row data the queue already has and
 * only talks to the server when something is clicked.
 *
 * Re-dispatch is not offered here. It needs a confirmation to be safe, and a
 * confirmation dialog fired from a table row is the kind of thing people
 * dismiss without reading — the detail page is where that decision belongs.
 */

export interface PriorityQueueActionsProps {
  incidentKey: string;
  orgId: string;
  remediationStatus: RemediationStatus;
  onChanged?: () => void;
}

export function PriorityQueueActions({
  incidentKey,
  orgId,
  remediationStatus,
  onChanged,
}: PriorityQueueActionsProps) {
  const [busy, setBusy] = useState<"none" | "mitigate" | "dispatch">("none");
  const [toast, setToast] = useState<string | null>(null);
  // Optimistic, so the icon flips immediately; the parent's refresh reconciles.
  const [mitigated, setMitigated] = useState(remediationStatus === "mitigated");

  const run = async (
    kind: "mitigate" | "dispatch",
    action: () => Promise<unknown>,
    success: string,
  ) => {
    setBusy(kind);
    try {
      await action();
      setToast(success);
      onChanged?.();
    } catch (error) {
      if (error instanceof TriageRequestError && error.status === 409) {
        setToast("Already dispatched — open the incident to send it again.");
      } else {
        setToast(error instanceof Error ? error.message : "The action failed.");
        setMitigated(remediationStatus === "mitigated");
      }
    } finally {
      setBusy("none");
    }
  };

  return (
    <>
      <Stack direction="row" gap={0.3}>
        <Tooltip title={mitigated ? "Reopen this incident" : "Mark as mitigated"}>
          <span>
            <IconButton
              size="small"
              disabled={busy !== "none"}
              aria-label={mitigated ? "Reopen this incident" : "Mark as mitigated"}
              onClick={() => {
                const next = !mitigated;
                setMitigated(next);
                void run(
                  "mitigate",
                  () =>
                    next
                      ? markMitigated(incidentKey, orgId)
                      : unmarkMitigated(incidentKey, orgId),
                  next ? "Marked mitigated." : "Reopened.",
                );
              }}
              sx={{ color: mitigated ? colors.verified : colors.text3 }}
            >
              {busy === "mitigate" ? (
                <CircularProgress size={13} color="inherit" />
              ) : mitigated ? (
                <RotateCcw size={14} />
              ) : (
                <ShieldCheck size={14} />
              )}
            </IconButton>
          </span>
        </Tooltip>

        <Tooltip title="Dispatch SOC alert">
          <span>
            <IconButton
              size="small"
              disabled={busy !== "none"}
              aria-label="Dispatch SOC alert"
              onClick={() =>
                void run(
                  "dispatch",
                  () => dispatchSocAlert(incidentKey, orgId),
                  "SOC alert dispatched.",
                )
              }
              sx={{ color: colors.text3, "&:hover": { color: colors.ion } }}
            >
              {busy === "dispatch" ? (
                <CircularProgress size={13} color="inherit" />
              ) : (
                <Send size={14} />
              )}
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Snackbar
        open={toast !== null}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        message={toast}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
    </>
  );
}

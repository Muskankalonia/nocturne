"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
  alpha,
} from "@mui/material";
import { Camera, Check, RefreshCw, ShieldCheck, X } from "lucide-react";

import {
  fetchScreenshot,
  markMitigated,
  requestScreenshot,
  submitReviewDecision,
  unmarkMitigated,
  withdrawReviewDecision,
} from "@/lib/triage-client";
import { colors, fonts, layout } from "@/theme/tokens";
import type { RemediationStatus } from "@/types";
import type { PageScreenshot, ReviewDecision } from "@/types/triage";

/**
 * Capture-and-rule panel for a "Needs Review" row.
 *
 * The point of this screen is that a machine could not decide, so a person has
 * to look — and looking at a .onion listing should not mean an analyst opening
 * Tor Browser and visiting an adversary's page from their own laptop. The
 * capture is taken out of process by a worker behind Tor, stored, and shown
 * here as a flat image.
 *
 * Because the image is a rendering of hostile content, it is presented as an
 * image and nothing else: no iframe, no embedded HTML, no clickable links
 * lifted out of the page.
 */

export interface ReviewCapturePanelProps {
  orgId: string;
  monitorKey: string;
  url: string;
  /** Existing verdict, so the panel opens in the right state. */
  decision: ReviewDecision | null;
  decidedBy?: string | null;
  /** False renders the capture read-only, with no verdict controls. */
  canDecide: boolean;
  /** Current workflow state of the row, so the mitigate control can toggle. */
  remediationStatus?: RemediationStatus;
  /**
   * False renders the capture on its own, with no verdict controls.
   *
   * Used on the incident detail page, where the capture is evidence for an
   * incident that has already been ruled on and where IncidentActionBar
   * already owns confirm / mitigate / dismiss. Showing a second set of verdict
   * buttons a few hundred pixels away would give the same incident two
   * controls for one decision.
   */
  showVerdictControls?: boolean;
  onDecided?: (decision: ReviewDecision | null) => void;
}

/**
 * Poll fast at first, then back off. A clearnet onion page usually lands in a
 * few seconds; a Dread page sits in an access queue the worker waits out for up
 * to 300s, and hammering Snowflake every 3s for that whole time is wasteful.
 */
const FAST_POLL_MS = 3_000;
const SLOW_POLL_MS = 10_000;
const FAST_PHASE_MS = 30_000;
/**
 * Total budget, deliberately longer than the worker's own interstitial wait
 * (INTERSTITIAL_WAIT, 300s) plus a fetch. Giving up before the worker does
 * would report "stuck" for a capture that was about to arrive.
 */
const MAX_WAIT_MS = 8 * 60_000;

export function ReviewCapturePanel({
  orgId,
  monitorKey,
  url,
  decision,
  decidedBy,
  canDecide,
  remediationStatus = "new",
  showVerdictControls = true,
  onDecided,
}: ReviewCapturePanelProps) {
  const [screenshot, setScreenshot] = useState<PageScreenshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<ReviewDecision | null>(decision);
  const [mitigated, setMitigated] = useState(remediationStatus === "mitigated");
  const [isWorking, setIsWorking] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<ReviewDecision | null>(null);
  const [note, setNote] = useState("");
  const [timedOut, setTimedOut] = useState(false);
  // Bumped on every manual capture so the poll loop restarts its budget even
  // when the status it is watching does not change value.
  const [pollEpoch, setPollEpoch] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await fetchScreenshot(monitorKey, orgId);
      setScreenshot(result.screenshot);
      setError(null);
      return result.screenshot;
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Unable to read the capture.",
      );
      return null;
    } finally {
      setIsLoading(false);
    }
  }, [monitorKey, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const inFlight =
    screenshot?.status === "requested" || screenshot?.status === "capturing";

  // Poll while a capture is in flight, and stop once it lands or the budget
  // runs out — an open tab left overnight must not keep a Snowflake warehouse
  // awake on this row's behalf.
  //
  // The loop lives *inside* the effect rather than being re-armed by it. An
  // earlier version scheduled one timeout and depended on `screenshot?.status`
  // to schedule the next, which silently polled exactly once: a poll that finds
  // the capture still "requested" leaves that dependency unchanged, so the
  // effect never re-ran. Depending on a boolean that stays true for the whole
  // wait, and owning the recursion here, is what makes it keep going.
  useEffect(() => {
    if (!inFlight) return;

    let cancelled = false;
    let elapsed = 0;
    let timer: number | undefined;

    const schedule = () => {
      const delay = elapsed < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS;
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        elapsed += delay;
        if (elapsed > MAX_WAIT_MS) {
          setTimedOut(true);
          return;
        }
        await load();
        // `load` may have flipped the status, in which case this effect is
        // already being torn down and `cancelled` short-circuits the next hop.
        if (!cancelled) schedule();
      }, delay);
    };

    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inFlight, load, pollEpoch]);

  const capture = useCallback(
    async (refresh: boolean) => {
      setIsRequesting(true);
      setError(null);
      try {
        const result = await requestScreenshot(monitorKey, orgId, refresh);
        setScreenshot(result.screenshot);
        setTimedOut(false);
        setPollEpoch((epoch) => epoch + 1);
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Queueing the capture failed.",
        );
      } finally {
        setIsRequesting(false);
      }
    },
    [monitorKey, orgId],
  );

  const rule = useCallback(
    async (verdict: ReviewDecision, withNote: string) => {
      setError(null);
      try {
        await submitReviewDecision(monitorKey, orgId, verdict, withNote || undefined);
        setCurrent(verdict);
        onDecided?.(verdict);
      } catch (decideError) {
        setError(
          decideError instanceof Error
            ? decideError.message
            : "Recording the decision failed.",
        );
      }
    },
    [monitorKey, onDecided, orgId],
  );

  // Mitigation is keyed by monitor key, so a page that never became an incident
  // can be closed out exactly like one that did.
  const toggleMitigated = useCallback(
    async (next: boolean) => {
      setIsWorking(true);
      setError(null);
      try {
        if (next) await markMitigated(monitorKey, orgId);
        else await unmarkMitigated(monitorKey, orgId);
        setMitigated(next);
        onDecided?.(current);
      } catch (mitigateError) {
        setError(
          mitigateError instanceof Error
            ? mitigateError.message
            : "Updating the workflow state failed.",
        );
      } finally {
        setIsWorking(false);
      }
    },
    [current, monitorKey, onDecided, orgId],
  );

  const withdraw = useCallback(async () => {
    setError(null);
    try {
      await withdrawReviewDecision(monitorKey, orgId);
      setCurrent(null);
      onDecided?.(null);
    } catch (withdrawError) {
      setError(
        withdrawError instanceof Error
          ? withdrawError.message
          : "Withdrawing the decision failed.",
      );
    }
  }, [monitorKey, onDecided, orgId]);

  const status = screenshot?.status ?? null;
  const exhausted = inFlight && timedOut;

  return (
    <Stack gap={1.4}>
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        <Typography variant="overline" sx={{ color: colors.text2 }}>
          Page capture
        </Typography>
        <Typography
          sx={{
            fontFamily: fonts.mono,
            fontSize: 10.5,
            color: colors.text3,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 380,
          }}
          title={url}
        >
          {url}
        </Typography>
        <Box sx={{ ml: "auto" }}>
          <Button
            size="small"
            variant="outlined"
            disabled={isRequesting || inFlight}
            startIcon={
              isRequesting || inFlight ? (
                <CircularProgress size={13} color="inherit" />
              ) : status === "captured" ? (
                <RefreshCw size={13} />
              ) : (
                <Camera size={13} />
              )
            }
            onClick={() => void capture(status === "captured")}
            sx={{ borderColor: colors.edgeHi, color: colors.ion }}
          >
            {inFlight
              ? "Capturing…"
              : status === "captured"
                ? "Re-capture"
                : "Capture page"}
          </Button>
        </Box>
      </Stack>

      <Box
        sx={{
          border: `1px solid ${colors.edge}`,
          borderRadius: `${layout.radiusSm}px`,
          backgroundColor: colors.hull,
          minHeight: 220,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {isLoading ? (
          <CircularProgress size={20} />
        ) : status === "captured" && screenshot?.viewUrl ? (
          // A plain <img>, deliberately. The bytes are a rendering of an
          // adversary's page; an iframe or inlined HTML would hand it a
          // scripting context inside an authenticated console.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={screenshot.viewUrl}
            alt={`Captured view of ${url}`}
            style={{ width: "100%", height: "auto", display: "block" }}
          />
        ) : status === "failed" ? (
          <Stack gap={0.8} sx={{ p: 3, textAlign: "center" }}>
            <Typography sx={{ color: colors.critical, fontSize: 12.5 }}>
              The capture failed.
            </Typography>
            <Typography sx={{ color: colors.text3, fontSize: 11, maxWidth: 420 }}>
              {screenshot?.captureError
                ?? "The worker could not reach the page. Onion services go down often; try again later."}
            </Typography>
          </Stack>
        ) : inFlight ? (
          <Stack gap={0.8} alignItems="center" sx={{ p: 3 }}>
            <CircularProgress size={18} />
            <Typography sx={{ color: colors.text2, fontSize: 12 }}>
              {exhausted
                ? "Still queued. The Tor capture worker may not be running."
                : "Fetching the page over Tor. This usually takes under a minute."}
            </Typography>
          </Stack>
        ) : (
          <Stack gap={0.6} alignItems="center" sx={{ p: 4, textAlign: "center" }}>
            <Camera size={22} color={colors.text3} />
            <Typography sx={{ color: colors.text2, fontSize: 12.5 }}>
              No capture yet
            </Typography>
            <Typography sx={{ color: colors.text3, fontSize: 11, maxWidth: 420 }}>
              Capture the page to see what it actually says before ruling on it.
              The fetch happens on a worker behind Tor, never from this console
              and never from your browser.
            </Typography>
          </Stack>
        )}
      </Box>

      {screenshot?.capturedAt && status === "captured" && (
        <Typography sx={{ fontSize: 10.5, color: colors.text3, fontFamily: fonts.mono }}>
          CAPTURED {new Date(screenshot.capturedAt).toISOString().slice(0, 16).replace("T", " ")} UTC
          {screenshot.pageTitle ? ` · ${screenshot.pageTitle}` : ""}
        </Typography>
      )}

      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ fontSize: 11.5, py: 0.2 }}>
          {error}
        </Alert>
      )}

      {showVerdictControls && (current ? (
        <Stack
          direction="row"
          gap={1}
          alignItems="center"
          sx={{
            p: 1.2,
            borderRadius: `${layout.radiusSm}px`,
            border: `1px solid ${alpha(
              current === "confirmed_breach" ? colors.critical : colors.verified,
              0.35,
            )}`,
            backgroundColor: alpha(
              current === "confirmed_breach" ? colors.critical : colors.verified,
              0.07,
            ),
          }}
        >
          <Typography sx={{ fontSize: 12, color: colors.text1 }}>
            Ruled{" "}
            <b>
              {current === "confirmed_breach" ? "a confirmed breach" : "not a breach"}
            </b>
            {decidedBy ? ` by ${decidedBy}` : ""}.
          </Typography>
          {canDecide && (
            <Stack direction="row" gap={0.5} sx={{ ml: "auto" }}>
              <Button
                size="small"
                disabled={isWorking}
                onClick={() => void toggleMitigated(!mitigated)}
                sx={{ color: mitigated ? colors.text2 : colors.verified }}
              >
                {mitigated ? "Unmark mitigated" : "Mark mitigated"}
              </Button>
              <Button size="small" onClick={() => void withdraw()}>
                Withdraw
              </Button>
            </Stack>
          )}
        </Stack>
      ) : canDecide ? (
        <Stack direction="row" gap={1} flexWrap="wrap">
          <Button
            size="small"
            variant="outlined"
            disabled={isWorking}
            startIcon={<Check size={14} />}
            onClick={() => setPendingDecision("confirmed_breach")}
            sx={{ borderColor: alpha(colors.critical, 0.5), color: colors.critical }}
          >
            This is our breach
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={isWorking}
            startIcon={
              isWorking
                ? <CircularProgress size={13} color="inherit" />
                : <ShieldCheck size={14} />
            }
            onClick={() => void toggleMitigated(!mitigated)}
            sx={{ borderColor: alpha(colors.verified, 0.5), color: colors.verified }}
          >
            {mitigated ? "Unmark mitigated" : "Mark as mitigated"}
          </Button>
          <Button
            size="small"
            variant="outlined"
            disabled={isWorking}
            startIcon={<X size={14} />}
            onClick={() => setPendingDecision("not_a_breach")}
            sx={{ borderColor: colors.edgeHi, color: colors.text2 }}
          >
            Not a breach
          </Button>
        </Stack>
      ) : (
        <Typography sx={{ fontSize: 11, color: colors.text3 }}>
          Sign in to rule on this row.
        </Typography>
      ))}

      <Dialog
        open={pendingDecision !== null}
        onClose={() => setPendingDecision(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: 15 }}>
          {pendingDecision === "confirmed_breach"
            ? "Confirm this is a breach of your data"
            : "Rule that this is not a breach"}
        </DialogTitle>
        <DialogContent sx={{ overflowX: "hidden" }}>
          <Typography sx={{ fontSize: 12, color: colors.text2, mb: 1.5 }}>
            {pendingDecision === "confirmed_breach"
              ? "The row moves to Confirmed Breach and becomes actionable — you can dispatch a SOC alert and mark it mitigated."
              : "The row moves to Dismissed and leaves the review queue."}{" "}
            The cascade&apos;s own verdict is kept alongside yours and stays visible
            in the row detail.
          </Typography>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={2}
            size="small"
            label="Reason (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, 500))}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5, pt: 0 }}>
          <Button size="small" onClick={() => setPendingDecision(null)}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => {
              const verdict = pendingDecision!;
              const submitted = note.trim();
              setPendingDecision(null);
              setNote("");
              void rule(verdict, submitted);
            }}
          >
            Record decision
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

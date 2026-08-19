"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { Camera, Check, RefreshCw, X } from "lucide-react";

import {
  fetchScreenshot,
  requestScreenshot,
  submitReviewDecision,
  withdrawReviewDecision,
} from "@/lib/triage-client";
import { colors, fonts, layout } from "@/theme/tokens";
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
  /** Only a super admin may rule; everyone else sees the capture read-only. */
  canDecide: boolean;
  onDecided?: (decision: ReviewDecision | null) => void;
}

const POLL_INTERVAL_MS = 5_000;
/** Two minutes of polling. A Tor fetch that slow has effectively failed. */
const MAX_POLLS = 24;

export function ReviewCapturePanel({
  orgId,
  monitorKey,
  url,
  decision,
  decidedBy,
  canDecide,
  onDecided,
}: ReviewCapturePanelProps) {
  const [screenshot, setScreenshot] = useState<PageScreenshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<ReviewDecision | null>(decision);
  const [pendingDecision, setPendingDecision] = useState<ReviewDecision | null>(null);
  const [note, setNote] = useState("");
  const pollCount = useRef(0);

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
    pollCount.current = 0;
    void load();
  }, [load]);

  // Poll only while a capture is genuinely in flight, and stop after a bounded
  // number of attempts. An open tab left overnight should not keep a Snowflake
  // warehouse awake on this row's behalf.
  useEffect(() => {
    const status = screenshot?.status;
    if (status !== "requested" && status !== "capturing") return;
    if (pollCount.current >= MAX_POLLS) return;

    const timer = window.setTimeout(() => {
      pollCount.current += 1;
      void load();
    }, POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [load, screenshot?.status]);

  const capture = useCallback(
    async (refresh: boolean) => {
      setIsRequesting(true);
      setError(null);
      try {
        const result = await requestScreenshot(monitorKey, orgId, refresh);
        setScreenshot(result.screenshot);
        pollCount.current = 0;
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
  const inFlight = status === "requested" || status === "capturing";
  const exhausted = inFlight && pollCount.current >= MAX_POLLS;

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

      {current ? (
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
            <Button size="small" onClick={() => void withdraw()} sx={{ ml: "auto" }}>
              Withdraw
            </Button>
          )}
        </Stack>
      ) : canDecide ? (
        <Stack direction="row" gap={1} flexWrap="wrap">
          <Button
            size="small"
            variant="outlined"
            startIcon={<Check size={14} />}
            onClick={() => setPendingDecision("confirmed_breach")}
            sx={{ borderColor: alpha(colors.critical, 0.5), color: colors.critical }}
          >
            This is our breach
          </Button>
          <Button
            size="small"
            variant="outlined"
            startIcon={<X size={14} />}
            onClick={() => setPendingDecision("not_a_breach")}
            sx={{ borderColor: colors.edgeHi, color: colors.text2 }}
          >
            Not a breach
          </Button>
        </Stack>
      ) : (
        <Typography sx={{ fontSize: 11, color: colors.text3 }}>
          Only an administrator can rule on this row.
        </Typography>
      )}

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
        <DialogContent>
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
        <DialogActions>
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

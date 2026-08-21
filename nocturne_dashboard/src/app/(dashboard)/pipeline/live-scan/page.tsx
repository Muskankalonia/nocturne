"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Stack,
  Switch,
  Typography,
  alpha,
} from "@mui/material";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleDashed,
  Cloud,
  Database,
  Globe,
  Loader2,
  Network,
  RefreshCw,
  Rocket,
  Search,
  Terminal,
} from "lucide-react";

import { useAuth } from "@/contexts/AuthContext";
import { Panel } from "@/components/ui/Panel";
import { StatGridSkeleton } from "@/components/ui/Skeletons";
import { PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import {
  LIVE_SCAN_IDLE_STAGES,
  LIVE_SCAN_STAGE_COUNT,
  deriveLiveScanCascade,
  deriveLiveScanStages,
  formatDuration,
  isLiveScanCascadeSettled,
  isLiveScanTerminal,
  type LiveScanCascadeCounts,
  type LiveScanCascadeStage,
  type LiveScanExecution,
  type LiveScanLogLine,
  type LiveScanListResponse,
  type LiveScanStage,
  type LiveScanStageId,
  type LiveScanStartResponse,
  type LiveScanStatusResponse,
} from "@/lib/live-scan";
import { relativeTime } from "@/lib/format";
import { colors, fonts, layout as layoutTokens, severityColor } from "@/theme/tokens";

/** How often to pull new logs while a scan is in flight. */
const POLL_INTERVAL_MS = 4_000;

/**
 * Cloud Logging lags the container by a few seconds, so a run that reports
 * terminal is usually still growing its tail. Keep polling for this long after
 * the execution finishes, or the last thing an analyst sees is the crawl
 * stopping mid-sentence.
 */
const TERMINAL_GRACE_MS = 20_000;

/**
 * How long to keep polling a finished run whose cascade is still moving.
 *
 * The crawl ends minutes before the warehouse does. Dropping the stream at the
 * usual twenty-second grace would freeze the cascade rail mid-count and leave
 * an analyst staring at "3 of 18 classified" with no way to advance it short of
 * reselecting the run. Bounded rather than open-ended because a batch whose AI
 * steps are not being driven never settles, and polling a suspended pipeline
 * until the tab closes spends warehouse time to learn nothing.
 */
const CASCADE_WATCH_MS = 5 * 60_000;

/**
 * A two-hour crawl emits tens of thousands of lines and the page holds them all
 * in memory. Cap the buffer at something that still covers a normal fourteen
 * minute run end to end, and drop from the front — the tail is what anyone
 * watching cares about, and Cloud Logging keeps the full record anyway.
 */
const LOG_BUFFER_LIMIT = 4_000;
const DEMO_ORG_ID = "demo_org";

function stageIcon(stage: LiveScanStage) {
  if (stage.state === "complete") return <CheckCircle2 size={14} />;
  if (stage.state === "error") return <AlertTriangle size={14} />;
  if (stage.state === "running") return <Loader2 size={14} className="spin" />;
  switch (stage.id) {
    case "dispatch":
      return <Rocket size={14} />;
    case "tor":
      return <Globe size={14} />;
    case "search":
      return <Search size={14} />;
    case "frontier":
      return <Network size={14} />;
    case "stage":
      return <Cloud size={14} />;
    case "handoff":
      return <Database size={14} />;
    default:
      return <CircleDashed size={14} />;
  }
}

type Tone = "neutral" | "ion" | "ok" | "medium" | "critical";

function stageTone(stage: LiveScanStage): Tone {
  if (stage.state === "complete") return "ok";
  if (stage.state === "error") return "critical";
  if (stage.state === "running") return "ion";
  return "neutral";
}

function toneColorFor(tone: Tone): string {
  switch (tone) {
    case "ok":
      return colors.verified;
    case "critical":
      return severityColor.critical;
    case "medium":
      return severityColor.medium;
    case "ion":
      return colors.ion;
    default:
      return colors.text3;
  }
}

function executionTone(execution: LiveScanExecution | null): Tone {
  if (!execution) return "neutral";
  switch (execution.state) {
    case "succeeded":
      return "ok";
    case "failed":
      return "critical";
    case "cancelled":
      return "medium";
    case "running":
      return "ion";
    default:
      return "neutral";
  }
}

/**
 * The stage rail.
 *
 * Deliberately a near-twin of the one on the paste-dump page: same seven
 * columns, same 132px cards, same disabled-preview behaviour. The two pages are
 * siblings in the sidebar and describe two ways into the same cascade, so an
 * analyst who has read one should not have to learn the other. It is not shared
 * code because the stage types differ and the captions are the whole point —
 * abstracting them into one component would leave a props bag doing the work
 * that two hundred lines of plain markup does more legibly.
 */
function ProgressRail({
  stages,
  selectedStageId,
  onSelectStage,
  disabled = false,
}: {
  stages: LiveScanStage[];
  selectedStageId: LiveScanStageId;
  onSelectStage: (stageId: LiveScanStageId) => void;
  disabled?: boolean;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", md: `repeat(${stages.length}, 1fr)` },
        gap: 1,
      }}
    >
      {stages.map((stage, index) => {
        const tone = stageTone(stage);
        const toneColor = toneColorFor(tone);
        const isSelected = !disabled && selectedStageId === stage.id;
        return (
          <Box
            component={disabled ? "div" : "button"}
            type={disabled ? undefined : "button"}
            key={stage.id}
            aria-disabled={disabled || undefined}
            onClick={disabled ? undefined : () => onSelectStage(stage.id)}
            sx={{
              position: "relative",
              minHeight: 132,
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.42 : 1,
              textAlign: "left",
              border: `1px solid ${
                isSelected
                  ? alpha(toneColor, 0.9)
                  : tone === "neutral"
                    ? colors.edge
                    : alpha(toneColor, 0.45)
              }`,
              borderRadius: `${layoutTokens.radiusSm}px`,
              background: isSelected
                ? `linear-gradient(180deg, ${alpha(toneColor, 0.18)}, ${alpha(toneColor, 0.05)})`
                : tone === "neutral"
                  ? "rgba(255,255,255,0.015)"
                  : `linear-gradient(180deg, ${alpha(toneColor, 0.12)}, rgba(255,255,255,0.015))`,
              p: 1.4,
              overflow: "hidden",
              boxShadow: isSelected ? `0 0 0 1px ${alpha(toneColor, 0.28)} inset` : "none",
              color: colors.text1,
              ...(disabled
                ? null
                : {
                    "&:hover": {
                      borderColor: alpha(toneColor, 0.8),
                      backgroundColor: alpha(toneColor, 0.06),
                    },
                  }),
            }}
          >
            <Stack direction="row" alignItems="center" gap={0.8}>
              <Box sx={{ color: toneColor, display: "flex" }}>{stageIcon(stage)}</Box>
              <Typography sx={{ fontSize: 12, color: colors.text1, fontWeight: 700 }}>
                {stage.label}
              </Typography>
              <Tag tone={tone}>{stage.state}</Tag>
            </Stack>
            <Typography sx={{ mt: 1, color: colors.text2, fontSize: 11.5, lineHeight: 1.5 }}>
              {stage.caption}
            </Typography>
            {stage.detail && (
              <Typography
                sx={{
                  mt: 1,
                  color: toneColor,
                  fontFamily: fonts.mono,
                  fontSize: 10.5,
                  lineHeight: 1.5,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {stage.detail}
              </Typography>
            )}
            <Typography
              sx={{
                position: "absolute",
                right: 10,
                bottom: 8,
                fontFamily: fonts.mono,
                fontSize: 9,
                color: alpha(colors.text3, 0.85),
              }}
            >
              {String(index + 1).padStart(2, "0")}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * The cascade rail.
 *
 * Sits under the crawl rail and picks up exactly where it stops. The crawl rail
 * ends at "Snowflake handoff"; this one starts from the batch that handoff
 * loaded and follows it through the same L0-L4 levels the paste-dump page
 * shows, so the two routes into the warehouse tell one continuous story.
 *
 * The difference from both of its siblings is the counts. A paste dump is one
 * document and every stage is a boolean; a crawl is fifteen to forty pages that
 * move through the cascade at different rates and mostly stop early on purpose.
 * The count and its denominator are therefore the content of each card, and the
 * drop between two cards — eighteen pages screened, three relevant — is the
 * thing worth looking at.
 *
 * Not clickable, unlike the rail above it. There is no per-stage log to reveal:
 * the cascade runs inside Snowflake and these counts are the whole of what the
 * console knows about it. Rendering them as buttons would promise a drill-down
 * that does not exist.
 */
function cascadeTone(stage: LiveScanCascadeStage): Tone {
  if (stage.state === "complete") return "ok";
  if (stage.state === "running") return "ion";
  if (stage.state === "stopped") return "medium";
  return "neutral";
}

function cascadeIcon(stage: LiveScanCascadeStage) {
  if (stage.state === "complete") return <CheckCircle2 size={14} />;
  if (stage.state === "running") return <Loader2 size={14} className="spin" />;
  if (stage.state === "stopped") return <CircleDashed size={14} />;
  return <Circle size={14} />;
}

function CascadeRail({
  stages,
  disabled = false,
}: {
  stages: LiveScanCascadeStage[];
  disabled?: boolean;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", md: `repeat(${stages.length}, 1fr)` },
        gap: 1,
      }}
    >
      {stages.map((stage) => {
        const tone = cascadeTone(stage);
        const toneColor = toneColorFor(tone);
        return (
          <Box
            key={stage.id}
            sx={{
              position: "relative",
              minHeight: 132,
              opacity: disabled ? 0.42 : 1,
              border: `1px solid ${tone === "neutral" ? colors.edge : alpha(toneColor, 0.45)}`,
              borderRadius: `${layoutTokens.radiusSm}px`,
              background:
                tone === "neutral"
                  ? "rgba(255,255,255,0.015)"
                  : `linear-gradient(180deg, ${alpha(toneColor, 0.12)}, rgba(255,255,255,0.015))`,
              p: 1.4,
              overflow: "hidden",
              color: colors.text1,
            }}
          >
            <Stack direction="row" alignItems="center" gap={0.8}>
              <Box sx={{ color: toneColor, display: "flex" }}>{cascadeIcon(stage)}</Box>
              <Typography sx={{ fontSize: 12, color: colors.text1, fontWeight: 700 }}>
                {stage.label}
              </Typography>
              <Tag tone={tone}>{stage.state}</Tag>
            </Stack>

            {/* The count leads, because on this rail it is the finding. A card
              * reading "3 / 18" says more about what the crawl turned up than
              * any of the prose under it. Dimmed to neutral before the level
              * has anything to report, so an untouched stage does not read as
              * a confident zero. */}
            <Stack direction="row" alignItems="baseline" gap={0.5} sx={{ mt: 1.1 }}>
              <Typography
                sx={{
                  fontFamily: fonts.mono,
                  fontSize: 21,
                  fontWeight: 700,
                  lineHeight: 1,
                  color: stage.state === "waiting" ? colors.text3 : toneColor,
                }}
              >
                {stage.count}
              </Typography>
              {stage.total !== null && (
                <Typography
                  sx={{ fontFamily: fonts.mono, fontSize: 11.5, color: colors.text3 }}
                >
                  / {stage.total}
                </Typography>
              )}
            </Stack>

            <Typography sx={{ mt: 0.9, color: colors.text2, fontSize: 11.5, lineHeight: 1.45 }}>
              {stage.caption}
            </Typography>
            {stage.detail && (
              <Typography
                sx={{
                  mt: 0.8,
                  color: toneColor,
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  lineHeight: 1.45,
                }}
              >
                {stage.detail}
              </Typography>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * The raw crawler console.
 *
 * Unfiltered on purpose. The paste-dump page synthesises a curated narrative
 * per stage because its stages come from database columns and there is no real
 * log to show. Here there is one, and a dark-web crawl is far more convincing
 * as its own output — Tor bootstrapping, onion addresses resolving, page titles
 * scrolling past — than as a summary of itself. Every line the container wrote
 * appears here in order, tinted by severity so the failures stay findable.
 */
function LogConsole({
  logs,
  follow,
  onFollowChange,
  isStreaming,
  emptyMessage,
}: {
  logs: LiveScanLogLine[];
  follow: boolean;
  onFollowChange: (next: boolean) => void;
  isStreaming: boolean;
  emptyMessage: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Pin to the bottom as lines arrive, but only while following. Reading back
  // through the log means scrolling up, and yanking the viewport away from
  // someone mid-read is the fastest way to make a live console useless.
  useEffect(() => {
    if (!follow) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [follow, logs]);

  return (
    <Panel
      title="Crawler output"
      meta={
        <Stack direction="row" alignItems="center" gap={1}>
          <span>{`${logs.length.toLocaleString()}${
            logs.length >= LOG_BUFFER_LIMIT ? "+" : ""
          } LINES`}</span>
          <Stack direction="row" alignItems="center" gap={0.3}>
            <Switch
              size="small"
              checked={follow}
              onChange={(event) => onFollowChange(event.target.checked)}
              inputProps={{ "aria-label": "Follow new log output" }}
            />
            <span>FOLLOW</span>
          </Stack>
        </Stack>
      }
    >
      <Box
        ref={scrollRef}
        sx={{
          maxHeight: 460,
          overflow: "auto",
          border: `1px solid ${colors.edge}`,
          borderRadius: `${layoutTokens.radiusSm}px`,
          background: "rgba(0,0,0,0.28)",
          px: 1.2,
          py: 1,
        }}
      >
        {logs.length === 0 ? (
          <Typography sx={{ color: colors.text3, fontSize: 11.5, py: 1 }}>
            {emptyMessage}
          </Typography>
        ) : (
          logs.map((line) => {
            const toneColor = toneColorFor(line.tone);
            return (
              <Stack
                key={line.id}
                direction="row"
                gap={1.1}
                alignItems="flex-start"
                sx={{
                  borderLeft: `2px solid ${
                    line.tone === "neutral" ? "transparent" : alpha(toneColor, 0.75)
                  }`,
                  pl: 1,
                  py: 0.1,
                }}
              >
                <Typography
                  sx={{
                    color: alpha(colors.text3, 0.8),
                    fontFamily: fonts.mono,
                    fontSize: 9.5,
                    minWidth: 58,
                    flexShrink: 0,
                    pt: "1px",
                  }}
                >
                  {line.timestamp ? line.timestamp.slice(11, 19) : "--:--:--"}
                </Typography>
                <Typography
                  sx={{
                    color: line.tone === "neutral" ? colors.text2 : toneColor,
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                  }}
                >
                  {line.text}
                </Typography>
              </Stack>
            );
          })
        )}
        {isStreaming && (
          <Typography
            sx={{
              color: colors.ion,
              fontFamily: fonts.mono,
              fontSize: 11,
              pl: 1,
              pt: 0.6,
            }}
          >
            ▍streaming…
          </Typography>
        )}
      </Box>
    </Panel>
  );
}

/** Mirrors ProgressRail's column template and card height. */
function ProgressRailSkeleton() {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", md: `repeat(${LIVE_SCAN_STAGE_COUNT}, 1fr)` },
        gap: 1,
      }}
    >
      {Array.from({ length: LIVE_SCAN_STAGE_COUNT }, (_, index) => (
        <Box
          key={index}
          sx={{
            minHeight: 132,
            border: `1px solid ${colors.edge}`,
            borderRadius: `${layoutTokens.radiusSm}px`,
            background: "rgba(255,255,255,0.015)",
          }}
        />
      ))}
    </Box>
  );
}

function ExecutionRow({
  execution,
  selected,
  onSelect,
}: {
  execution: LiveScanExecution;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = executionTone(execution);
  const toneColor = toneColorFor(tone);
  return (
    <Box
      component="button"
      type="button"
      onClick={onSelect}
      sx={{
        display: "grid",
        width: "100%",
        gridTemplateColumns: { xs: "1fr", md: "minmax(160px, 1.4fr) 120px 110px 100px" },
        gap: 1.4,
        alignItems: "center",
        textAlign: "left",
        px: 1,
        py: 1,
        border: "none",
        borderTop: `1px solid ${colors.edge}`,
        borderRadius: `${layoutTokens.radiusSm}px`,
        cursor: "pointer",
        color: colors.text1,
        background: selected ? alpha(colors.ion, 0.1) : "transparent",
        "&:hover": { backgroundColor: alpha(colors.ion, 0.06) },
      }}
    >
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text1 }}>
        {execution.executionId}
      </Typography>
      <Typography sx={{ fontSize: 11, color: colors.text2 }}>
        {execution.createTime ? relativeTime(execution.createTime) : "—"}
      </Typography>
      <Box>
        <Tag tone={tone}>{execution.state}</Tag>
      </Box>
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: toneColor }}>
        {formatDuration(execution.startTime, execution.completionTime)}
      </Typography>
    </Box>
  );
}

export default function LiveScanPage() {
  const { session, activeOrg, isFleetScope, isLoading: isAuthLoading } = useAuth();
  const router = useRouter();
  /**
   * Signed in at all, which is now the bar for running a scan.
   *
   * A live leak scan sweeps one organization's own keywords into that
   * organization's own pipeline, so the analyst who owns the tenant is exactly
   * the person who should be able to start one. Which organization a caller may
   * scan, and whose logs they may read, is enforced by the API per request —
   * this only decides what the page offers.
   */
  const canRunScan = Boolean(session);

  const [executions, setExecutions] = useState<LiveScanExecution[]>([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [execution, setExecution] = useState<LiveScanExecution | null>(null);
  const [logs, setLogs] = useState<LiveScanLogLine[]>([]);
  const [selectedStageId, setSelectedStageId] = useState<LiveScanStageId>("dispatch");
  const [cascade, setCascade] = useState<LiveScanCascadeCounts | null>(null);
  /** Bumped by Refresh to restart a poll loop that has already given up. */
  const [pollNonce, setPollNonce] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isStarting, setIsStarting] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** Session and run history still resolving; nothing on the page is real yet. */
  const isBootstrapping = isAuthLoading || isLoading;

  const liveScanBlockedReason = useMemo(() => {
    if (!canRunScan) return "Sign in to start a live leak scan.";
    if (isFleetScope) return "Select one real organization before starting a live leak scan.";
    if (!activeOrg) return "Select one organization before starting a live leak scan.";
    if (activeOrg.orgId === DEMO_ORG_ID) {
      return "Demo Organization is sample data. Select Odido or European Commission before starting a live leak scan.";
    }
    return null;
  }, [activeOrg, canRunScan, isFleetScope]);

  /**
   * Cursor and dedupe set, held in refs rather than state.
   *
   * Both are written by the poll and read by the next poll, and neither should
   * cause a render on its own. Keying them by execution id is what makes
   * switching runs safe: a response for the previous selection finds a stale
   * key and is dropped instead of appending another run's output to this one.
   */
  const streamRef = useRef<{
    executionId: string | null;
    cursor: string | null;
    seen: Set<string>;
  }>({ executionId: null, cursor: null, seen: new Set() });
  const terminalSinceRef = useRef<number | null>(null);

  const loadExecutions = useCallback(async () => {
    const response = await fetch("/api/live-scan", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const body = (await response.json()) as LiveScanListResponse | { error?: string };
    if (!response.ok || !("executions" in body)) {
      throw new Error(
        "error" in body && body.error ? body.error : "Unable to load live scan history.",
      );
    }
    setExecutions(body.executions);
    // Attach to whatever is running, otherwise to the most recent run, so the
    // page opens on something worth looking at rather than empty.
    setSelectedExecutionId((current) => {
      if (current) return current;
      const active = body.executions.find(
        (candidate) => candidate.state === "running" || candidate.state === "pending",
      );
      return active?.executionId ?? body.executions[0]?.executionId ?? null;
    });
    return body.executions;
  }, []);

  /**
   * Pull the next window of logs for the selected run.
   *
   * Returns whether the run is finished so the poll loop can decide to stop,
   * rather than reading it back out of state a render later.
   */
  const pollSelected = useCallback(async (
    executionId: string,
  ): Promise<{ isTerminal: boolean; cascadeSettled: boolean }> => {
    const stream = streamRef.current;
    const since = stream.executionId === executionId ? stream.cursor : null;
    const query = since ? `?since=${encodeURIComponent(since)}` : "";

    const response = await fetch(`/api/live-scan/${executionId}${query}`, {
      cache: "no-store",
      credentials: "same-origin",
    });
    const body = (await response.json()) as LiveScanStatusResponse | { error?: string };
    if (!response.ok || !("execution" in body)) {
      throw new Error(
        "error" in body && body.error ? body.error : "Unable to load live scan status.",
      );
    }

    // The selection moved while this was in flight — its logs belong to a run
    // the analyst is no longer looking at.
    if (streamRef.current.executionId !== executionId) {
      return { isTerminal: true, cascadeSettled: true };
    }

    setExecution(body.execution);
    setExecutions((current) =>
      current.map((candidate) =>
        candidate.executionId === body.execution.executionId ? body.execution : candidate,
      ),
    );

    const incomingLogs = [...body.logs, ...(body.handoffLogs ?? [])];
    const fresh = incomingLogs.filter((line) => !streamRef.current.seen.has(line.id));
    streamRef.current.cursor = body.cursor ?? streamRef.current.cursor;
    if (fresh.length > 0) {
      for (const line of fresh) streamRef.current.seen.add(line.id);
      setLogs((current) => {
        const next = [...current, ...fresh];
        return next.length > LOG_BUFFER_LIMIT ? next.slice(-LOG_BUFFER_LIMIT) : next;
      });
    }
    setCascade(body.cascade ?? null);
    return {
      isTerminal: body.isTerminal,
      cascadeSettled: isLiveScanCascadeSettled(body.cascadeStages),
    };
  }, []);

  // Initial load. Fleet admins only — everyone else gets the explanatory panel
  // below and no requests are made on their behalf.
  useEffect(() => {
    if (isAuthLoading || !canRunScan) {
      if (!isAuthLoading) setIsLoading(false);
      return;
    }
    let cancelled = false;
    void loadExecutions()
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load live scans.");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthLoading, canRunScan, loadExecutions]);

  // Selection changed: drop the previous run's buffer before anything for the
  // new one can arrive, so the console never shows two runs interleaved.
  useEffect(() => {
    streamRef.current = {
      executionId: selectedExecutionId,
      cursor: null,
      seen: new Set(),
    };
    terminalSinceRef.current = null;
    setLogs([]);
    setExecution(null);
    setCascade(null);
    setSelectedStageId("dispatch");
  }, [selectedExecutionId]);

  // The stream. One interval that keeps running for a grace period past the end
  // of the execution, because Cloud Logging delivers the last few lines after
  // Cloud Run has already called the run finished.
  useEffect(() => {
    if (!selectedExecutionId || !canRunScan) return;
    let cancelled = false;

    /**
     * Consecutive failures, not any failure.
     *
     * A single poll can fail for reasons that have nothing to do with the run —
     * a Cloud Logging rate limit, a dropped connection, a redeploy mid-crawl.
     * Tearing the stream down on the first one means a two-hour crawl stops
     * being watchable because of a blip four minutes in, and there is no way
     * back short of a reload. Three in a row is a real outage; fewer is noise
     * worth riding out silently.
     */
    let consecutiveFailures = 0;

    const tick = async () => {
      try {
        const { isTerminal, cascadeSettled } = await pollSelected(selectedExecutionId);
        if (cancelled) return;
        consecutiveFailures = 0;
        setError(null);
        if (isTerminal) {
          terminalSinceRef.current ??= Date.now();
          // Two different things can still be in flight once Cloud Run exits:
          // the tail of the log stream, which arrives within seconds, and the
          // cascade, which takes minutes. Hold the stream open for whichever
          // is still going.
          const grace = cascadeSettled ? TERMINAL_GRACE_MS : CASCADE_WATCH_MS;
          if (Date.now() - terminalSinceRef.current > grace) {
            window.clearInterval(timer);
          }
        } else {
          terminalSinceRef.current = null;
        }
      } catch (pollError) {
        if (cancelled) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          setError(
            pollError instanceof Error ? pollError.message : "Live scan status is unavailable.",
          );
          window.clearInterval(timer);
        }
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [canRunScan, pollNonce, pollSelected, selectedExecutionId]);

  const startScan = useCallback(async () => {
    if (liveScanBlockedReason || !activeOrg) {
      setError(liveScanBlockedReason ?? "Select an organization before starting a live leak scan.");
      return;
    }
    setIsStarting(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/live-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: activeOrg.orgId }),
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = (await response.json()) as LiveScanStartResponse | { error?: string };
      if (!response.ok || !("executionId" in body)) {
        setError(
          "error" in body && body.error ? body.error : "Could not start the live leak scan.",
        );
        return;
      }
      setNotice(body.message);
      setSelectedExecutionId(body.executionId);
      await loadExecutions().catch(() => {
        // The run started; a stale history list is not worth an error banner.
      });
    } catch {
      setError("Could not reach the server.");
    } finally {
      setIsStarting(false);
    }
  }, [activeOrg, liveScanBlockedReason, loadExecutions]);

  /**
   * "Run pipeline" on the posture page lands here with ?autostart=1 and expects
   * the crawl to already be starting.
   *
   * Two guards, because this spends money. The ref makes it fire at most once
   * per mount — React runs effects twice in development, and without it the
   * first thing a developer would see is two crawls. Stripping the parameter
   * before the request goes out means a reload, a back-navigation, or a shared
   * URL replays the page rather than the run. The server's already-running
   * check is the backstop if both of those somehow fail.
   *
   * Waits for bootstrap so the start lands after the history list, otherwise
   * loadExecutions can resolve later and reset the selection to an older run.
   *
   * Read off `window.location` rather than `useSearchParams`, deliberately.
   * That hook subscribes a client component to the URL, which forces the page
   * out of static prerendering unless it sits inside a Suspense boundary — and
   * this app has none. A launch flag consumed once inside an effect does not
   * need a subscription; the effect only ever runs in the browser.
   */
  const autostartRef = useRef(false);
  useEffect(() => {
    if (autostartRef.current || isBootstrapping || !canRunScan || liveScanBlockedReason) return;
    if (new URLSearchParams(window.location.search).get("autostart") !== "1") return;
    autostartRef.current = true;
    router.replace("/pipeline/live-scan", { scroll: false });
    void startScan();
  }, [isBootstrapping, canRunScan, liveScanBlockedReason, router, startScan]);

  const refresh = useCallback(async () => {
    setError(null);
    // Re-arm the stream as well as the history list. Once a run's cascade has
    // gone quiet the poll loop has already stopped, and without this the
    // Refresh button would update the run list beside a rail it cannot move.
    terminalSinceRef.current = null;
    setPollNonce((current) => current + 1);
    await loadExecutions();
  }, [loadExecutions]);

  // The authoritative rail: derived from the whole buffer this page has seen,
  // not from the single window the last poll returned.
  const stages = useMemo(() => deriveLiveScanStages(execution, logs), [execution, logs]);
  const cascadeStages = useMemo(() => deriveLiveScanCascade(cascade), [cascade]);
  const isRunning = execution ? !isLiveScanTerminal(execution) : false;
  const pagesSaved = useMemo(() => {
    const savedLines = logs.filter((line) => line.text.includes("SAVED |")).length;
    const summary = [...logs]
      .reverse()
      .map((line) => /Pages saved(?: \(keyword match\))?:\s*(\d+)/.exec(line.text))
      .find((match): match is RegExpExecArray => match !== null);
    return summary ? Number(summary[1]) : savedLines;
  }, [logs]);
  const failureCount = useMemo(
    () => logs.filter((line) => line.tone === "critical" || line.text.includes("FAILED:")).length,
    [logs],
  );
  const hasNoRuns = !isBootstrapping && executions.length === 0;

  const headerRight = (
    <Stack direction="row" gap={1}>
      <Button
        size="small"
        variant="outlined"
        startIcon={<RefreshCw size={13} />}
        disabled={isBootstrapping || !canRunScan}
        onClick={() =>
          void refresh().catch((refreshError: unknown) =>
            setError(refreshError instanceof Error ? refreshError.message : "Refresh failed."),
          )
        }
      >
        Refresh
      </Button>
      <Button
        size="small"
        variant="contained"
        startIcon={
          isStarting ? <Loader2 size={14} className="spin" /> : <Terminal size={14} />
        }
        disabled={isBootstrapping || isStarting || !canRunScan || Boolean(liveScanBlockedReason)}
        title={liveScanBlockedReason ?? undefined}
        onClick={() => void startScan()}
      >
        {isStarting ? "Starting…" : "Run Live Leak Scan"}
      </Button>
    </Stack>
  );

  if (!isAuthLoading && !canRunScan) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Run Live Leak Scan"
          subtitle="Fleet administrators only."
        />
        <Panel>
          <Typography sx={{ color: colors.text2, fontSize: 12.5, lineHeight: 1.7 }}>
            A live scan crawls Tor for one selected monitored organization and spends shared
            compute, so it is restricted to fleet administrators. To feed your own data into
            the cascade, use Upload Paste Dump instead — that runs against your organization
            only without starting the crawler.
          </Typography>
        </Panel>
      </Stack>
    );
  }

  return (
    <Stack
      gap={2}
      sx={{
        minHeight: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)`,
      }}
    >
      <PageHeader
        title="Run Live Leak Scan"
        subtitle="Start the dark-web crawler on demand and watch its output stream in as it works."
        right={headerRight}
      />

      {error && (
        <Alert severity="error" variant="outlined" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="info" variant="outlined" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {liveScanBlockedReason && canRunScan && !isBootstrapping && (
        <Alert severity="warning" variant="outlined">
          {liveScanBlockedReason}
        </Alert>
      )}

      {isBootstrapping ? (
        <StatGridSkeleton cards={4} />
      ) : (
        <StatGrid>
          <StatCard
            label="Run state"
            value={execution ? execution.state : "idle"}
            sub={execution?.executionId ?? "no run selected"}
            accent={toneColorFor(executionTone(execution))}
            valueColor={toneColorFor(executionTone(execution))}
          />
          <StatCard
            label="Elapsed"
            value={formatDuration(execution?.startTime ?? null, execution?.completionTime ?? null)}
            sub={isRunning ? "still crawling" : "final duration"}
            accent={colors.ion}
          />
          <StatCard
            label="Pages saved"
            value={pagesSaved.toLocaleString()}
            sub="keyword matches written to GCS"
            accent={colors.verified}
            valueColor={colors.verified}
          />
          <StatCard
            label="Fetch failures"
            value={failureCount.toLocaleString()}
            sub="dead onion hosts and timeouts"
            accent={severityColor.medium}
          />
        </StatGrid>
      )}

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", xl: "0.9fr 1.1fr" }, gap: 2 }}>
        <Panel title="Start a live crawl" meta="TOR · CLOUD RUN JOB">
          <Stack gap={1.5}>
            <Typography sx={{ color: colors.text2, fontSize: 12.3, lineHeight: 1.65 }}>
              This starts the <b>nocturne-crawler</b> container on Cloud Run. It brings up Tor,
              queries Ahmia and Dread for{" "}
              <b>{activeOrg?.canonicalName ?? "the selected organization"}</b> only, walks the results
              breadth-first, and writes keyword-matching pages to GCS as schema-v2 JSONL.gz.
              Snowflake picks the batch up from there and the L0–L4 cascade runs behind it.
            </Typography>
            <Typography sx={{ color: colors.text3, fontSize: 11.5, lineHeight: 1.6 }}>
              A healthy run takes about 15 minutes; a slow one can reach two hours. You do not
              have to wait — the crawl continues after you leave this page, and incidents appear
              in Breach Monitor as the cascade finishes with them.
            </Typography>
            <Button
              variant="contained"
              startIcon={
                isStarting ? <Loader2 size={16} className="spin" /> : <Terminal size={16} />
              }
              disabled={isBootstrapping || isStarting || Boolean(liveScanBlockedReason)}
              title={liveScanBlockedReason ?? undefined}
              onClick={() => void startScan()}
            >
              {isBootstrapping
                ? "Loading workspace…"
                : isStarting
                  ? "Starting crawler…"
                  : liveScanBlockedReason
                    ? "Select organization first"
                  : "Run Live Leak Scan"}
            </Button>
            {(isStarting || isRunning) && (
              <LinearProgress
                sx={{
                  height: 3,
                  borderRadius: 3,
                  backgroundColor: alpha(colors.ion, 0.18),
                  "& .MuiLinearProgress-bar": { backgroundColor: colors.ion },
                }}
              />
            )}
            <Typography sx={{ color: colors.text3, fontSize: 11, lineHeight: 1.55 }}>
              Only one crawl runs at a time. Asking for a second while one is in flight attaches
              you to the run already going rather than starting another.
            </Typography>
          </Stack>
        </Panel>

        <Panel
          title="Recent crawler runs"
          meta={isBootstrapping ? "LOADING" : `${executions.length} RUNS`}
        >
          {isBootstrapping ? (
            <Stack gap={1}>
              {Array.from({ length: 4 }, (_, index) => (
                <Box
                  key={index}
                  sx={{ height: 38, borderRadius: `${layoutTokens.radiusSm}px`, background: "rgba(255,255,255,0.02)" }}
                />
              ))}
            </Stack>
          ) : hasNoRuns ? (
            <Typography sx={{ color: colors.text2, fontSize: 12 }}>
              No crawler runs found yet.
            </Typography>
          ) : (
            <Box sx={{ maxHeight: 360, overflow: "auto" }}>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "1fr",
                    md: "minmax(160px, 1.4fr) 120px 110px 100px",
                  },
                  gap: 1.4,
                  px: 1,
                  pb: 0.9,
                  color: colors.text3,
                  fontFamily: fonts.mono,
                  fontSize: 9.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                }}
              >
                <span>Execution</span>
                <span>Started</span>
                <span>State</span>
                <span>Duration</span>
              </Box>
              {executions.map((candidate) => (
                <ExecutionRow
                  key={candidate.executionId}
                  execution={candidate}
                  selected={candidate.executionId === selectedExecutionId}
                  onSelect={() => setSelectedExecutionId(candidate.executionId)}
                />
              ))}
            </Box>
          )}
        </Panel>
      </Box>

      <Panel
        title="Live pipeline flow"
        meta={hasNoRuns ? "AWAITING FIRST RUN" : selectedExecutionId ?? "NO RUN SELECTED"}
      >
        {isBootstrapping ? (
          <ProgressRailSkeleton />
        ) : execution ? (
          <ProgressRail
            stages={stages}
            selectedStageId={selectedStageId}
            onSelectStage={setSelectedStageId}
          />
        ) : (
          <Stack gap={1.4}>
            <ProgressRail
              stages={LIVE_SCAN_IDLE_STAGES}
              selectedStageId={selectedStageId}
              onSelectStage={setSelectedStageId}
              disabled
            />
            <Typography sx={{ color: colors.text3, fontSize: 11.5, lineHeight: 1.55 }}>
              {hasNoRuns
                ? "Start a live leak scan to watch the crawler move through these seven stages."
                : "Select a run from Recent crawler runs to attach to its log stream."}
            </Typography>
          </Stack>
        )}
      </Panel>

      <Panel
        title="Snowflake cascade"
        meta={
          cascade
            ? `RUN ${cascade.pagesRaw} PAGE${cascade.pagesRaw === 1 ? "" : "S"} · READ-ONLY`
            : "AWAITING BATCH · READ-ONLY"
        }
      >
        <Stack gap={1.4}>
          <CascadeRail stages={cascadeStages} disabled={!cascade} />
          <Typography sx={{ color: colors.text3, fontSize: 11.5, lineHeight: 1.55 }}>
            {cascade
              ? "Counts read straight from the L0–L4 dynamic tables for this run. "
                + "The console reports the batch's position here; it does not push it "
                + "forward, so a level can sit waiting while the scheduled Snowflake "
                + "tasks catch up."
              : execution && isLiveScanTerminal(execution)
                ? "The batch is not visible in RAW yet. It appears here once the "
                  + "Snowflake handoff above has loaded the crawl's pages."
                : "Once the crawl above finishes and its pages land in Snowflake, this "
                  + "rail follows them through the same L0–L4 cascade as a paste dump."}
          </Typography>
        </Stack>
      </Panel>

      <LogConsole
        logs={logs}
        follow={follow}
        onFollowChange={setFollow}
        isStreaming={isRunning}
        emptyMessage={
          selectedExecutionId
            ? "Waiting for the container to emit its first line. Tor bootstrap takes about 90 seconds."
            : "No run selected. Start a live leak scan, or pick an earlier run to replay its output."
        }
      />

      <style jsx global>{`
        .spin {
          animation: nocturne-spin 1s linear infinite;
        }
        @keyframes nocturne-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </Stack>
  );
}

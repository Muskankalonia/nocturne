/**
 * Live leak scan: the shape of a crawler run, and how to read one off its logs.
 *
 * The paste-dump page tells its story from Snowflake columns — every stage there
 * has a boolean behind it. A live crawl has no such table. It is a Cloud Run Job
 * running a Tor browser, and the only thing it emits while it works is stdout.
 * So the stage rail here is *derived* from the log text, using the milestone
 * lines the crawler already prints.
 *
 * That makes this module a contract with `src/nocturne_crawler/scraper.py`. The
 * markers below are matched against real output, and if someone rewords a print
 * statement the rail quietly stops advancing. They are kept as substrings rather
 * than anchored regexes for exactly that reason: a substring survives a changed
 * prefix, an indent, or an added suffix, which is how these lines actually drift.
 *
 * Deliberately pure and dependency-free — the API route derives stages for the
 * response, and the page re-derives them as new log pages stream in, and neither
 * should be able to disagree with the other.
 */

export type LiveScanStageId =
  | "dispatch"
  | "tor"
  | "search"
  | "frontier"
  | "crawl"
  | "stage"
  | "handoff";

export type LiveScanStageState = "waiting" | "running" | "complete" | "error";

export interface LiveScanStage {
  id: LiveScanStageId;
  label: string;
  caption: string;
  state: LiveScanStageState;
  detail: string | null;
}

export type LiveScanLogTone = "neutral" | "ion" | "ok" | "medium" | "critical";

export interface LiveScanLogLine {
  /** Cloud Logging insertId — unique per entry, used to dedupe across polls. */
  id: string;
  timestamp: string;
  text: string;
  tone: LiveScanLogTone;
  /** Which rail stage this line belongs to, when it is a milestone. */
  stage: LiveScanStageId | null;
}

export type LiveScanExecutionState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface LiveScanExecution {
  /** Short id, e.g. "nocturne-crawler-dfqzb". The path segment we route on. */
  executionId: string;
  state: LiveScanExecutionState;
  createTime: string | null;
  startTime: string | null;
  completionTime: string | null;
  runningCount: number;
  succeededCount: number;
  failedCount: number;
  cancelledCount: number;
  /** Populated only when the run ended badly. */
  failureMessage: string | null;
  /** Deep link into Cloud Logging for the full unfiltered record. */
  logUri: string | null;
}

export interface LiveScanStartResponse {
  executionId: string;
  statusUrl: string;
  message: string;
}

export interface LiveScanListResponse {
  executions: LiveScanExecution[];
  fetchedAt: string;
}

export interface LiveScanStatusResponse {
  execution: LiveScanExecution;
  stages: LiveScanStage[];
  logs: LiveScanLogLine[];
  /**
   * Newest timestamp in `logs`, echoed back by the client as `?since=` to fetch
   * only what has appeared since. Null when this page was empty, in which case
   * the client keeps the cursor it already had.
   */
  cursor: string | null;
  /** True once the execution is finished and no further logs will arrive. */
  isTerminal: boolean;
  fetchedAt: string;
}

/**
 * The seven stages of a live crawl, in the order the crawler reaches them.
 *
 * Seven matches the paste-dump rail on purpose. The two pages sit next to each
 * other in the sidebar and describe two routes into the same cascade; giving
 * them the same shape means an analyst reads the second one for free.
 */
const STAGE_TEMPLATE: ReadonlyArray<Omit<LiveScanStage, "state" | "detail">> = [
  {
    id: "dispatch",
    label: "Dispatch",
    caption: "Start the crawler job on Cloud Run and attach to its log stream.",
  },
  {
    id: "tor",
    label: "Tor circuit",
    caption: "Bootstrap Tor and confirm the browser is routing through it.",
  },
  {
    id: "search",
    label: "Search engines",
    caption: "Query Ahmia and Dread for every enabled organization.",
  },
  {
    id: "frontier",
    label: "Frontier",
    caption: "Merge engine results into one deduplicated BFS entry set.",
  },
  {
    id: "crawl",
    label: "Crawl & extract",
    caption: "Fetch onion pages, keep the ones matching leak keywords.",
  },
  {
    id: "stage",
    label: "Stage to GCS",
    caption: "Write matched pages as schema-v2 JSONL.gz under raw/crawls/.",
  },
  {
    id: "handoff",
    label: "Snowflake handoff",
    caption: "COPY the batch into RAW; the L0–L4 cascade takes over.",
  },
];

export const LIVE_SCAN_STAGE_COUNT = STAGE_TEMPLATE.length;

/** The rail before anything has run — every stage waiting, nothing claimed. */
export const LIVE_SCAN_IDLE_STAGES: LiveScanStage[] = STAGE_TEMPLATE.map((stage) => ({
  ...stage,
  state: "waiting",
  detail: null,
}));

/**
 * Milestone lines, most-advanced first.
 *
 * Order matters twice over. Matching runs top-down and stops at the first hit,
 * so a line that could belong to two stages resolves to the later one — "Pages
 * saved:" is printed during the crawl summary but means staging has begun.
 * And because the list is ordered by stage progression, the first match against
 * the *newest* log line is also the furthest point the run has reached.
 */
const STAGE_MARKERS: ReadonlyArray<{ stage: LiveScanStageId; markers: string[] }> = [
  { stage: "handoff", markers: ["CRAWL COMPLETE"] },
  { stage: "stage", markers: ["page(s) saved ->", "Pages saved:", "Output: gs://"] },
  { stage: "crawl", markers: ["SAVED |", "NO KEYWORD MATCH", "Depth 0 |", "Depth 1 |", "Depth 2 |"] },
  { stage: "frontier", markers: ["Entry points (", "No results for this query"] },
  { stage: "search", markers: ["[SEARCH:", "[STEP 1] Searching"] },
  { stage: "tor", markers: ["Tor verified!", "Verifying Tor connection", "Starting Tor browser", "Waiting for Tor", "Bootstrapped "] },
  { stage: "dispatch", markers: ["DARK WEB BFS CRAWLER", "Organization source:"] },
];

const STAGE_ORDER: Record<LiveScanStageId, number> = STAGE_TEMPLATE.reduce(
  (order, stage, index) => {
    order[stage.id] = index;
    return order;
  },
  {} as Record<LiveScanStageId, number>,
);

/** Which stage a single log line announces, or null if it is ordinary chatter. */
export function stageForLogLine(text: string): LiveScanStageId | null {
  for (const { stage, markers } of STAGE_MARKERS) {
    if (markers.some((marker) => text.includes(marker))) return stage;
  }
  return null;
}

/**
 * Colour for a log line.
 *
 * Every line is shown, so tone is the only thing separating the eight hundred
 * routine lines of a crawl from the one that says why it died. Checked in
 * severity order — a line can match several of these and the worst wins.
 */
export function toneForLogLine(text: string, severity?: string | null): LiveScanLogTone {
  const upper = (severity ?? "").toUpperCase();
  if (upper === "ERROR" || upper === "CRITICAL" || upper === "ALERT" || upper === "EMERGENCY") {
    return "critical";
  }
  if (text.includes("FATAL:") || text.includes("Traceback")) return "critical";
  if (
    text.includes("FAILED:")
    || text.includes("WARNING")
    || text.includes("[warn]")
    || upper === "WARNING"
  ) {
    return "medium";
  }
  if (
    text.includes("SAVED |")
    || text.includes("Tor verified!")
    || text.includes("CRAWL COMPLETE")
    || text.includes("page(s) saved ->")
  ) {
    return "ok";
  }
  if (
    text.includes("[SEARCH:")
    || text.includes("Entry points (")
    || text.includes("Bootstrapped ")
    || /\bDepth \d+ \|/.test(text)
  ) {
    return "ion";
  }
  return "neutral";
}

/**
 * Fold a run's logs into the seven-stage rail.
 *
 * The furthest marker seen wins, and everything before it is reported complete.
 * That is a deliberate simplification: the crawler interleaves stages across
 * organizations — it will finish staging one org and go back to searching for
 * the next — so tracking stages as a strict state machine would show the rail
 * marching backwards. Furthest-reached is monotonic, which is what someone
 * watching a progress rail expects it to be.
 *
 * `logs` may be a partial window (the client keeps a capped buffer), so a run
 * that is already finished is trusted from its execution state rather than from
 * whether the "CRAWL COMPLETE" line happens to still be in the buffer.
 */
export function deriveLiveScanStages(
  execution: LiveScanExecution | null,
  logs: LiveScanLogLine[],
): LiveScanStage[] {
  if (!execution) return LIVE_SCAN_IDLE_STAGES;

  let furthest = STAGE_ORDER.dispatch;
  const detailFor: Partial<Record<LiveScanStageId, string>> = {};

  for (const line of logs) {
    if (!line.stage) continue;
    const position = STAGE_ORDER[line.stage];
    if (position >= furthest) furthest = position;
    // Last line wins per stage: the newest milestone is the informative one.
    detailFor[line.stage] = line.text.trim().slice(0, 160);
  }

  const failed = execution.state === "failed" || execution.state === "cancelled";
  const succeeded = execution.state === "succeeded";
  if (succeeded) furthest = STAGE_ORDER.handoff;

  // A crawl that never printed a milestone is still starting up; nothing past
  // dispatch has actually happened yet.
  const sawAnyMilestone = logs.some((line) => line.stage !== null);
  const pending = execution.state === "pending" || (!sawAnyMilestone && !failed && !succeeded);

  return STAGE_TEMPLATE.map((stage) => {
    const position = STAGE_ORDER[stage.id];
    const detail = detailFor[stage.id] ?? null;

    if (pending && stage.id === "dispatch") {
      return {
        ...stage,
        state: "running" as const,
        detail: detail ?? "Container starting. Tor takes about 90 seconds to bootstrap.",
      };
    }
    if (position < furthest) return { ...stage, state: "complete" as const, detail };
    if (position > furthest) return { ...stage, state: "waiting" as const, detail: null };

    // The stage the run is sitting on.
    if (failed) {
      return {
        ...stage,
        state: "error" as const,
        detail:
          execution.failureMessage
          ?? detail
          ?? (execution.state === "cancelled" ? "Run cancelled." : "Run failed here."),
      };
    }
    if (succeeded) return { ...stage, state: "complete" as const, detail };
    return { ...stage, state: "running" as const, detail };
  });
}

/** Cloud Run reports a finished execution; nothing more will stream in. */
export function isLiveScanTerminal(execution: LiveScanExecution | null): boolean {
  if (!execution) return false;
  return (
    execution.state === "succeeded"
    || execution.state === "failed"
    || execution.state === "cancelled"
  );
}

/** "14m 18s" — run durations, in the units a person watching would use. */
export function formatDuration(fromIso: string | null, toIso: string | null): string {
  if (!fromIso) return "—";
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "—";
  const seconds = Math.floor((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

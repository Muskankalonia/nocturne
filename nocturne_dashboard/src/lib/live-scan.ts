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
  /**
   * The organization this run swept, read back from the execution's own ORG_ID
   * override.
   *
   * Null for a scheduled fleet sweep, which carries no override and therefore
   * covers every tenant. That distinction is what tenant scoping is built on:
   * an organization user may see a run of their own org and must never see a
   * fleet sweep, whose logs name every other tenant.
   */
  orgId: string | null;
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

export interface LiveScanSnowflakeHandoff {
  copiedAt: string;
  runId: string;
  orgId: string | null;
  sourcePattern: string;
  rowsLoaded: number;
  rawRows: number;
  rawFiles: number;
  lastRawIngestedAt: string | null;
  detail: string;
}

export interface LiveScanStatusResponse {
  execution: LiveScanExecution;
  stages: LiveScanStage[];
  logs: LiveScanLogLine[];
  /**
   * Server-generated status lines for work that happens after Cloud Run exits.
   * These are intentionally separate from `logs` so the polling cursor always
   * remains a real Cloud Logging timestamp.
   */
  handoffLogs?: LiveScanLogLine[];
  snowflakeHandoff?: LiveScanSnowflakeHandoff | null;
  /**
   * Where the batch has reached in the L0-L4 cascade, once it is in RAW.
   *
   * Null until the handoff has actually loaded rows: before that there is no
   * run to count, and reporting zeroes would claim the cascade ran and found
   * nothing. Counts only — no page text and no claim text crosses this line.
   */
  cascade?: LiveScanCascadeCounts | null;
  cascadeStages?: LiveScanCascadeStage[];
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
    caption: "Query Ahmia and Dread for the selected organization only.",
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
  { stage: "handoff", markers: ["COPY loaded", "raw page(s) into Snowflake"] },
  { stage: "stage", markers: ["CRAWL COMPLETE", "page(s) saved ->", "Pages saved:", "Output: gs://"] },
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
  if (text.includes("Runtime budget reached") || text.includes("partial_success")) return "medium";
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
    || text.includes("COPY loaded")
    || text.includes("raw page(s) into Snowflake")
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

function hasSavedCrawlerOutput(logs: LiveScanLogLine[]): boolean {
  return logs.some(
    (line) => line.text.includes("SAVED |") || line.text.includes("page(s) saved ->"),
  );
}

function hasFinalizedCrawlerOutput(logs: LiveScanLogLine[]): boolean {
  return logs.some(
    (line) =>
      line.text.includes("CRAWL COMPLETE")
      || line.text.includes("Pages saved:")
      || line.text.includes("Output: gs://"),
  );
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
  const savedCrawlerOutput = hasSavedCrawlerOutput(logs);
  const finalizedCrawlerOutput = hasFinalizedCrawlerOutput(logs);
  if (finalizedCrawlerOutput) furthest = Math.max(furthest, STAGE_ORDER.stage);
  if (succeeded) furthest = Math.max(furthest, STAGE_ORDER.stage);

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

    // The stage the run is sitting on. A Cloud Run timeout after matched pages
    // were written is still a crawler failure, but not a total extraction
    // failure: mark the page-fetch stage as partial and leave the handoff as
    // waiting unless the manifest/output summary confirms finalization.
    if (failed && savedCrawlerOutput && !finalizedCrawlerOutput && stage.id === "crawl") {
      return {
        ...stage,
        state: "error" as const,
        detail: "Some pages were saved before the run ended; final GCS manifest may be incomplete.",
      };
    }
    if (failed && !finalizedCrawlerOutput && (!savedCrawlerOutput || position <= furthest)) {
      return {
        ...stage,
        state: "error" as const,
        detail:
          execution.failureMessage
          ?? detail
          ?? (execution.state === "cancelled" ? "Run cancelled." : "Run failed here."),
      };
    }
    if (failed && finalizedCrawlerOutput) {
      return { ...stage, state: "complete" as const, detail };
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

/* ---------------------------------------------------------------------------
 * The cascade rail
 *
 * Everything above this line describes the crawl: a Cloud Run container walking
 * Tor, ending at the Snowflake handoff. Everything below describes what happens
 * to the batch *after* that handoff — the same L0-L4 cascade the paste-dump page
 * shows, read for a whole crawl run instead of for one pasted document.
 *
 * The two rails cannot share a shape, and it is worth being clear about why. A
 * paste dump is one page, so every stage there is a boolean: L1 either ran or it
 * did not. A crawl returns fifteen to forty pages, and they do not move through
 * the cascade together — some are screened while others are still being routed,
 * and most legitimately stop early because they turned out to be about a
 * different company. So each stage here carries a count and a denominator, and
 * the interesting number is usually the drop between two stages rather than
 * either stage on its own.
 *
 * Pure and dependency-free for the same reason as the crawl rail above: the API
 * route derives these stages for its response and the page re-derives them from
 * the counts, and the two must not be able to disagree.
 * ------------------------------------------------------------------------- */

export type LiveScanCascadeStageId =
  | "l0_signals"
  | "l1_relevance"
  | "l2_evidence"
  | "l3_graph"
  | "l4_insight";

/**
 * `stopped` is the state the crawl rail has no use for and this one cannot do
 * without. A page that L1 decided belongs to another company has not failed and
 * is not still working — it is finished, correctly, without going further. Half
 * a crawl ends this way on a normal run, so rendering it as an error would make
 * every successful scan look broken.
 */
export type LiveScanCascadeStageState = "waiting" | "running" | "complete" | "stopped";

/** One row of the run-scoped cascade query, straight off Snowflake. */
export interface LiveScanCascadeCounts {
  runId: string;
  orgId: string | null;
  /** Distinct pages loaded into RAW for this run. The denominator for L0. */
  pagesRaw: number;
  pagesL0: number;
  pagesL1: number;
  /**
   * Pages L1 judged worth extracting from. This is the L2 denominator rather
   * than `pagesL1`, because L2 is only ever asked to look at these.
   */
  pagesL1Eligible: number;
  pagesL2: number;
  /** Pages L2 routed `target_confirmed` — the ones that reach the graph. */
  pagesL3: number;
  incidentsL4: number;
  /** Of those incidents, how many already carry an AI brief. */
  incidentsBriefed: number;
  lastUpdatedAt: string | null;
  fetchedAt: string;
}

export interface LiveScanCascadeStage {
  id: LiveScanCascadeStageId;
  label: string;
  caption: string;
  state: LiveScanCascadeStageState;
  /** How many pages (or, at L4, incidents) have cleared this level. */
  count: number;
  /** What `count` is out of. Null when a denominator would be meaningless. */
  total: number | null;
  detail: string | null;
}

const CASCADE_TEMPLATE: ReadonlyArray<
  Pick<LiveScanCascadeStage, "id" | "label" | "caption">
> = [
  {
    id: "l0_signals",
    label: "L0 signals",
    caption: "Detect regex indicators on every crawled page, raw text unchanged.",
  },
  {
    id: "l1_relevance",
    label: "L1 relevance",
    caption: "Classify which pages actually concern this organization.",
  },
  {
    id: "l2_evidence",
    label: "L2 evidence",
    caption: "Extract and ground claims on the pages L1 flagged.",
  },
  {
    id: "l3_graph",
    label: "L3 graph",
    caption: "Promote target-owned claims and actors into the graph.",
  },
  {
    id: "l4_insight",
    label: "L4 insight",
    caption: "Raise incidents with severity, triage priority, and an AI brief.",
  },
];

export const LIVE_SCAN_CASCADE_STAGE_COUNT = CASCADE_TEMPLATE.length;

/** The cascade rail before a batch has landed — every stage waiting. */
export const LIVE_SCAN_CASCADE_IDLE_STAGES: LiveScanCascadeStage[] = CASCADE_TEMPLATE.map(
  (stage) => ({ ...stage, state: "waiting", count: 0, total: null, detail: null }),
);

function pageWord(count: number): string {
  return count === 1 ? "page" : "pages";
}

/**
 * Fold the run-scoped counts into the five-stage cascade rail.
 *
 * Each level is "done" when the level feeding it has nothing left pending, not
 * when its own count reaches its denominator — the funnel narrows on purpose,
 * and `3 of 18` at L3 is a finished stage, not a stalled one. The two narrowing
 * levels (L3, L4) therefore take completion from the level above rather than
 * from their own ratio.
 *
 * A null `counts` means the batch is not visible in RAW yet, which is the
 * ordinary state for the first minute after the handoff. That is reported as a
 * waiting rail rather than an empty one, because zeroes here would read as
 * "the cascade ran and found nothing".
 */
export function deriveLiveScanCascade(
  counts: LiveScanCascadeCounts | null,
): LiveScanCascadeStage[] {
  if (!counts || counts.pagesRaw === 0) return LIVE_SCAN_CASCADE_IDLE_STAGES;

  const l0Done = counts.pagesL0 >= counts.pagesRaw;
  const l1Done = l0Done && counts.pagesL0 > 0 && counts.pagesL1 >= counts.pagesL0;
  const l2Done = l1Done && counts.pagesL1Eligible > 0 && counts.pagesL2 >= counts.pagesL1Eligible;
  const nothingEligible = l1Done && counts.pagesL1Eligible === 0;

  /**
   * A stage that has not started yet does not know its denominator.
   *
   * L2's total is the count of pages L1 found relevant, which is zero right up
   * until L1 has looked at them. Rendering that honestly as `0 / 0` would read
   * as a settled finding — nothing eligible, nothing extracted — when the real
   * answer is "ask again in a minute". Null is the shape the rail draws as no
   * denominator at all.
   */
  const known = (state: LiveScanCascadeStageState, total: number): number | null =>
    state === "waiting" ? null : total;

  return CASCADE_TEMPLATE.map((stage): LiveScanCascadeStage => {
    switch (stage.id) {
      case "l0_signals":
        return {
          ...stage,
          state: l0Done ? "complete" : "running",
          count: counts.pagesL0,
          total: counts.pagesRaw,
          detail: `${counts.pagesL0} of ${counts.pagesRaw} ${pageWord(counts.pagesRaw)} screened for indicators.`,
        };

      case "l1_relevance": {
        const state: LiveScanCascadeStageState = l1Done
          ? "complete"
          : l0Done
            ? "running"
            : "waiting";
        return {
          ...stage,
          state,
          count: counts.pagesL1,
          total: known(state, counts.pagesL0),
          detail:
            state === "waiting"
              ? null
              : `${counts.pagesL1} of ${counts.pagesL0} classified · `
                + `${counts.pagesL1Eligible} relevant to this organization.`,
        };
      }

      case "l2_evidence": {
        const state: LiveScanCascadeStageState = nothingEligible
          ? "stopped"
          : l2Done
            ? "complete"
            : l1Done || counts.pagesL2 > 0
              ? "running"
              : "waiting";
        return {
          ...stage,
          state,
          count: counts.pagesL2,
          total: known(state, counts.pagesL1Eligible),
          detail: nothingEligible
            ? "No page cleared L1, so there is nothing to extract from."
            : state === "waiting"
              ? null
              : `${counts.pagesL2} of ${counts.pagesL1Eligible} relevant ${pageWord(counts.pagesL1Eligible)} extracted.`,
        };
      }

      case "l3_graph": {
        const state: LiveScanCascadeStageState = nothingEligible
          ? "stopped"
          : l2Done
            ? counts.pagesL3 > 0
              ? "complete"
              : "stopped"
            : counts.pagesL2 > 0
              ? "running"
              : "waiting";
        return {
          ...stage,
          state,
          count: counts.pagesL3,
          total: known(state, counts.pagesL2),
          detail: nothingEligible
            ? null
            : state === "stopped"
              ? `Ownership was not verified on any of the ${counts.pagesL2} extracted ${pageWord(counts.pagesL2)}.`
              : state === "waiting"
                ? null
                : `${counts.pagesL3} of ${counts.pagesL2} ${pageWord(counts.pagesL2)} confirmed target-owned.`,
        };
      }

      case "l4_insight": {
        const reachedGraph = counts.pagesL3 > 0;
        const briefsDone = counts.incidentsL4 > 0 && counts.incidentsBriefed >= counts.incidentsL4;
        const state: LiveScanCascadeStageState = nothingEligible || (l2Done && !reachedGraph)
          ? "stopped"
          : briefsDone
            ? "complete"
            : reachedGraph
              ? "running"
              : "waiting";
        return {
          ...stage,
          state,
          count: counts.incidentsL4,
          total: known(state, counts.pagesL3),
          detail:
            state === "stopped"
              ? "No page reached the graph, so no incident was raised."
              : state === "waiting"
                ? null
                : `${counts.incidentsL4} incident${counts.incidentsL4 === 1 ? "" : "s"} raised · `
                  + `${counts.incidentsBriefed} with an AI brief.`,
        };
      }
    }
  });
}

/**
 * True when no stage is still expecting work.
 *
 * The poll loop uses this to decide whether to keep watching after Cloud Run
 * has exited. `stopped` counts as settled — a batch where nothing cleared L1 is
 * finished, and waiting for it to change would poll forever.
 */
export function isLiveScanCascadeSettled(
  stages: LiveScanCascadeStage[] | undefined,
): boolean {
  if (!stages || stages.length === 0) return false;
  return stages.every((stage) => stage.state === "complete" || stage.state === "stopped");
}

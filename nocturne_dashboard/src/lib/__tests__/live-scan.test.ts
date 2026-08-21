import { describe, expect, it } from "vitest";

import {
  LIVE_SCAN_CASCADE_IDLE_STAGES,
  LIVE_SCAN_CASCADE_STAGE_COUNT,
  LIVE_SCAN_IDLE_STAGES,
  LIVE_SCAN_STAGE_COUNT,
  deriveLiveScanCascade,
  deriveLiveScanStages,
  formatDuration,
  isLiveScanCascadeSettled,
  isLiveScanTerminal,
  stageForLogLine,
  toneForLogLine,
  type LiveScanCascadeCounts,
  type LiveScanCascadeStageId,
  type LiveScanExecution,
  type LiveScanLogLine,
  type LiveScanStageId,
} from "@/lib/live-scan";

/* ── fixtures ──────────────────────────────────────────────────────────────── */

function execution(
  overrides: Partial<LiveScanExecution> = {},
): LiveScanExecution {
  return {
    executionId: "nocturne-crawler-x8svq",
    orgId: "odido",
    state: "running",
    createTime: "2026-08-18T09:59:50.000Z",
    startTime: "2026-08-18T10:00:00.000Z",
    completionTime: null,
    runningCount: 1,
    succeededCount: 0,
    failedCount: 0,
    cancelledCount: 0,
    failureMessage: null,
    logUri: null,
    ...overrides,
  };
}

function line(text: string): LiveScanLogLine {
  return {
    timestamp: "2026-08-18T10:00:01.000Z",
    text,
    stage: stageForLogLine(text),
    tone: toneForLogLine(text),
  } as LiveScanLogLine;
}

function counts(
  overrides: Partial<LiveScanCascadeCounts> = {},
): LiveScanCascadeCounts {
  return {
    runId: "nocturne-crawler-x8svq",
    orgId: "acme_corp",
    pagesRaw: 0,
    pagesL0: 0,
    pagesL1: 0,
    pagesL1Eligible: 0,
    pagesL2: 0,
    pagesL3: 0,
    incidentsL4: 0,
    incidentsBriefed: 0,
    lastUpdatedAt: null,
    fetchedAt: "2026-08-18T10:05:00.000Z",
    ...overrides,
  };
}

const stateOf = (stages: { id: string; state: string }[], id: string) =>
  stages.find((stage) => stage.id === id)!.state;

/* ── log line classification ───────────────────────────────────────────────── */

describe("stageForLogLine", () => {
  it("maps a milestone to its stage", () => {
    expect(stageForLogLine("DARK WEB BFS CRAWLER v4")).toBe("dispatch");
    expect(stageForLogLine("Tor verified!")).toBe("tor");
    expect(stageForLogLine("[SEARCH: ahmia] query=\"Acme\"")).toBe("search");
    expect(stageForLogLine("Entry points (12)")).toBe("frontier");
    expect(stageForLogLine("SAVED | depth=1 | acme leak")).toBe("crawl");
    expect(stageForLogLine("CRAWL COMPLETE")).toBe("stage");
    expect(stageForLogLine("COPY loaded 9 raw page(s) into Snowflake")).toBe("handoff");
  });

  it("returns null for ordinary chatter", () => {
    expect(stageForLogLine("connecting to socks proxy")).toBeNull();
  });

  it("resolves an ambiguous line to the later stage", () => {
    // "Pages saved:" is printed inside the crawl summary but is the signal
    // that staging to GCS has begun. Markers are matched most-advanced first
    // precisely so this line does not read as "still crawling".
    expect(stageForLogLine("Pages saved: 9")).toBe("stage");
  });
});

describe("toneForLogLine", () => {
  it("lets an ERROR severity override the text", () => {
    expect(toneForLogLine("SAVED | a page", "ERROR")).toBe("critical");
    expect(toneForLogLine("routine", "EMERGENCY")).toBe("critical");
  });

  it("treats a traceback as critical regardless of severity", () => {
    expect(toneForLogLine("Traceback (most recent call last):")).toBe("critical");
    expect(toneForLogLine("FATAL: no Tor circuit")).toBe("critical");
  });

  it("treats a budget stop as medium, not critical", () => {
    // A run that stops on its runtime budget has usually saved pages. Colouring
    // it red would send an analyst looking for a failure that did not happen.
    expect(toneForLogLine("Runtime budget reached, draining queue")).toBe("medium");
    expect(toneForLogLine("status=partial_success")).toBe("medium");
    expect(toneForLogLine("FAILED: fetch timed out")).toBe("medium");
    expect(toneForLogLine("[warn] slow circuit")).toBe("medium");
    expect(toneForLogLine("anything", "WARNING")).toBe("medium");
  });

  it("greens the lines that mean progress", () => {
    expect(toneForLogLine("SAVED | depth=0")).toBe("ok");
    expect(toneForLogLine("COPY loaded 9 raw page(s) into Snowflake")).toBe("ok");
  });

  it("tints navigational lines without claiming success", () => {
    expect(toneForLogLine("[SEARCH: dread]")).toBe("ion");
    expect(toneForLogLine("Bootstrapped 100%")).toBe("ion");
    expect(toneForLogLine("Depth 2 | http://x.onion")).toBe("ion");
  });

  it("leaves everything else neutral", () => {
    expect(toneForLogLine("merging frontier")).toBe("neutral");
  });
});

/* ── the crawl rail ────────────────────────────────────────────────────────── */

describe("deriveLiveScanStages", () => {
  it("is entirely idle with no execution", () => {
    expect(deriveLiveScanStages(null, [])).toEqual(LIVE_SCAN_IDLE_STAGES);
    expect(LIVE_SCAN_STAGE_COUNT).toBe(7);
  });

  it("shows dispatch running while the container starts", () => {
    const stages = deriveLiveScanStages(execution({ state: "pending" }), []);
    expect(stateOf(stages, "dispatch")).toBe("running");
    expect(stages[0].detail).toMatch(/Tor takes about 90 seconds/);
    expect(stateOf(stages, "tor")).toBe("waiting");
  });

  it("treats a running execution with no milestones as still dispatching", () => {
    const stages = deriveLiveScanStages(execution(), [line("connecting")]);
    expect(stateOf(stages, "dispatch")).toBe("running");
  });

  it("completes every stage before the furthest marker reached", () => {
    const stages = deriveLiveScanStages(execution(), [
      line("DARK WEB BFS CRAWLER v4"),
      line("Tor verified!"),
      line("[SEARCH: ahmia]"),
      line("Entry points (12)"),
      line("SAVED | depth=1"),
    ]);
    expect(stateOf(stages, "dispatch")).toBe("complete");
    expect(stateOf(stages, "frontier")).toBe("complete");
    expect(stateOf(stages, "crawl")).toBe("running");
    expect(stateOf(stages, "stage")).toBe("waiting");
    expect(stateOf(stages, "handoff")).toBe("waiting");
  });

  it("does not march backwards when the crawler revisits an earlier stage", () => {
    // The crawler interleaves organizations: it finishes staging one and goes
    // back to searching for the next. Furthest-reached must be monotonic.
    const stages = deriveLiveScanStages(execution(), [
      line("SAVED | depth=1"),
      line("[SEARCH: dread]"),
    ]);
    expect(stateOf(stages, "search")).toBe("complete");
    expect(stateOf(stages, "crawl")).toBe("running");
  });

  it("keeps the newest milestone as the detail for a stage", () => {
    const stages = deriveLiveScanStages(execution(), [
      line("SAVED | first page"),
      line("SAVED | second page"),
    ]);
    expect(stages.find((s) => s.id === "crawl")!.detail).toBe("SAVED | second page");
  });

  it("completes the crawl stages on success even with a truncated log buffer", () => {
    // The client keeps a capped buffer, so "CRAWL COMPLETE" may have scrolled
    // out. A succeeded execution is trusted over the buffer's contents for
    // everything up to staging.
    const stages = deriveLiveScanStages(
      execution({ state: "succeeded", completionTime: "2026-08-18T10:14:18.000Z", succeededCount: 1, runningCount: 0 }),
      [line("Entry points (12)")],
    );
    expect(stateOf(stages, "crawl")).toBe("complete");
    expect(stateOf(stages, "stage")).toBe("complete");
  });

  it("leaves the handoff waiting when Cloud Run succeeds", () => {
    // The COPY into RAW happens after the container exits, so a succeeded
    // execution says nothing about it. Completing it here would show a
    // Snowflake load that has not been attempted yet.
    const stages = deriveLiveScanStages(
      execution({ state: "succeeded", completionTime: "2026-08-18T10:14:18.000Z", succeededCount: 1, runningCount: 0 }),
      [line("CRAWL COMPLETE")],
    );
    expect(stateOf(stages, "handoff")).toBe("waiting");
  });

  it("completes the handoff only once the COPY is logged", () => {
    const stages = deriveLiveScanStages(
      execution({ state: "succeeded", completionTime: "2026-08-18T10:14:18.000Z", succeededCount: 1, runningCount: 0 }),
      [line("CRAWL COMPLETE"), line("COPY loaded 9 raw page(s) into Snowflake")],
    );
    expect(stages.every((stage) => stage.state === "complete")).toBe(true);
  });

  it("marks a failure at the stage the run died on", () => {
    const stages = deriveLiveScanStages(
      execution({ state: "failed", failureMessage: "container exceeded timeout" }),
      [line("Tor verified!")],
    );
    expect(stateOf(stages, "dispatch")).toBe("complete");
    expect(stateOf(stages, "tor")).toBe("error");
    expect(stages.find((s) => s.id === "tor")!.detail).toBe("container exceeded timeout");
  });

  it("reports a partial crawl rather than a total failure", () => {
    // A Cloud Run timeout after matched pages were written is still a failure,
    // but the pages exist. Saying "failed" flat would hide real extracted data.
    const stages = deriveLiveScanStages(
      execution({ state: "failed" }),
      [line("SAVED | depth=1")],
    );
    expect(stateOf(stages, "crawl")).toBe("error");
    expect(stages.find((s) => s.id === "crawl")!.detail).toMatch(/Some pages were saved/);
    expect(stateOf(stages, "handoff")).toBe("waiting");
  });

  it("completes a cancelled run that had already finalized its output", () => {
    const stages = deriveLiveScanStages(
      execution({ state: "cancelled" }),
      [line("SAVED | depth=1"), line("CRAWL COMPLETE"), line("Output: gs://bucket/x")],
    );
    expect(stateOf(stages, "stage")).toBe("complete");
  });

  it("falls back to a cancellation notice when nothing else explains the stop", () => {
    const stages = deriveLiveScanStages(execution({ state: "cancelled" }), []);
    expect(stages.find((s) => s.id === "dispatch")!.detail).toBe("Run cancelled.");
  });
});

describe("isLiveScanTerminal", () => {
  it("is false for no run and for one still going", () => {
    expect(isLiveScanTerminal(null)).toBe(false);
    expect(isLiveScanTerminal(execution({ state: "running" }))).toBe(false);
    expect(isLiveScanTerminal(execution({ state: "pending" }))).toBe(false);
  });

  it("is true for every finished state", () => {
    for (const state of ["succeeded", "failed", "cancelled"] as const) {
      expect(isLiveScanTerminal(execution({ state }))).toBe(true);
    }
  });
});

describe("formatDuration", () => {
  it("returns a dash when there is no start", () => {
    expect(formatDuration(null, null)).toBe("—");
  });

  it("returns a dash rather than a negative duration", () => {
    expect(formatDuration("2026-08-18T10:05:00Z", "2026-08-18T10:00:00Z")).toBe("—");
    expect(formatDuration("not-a-date", "2026-08-18T10:00:00Z")).toBe("—");
  });

  it("uses seconds, then minutes, then hours", () => {
    expect(formatDuration("2026-08-18T10:00:00Z", "2026-08-18T10:00:42Z")).toBe("42s");
    expect(formatDuration("2026-08-18T10:00:00Z", "2026-08-18T10:14:18Z")).toBe("14m 18s");
    expect(formatDuration("2026-08-18T10:00:00Z", "2026-08-18T12:07:00Z")).toBe("2h 07m");
  });

  it("zero-pads the trailing unit", () => {
    expect(formatDuration("2026-08-18T10:00:00Z", "2026-08-18T10:05:03Z")).toBe("5m 03s");
  });

  it("measures against now when there is no end", () => {
    expect(formatDuration(new Date().toISOString(), null)).toMatch(/^\d+s$/);
  });
});

/* ── the cascade rail ──────────────────────────────────────────────────────── */

describe("deriveLiveScanCascade", () => {
  const cascadeState = (
    stages: ReturnType<typeof deriveLiveScanCascade>,
    id: LiveScanCascadeStageId,
  ) => stages.find((stage) => stage.id === id)!;

  it("is idle with no counts at all", () => {
    expect(deriveLiveScanCascade(null)).toEqual(LIVE_SCAN_CASCADE_IDLE_STAGES);
    expect(LIVE_SCAN_CASCADE_STAGE_COUNT).toBe(5);
  });

  it("is idle when the handoff loaded nothing", () => {
    // Zero pages in RAW means the run is unresolved, not that the cascade ran
    // and found nothing. Reporting zeroes would claim a finding.
    expect(deriveLiveScanCascade(counts({ pagesRaw: 0 }))).toEqual(
      LIVE_SCAN_CASCADE_IDLE_STAGES,
    );
  });

  it("shows L0 running while pages are still being screened", () => {
    const stages = deriveLiveScanCascade(counts({ pagesRaw: 9, pagesL0: 4 }));
    expect(cascadeState(stages, "l0_signals").state).toBe("running");
    expect(cascadeState(stages, "l0_signals").count).toBe(4);
    expect(cascadeState(stages, "l0_signals").total).toBe(9);
    expect(cascadeState(stages, "l1_relevance").state).toBe("waiting");
  });

  it("hides a denominator a stage cannot know yet", () => {
    // A waiting stage rendering "0 / 0" reads as a settled finding.
    const stages = deriveLiveScanCascade(counts({ pagesRaw: 9, pagesL0: 4 }));
    expect(cascadeState(stages, "l2_evidence").total).toBeNull();
    expect(cascadeState(stages, "l4_insight").total).toBeNull();
  });

  it("advances to L1 once every page is screened", () => {
    const stages = deriveLiveScanCascade(
      counts({ pagesRaw: 9, pagesL0: 9, pagesL1: 5 }),
    );
    expect(cascadeState(stages, "l0_signals").state).toBe("complete");
    expect(cascadeState(stages, "l1_relevance").state).toBe("running");
    expect(cascadeState(stages, "l1_relevance").total).toBe(9);
  });

  it("measures L2 against the eligible pages, not against all of L1", () => {
    // Most pages legitimately stop at L1 because they are about another
    // company. Using pagesL1 as the denominator would show a permanent stall.
    const stages = deriveLiveScanCascade(
      counts({ pagesRaw: 9, pagesL0: 9, pagesL1: 9, pagesL1Eligible: 6, pagesL2: 6 }),
    );
    expect(cascadeState(stages, "l2_evidence").total).toBe(6);
    expect(cascadeState(stages, "l2_evidence").state).toBe("complete");
  });

  it("stops the rail when nothing survived the relevance screen", () => {
    const stages = deriveLiveScanCascade(
      counts({ pagesRaw: 9, pagesL0: 9, pagesL1: 9, pagesL1Eligible: 0 }),
    );
    expect(cascadeState(stages, "l1_relevance").state).toBe("complete");
    expect(cascadeState(stages, "l2_evidence").state).toBe("stopped");
    expect(cascadeState(stages, "l4_insight").state).toBe("stopped");
    expect(isLiveScanCascadeSettled(stages)).toBe(true);
  });

  it("narrows through L3 and L4 without inventing a ratio", () => {
    const stages = deriveLiveScanCascade(
      counts({
        pagesRaw: 9,
        pagesL0: 9,
        pagesL1: 9,
        pagesL1Eligible: 6,
        pagesL2: 6,
        pagesL3: 5,
        incidentsL4: 2,
        incidentsBriefed: 2,
      }),
    );
    expect(cascadeState(stages, "l3_graph").count).toBe(5);
    expect(cascadeState(stages, "l4_insight").count).toBe(2);
    expect(cascadeState(stages, "l4_insight").state).toBe("complete");
  });

  it("surfaces confirmed pages still waiting on severity scoring", () => {
    // The real finding from run nocturne-crawler-x8svq: five confirmed pages
    // routed, no incidents, because the L4 AI tasks are suspended.
    const stages = deriveLiveScanCascade(
      counts({
        pagesRaw: 9,
        pagesL0: 9,
        pagesL1: 9,
        pagesL1Eligible: 6,
        pagesL2: 6,
        pagesL3: 5,
        incidentsL4: 0,
      }),
    );
    expect(cascadeState(stages, "l3_graph").state).toBe("complete");
    expect(cascadeState(stages, "l4_insight").state).toBe("running");
    expect(isLiveScanCascadeSettled(stages)).toBe(false);
  });

  it("keeps L4 running while briefs are still being written", () => {
    const stages = deriveLiveScanCascade(
      counts({
        pagesRaw: 3,
        pagesL0: 3,
        pagesL1: 3,
        pagesL1Eligible: 3,
        pagesL2: 3,
        pagesL3: 3,
        incidentsL4: 2,
        incidentsBriefed: 1,
      }),
    );
    expect(cascadeState(stages, "l4_insight").detail).toBeTruthy();
    expect(isLiveScanCascadeSettled(stages)).toBe(false);
  });

  it("handles a single-page run", () => {
    const stages = deriveLiveScanCascade(
      counts({
        pagesRaw: 1,
        pagesL0: 1,
        pagesL1: 1,
        pagesL1Eligible: 1,
        pagesL2: 1,
        pagesL3: 1,
        incidentsL4: 1,
        incidentsBriefed: 1,
      }),
    );
    expect(stages.every((stage) => stage.state === "complete")).toBe(true);
    expect(isLiveScanCascadeSettled(stages)).toBe(true);
  });
});

describe("isLiveScanCascadeSettled", () => {
  it("is false when there is nothing to judge", () => {
    expect(isLiveScanCascadeSettled(undefined)).toBe(false);
    expect(isLiveScanCascadeSettled(LIVE_SCAN_CASCADE_IDLE_STAGES)).toBe(false);
  });
});

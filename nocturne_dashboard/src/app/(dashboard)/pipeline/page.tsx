"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, Button, Stack, Typography, alpha } from "@mui/material";
import { RefreshCw } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Panel } from "@/components/ui/Panel";
import { DonutChart } from "@/components/ui/DonutChart";
import { Cascade } from "@/components/ui/Cascade";
import { BarListSkeleton, StatGridSkeleton } from "@/components/ui/Skeletons";
import {
  DataGapNote,
  PageHeader,
  StatCard,
  StatGrid,
  Tag,
} from "@/components/ui/Primitives";
import { colors, fonts, layout as layoutTokens, severityColor } from "@/theme/tokens";
import { relativeTime } from "@/lib/format";
import type { PipelineResponse } from "@/types/dashboard";

const configuredRefreshMs = Number(
  process.env.NEXT_PUBLIC_DASHBOARD_REFRESH_MS ?? "300000",
);
const refreshIntervalMs =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs >= 30_000
    ? configuredRefreshMs
    : 300_000;

/**
 * The three sidebar links under Pipeline are three different questions for three
 * different readers — what did the cascade cost, is the evidence trustworthy,
 * and is the machinery healthy. They share one dataset, so they are tabs on one
 * route rather than three routes each refetching the same thing.
 */
type PipelineTab = "cascade" | "quality" | "health";

const TABS: ReadonlyArray<readonly [PipelineTab, string]> = [
  ["cascade", "Detection Cascade"],
  ["quality", "Evidence Quality"],
  ["health", "Processing Health"],
];

const TAB_SUBTITLE: Record<PipelineTab, string> = {
  cascade: "How many pages survived each stage, and which three stages cost money.",
  quality: "What failed verbatim verification and never reached the graph.",
  health: "Task state, version drift, and per-tenant ingest health.",
};

function isPipelineTab(value: string | null): value is PipelineTab {
  return value === "cascade" || value === "quality" || value === "health";
}

export default function PipelinePage() {
  const { session, isLoading: isAuthLoading, isFleetScope } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [tab, setTab] = useState<PipelineTab>("cascade");
  const [data, setData] = useState<PipelineResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal, background = false) => {
    if (!session) return;
    if (background) setIsRefreshing(true);
    const query = new URLSearchParams();
    if (session.user.role === "SUPER_ADMIN" && session.scope.kind === "org") {
      query.set("orgId", session.scope.orgId);
    }
    const url = query.size ? `/api/pipeline?${query.toString()}` : "/api/pipeline";

    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const body = (await response.json()) as PipelineResponse | { error?: string };
      if (!response.ok || !("cascade" in body) || !("cacheSummary" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Unable to load live pipeline data.",
        );
      }
      setData(body);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load live pipeline data.",
      );
    } finally {
      if (background) setIsRefreshing(false);
    }
  }, [session]);

  // Statically prerendered, so `useSearchParams()` is empty on first render and
  // a useState initializer would pin the tab forever. Sync after hydration so
  // the sidebar's deep links actually land.
  useEffect(() => {
    const next = params.get("tab");
    setTab(isPipelineTab(next) ? next : "cascade");
  }, [params]);

  // Keep the URL authoritative so a tab can be linked, bookmarked and shared.
  const selectTab = useCallback(
    (next: PipelineTab) => {
      setTab(next);
      router.replace(next === "cascade" ? "/pipeline" : `/pipeline?tab=${next}`, {
        scroll: false,
      });
    },
    [router],
  );

  useEffect(() => {
    if (isAuthLoading) return;
    if (!session) {
      setData(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setData(null);
    setError(null);
    setIsLoading(true);
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void load(controller.signal, true);
      }
    };
    const interval = window.setInterval(refreshWhenVisible, refreshIntervalMs);
    window.addEventListener("focus", refreshWhenVisible);

    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [isAuthLoading, load, session]);

  const visibleData = data && session && (
    data.scope.kind === session.scope.kind
    && (
      data.scope.kind === "fleet"
      || (
        session.scope.kind === "org"
        && data.scope.orgId === session.scope.orgId
      )
    )
  ) ? data : null;

  const stats = visibleData?.grounding ?? {
    rate: 0,
    exactCount: 0,
    normalizedCount: 0,
    verifiedCount: 0,
    quarantinedCount: 0,
    totalExtractedClaims: 0,
  };
  const cascade = visibleData?.cascade ?? [];
  const health = visibleData?.health ?? [];
  const versionDriftRows = visibleData?.versionDrift ?? [];
  const taskRows = visibleData?.tasks ?? [];
  const relativeNow = visibleData ? Date.parse(visibleData.fetchedAt) : Date.now();
  const driftRowsBehind = versionDriftRows.reduce(
    (total, row) => total + row.rowsBehind,
    0,
  );
  const rejectedGraphElementCount = visibleData?.rejectionReasons.reduce(
    (total, reason) => total + reason.count,
    0,
  ) ?? 0;
  const scheduledTaskCount = taskRows.filter((task) => task.trigger === "schedule").length;
  const streamTaskCount = taskRows.filter((task) => task.trigger === "stream").length;
  const headerRight = (
    <Stack direction="row" gap={1} alignItems="center">
      {visibleData && (
        <Typography sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.text3 }}>
          LIVE SNOWFLAKE · {new Date(visibleData.fetchedAt).toLocaleString()}
        </Typography>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<RefreshCw size={13} />}
        disabled={!session || isLoading || isRefreshing}
        onClick={() => void load(undefined, true)}
      >
        {isRefreshing ? "Refreshing" : "Refresh"}
      </Button>
    </Stack>
  );

  if (isAuthLoading || isLoading) {
    return (
      <Stack gap={2}>
        <PageHeader title="Pipeline" subtitle={TAB_SUBTITLE[tab]} right={headerRight} />
        <StatGridSkeleton cards={4} />
        <Panel title="Detection Cascade">
          <BarListSkeleton rows={9} />
        </Panel>
      </Stack>
    );
  }

  if (!visibleData) {
    return (
      <Stack gap={2}>
        <PageHeader title="Pipeline" subtitle={TAB_SUBTITLE[tab]} right={headerRight} />
        <Panel>
          <Stack alignItems="center" gap={1.5} sx={{ py: 8 }}>
            <Typography sx={{ color: colors.text1 }}>
              Live pipeline data is unavailable.
            </Typography>
            {error && (
              <Typography sx={{ color: colors.critical, fontSize: 12 }}>{error}</Typography>
            )}
          </Stack>
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
      <PageHeader title="Pipeline" subtitle={TAB_SUBTITLE[tab]} right={headerRight} />

      {error && (
        <Box
          sx={{
            border: `1px solid ${alpha(colors.critical, 0.35)}`,
            backgroundColor: alpha(colors.critical, 0.06),
            borderRadius: "6px",
            px: 1.5,
            py: 1,
            color: colors.text2,
            fontSize: 11.5,
          }}
        >
          Refresh failed: {error}. Displaying the last successful response.
        </Box>
      )}

      <Stack direction="row" gap={1} flexWrap="wrap" role="tablist" aria-label="Pipeline views">
        {TABS.map(([key, label]) => (
          <Box
            key={key}
            component="button"
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => selectTab(key)}
            sx={{
              px: 1.4,
              py: 0.6,
              cursor: "pointer",
              font: "inherit",
              fontSize: 11.5,
              borderRadius: `${layoutTokens.radiusSm}px`,
              color: tab === key ? colors.ion : colors.text2,
              border: `1px solid ${tab === key ? alpha(colors.ion, 0.38) : colors.edge}`,
              backgroundColor: tab === key ? alpha(colors.ion, 0.1) : "transparent",
              "&:hover": { color: colors.text1 },
              "&:focus-visible": { outline: `2px solid ${alpha(colors.ion, 0.7)}`, outlineOffset: 2 },
            }}
          >
            {label}
          </Box>
        ))}
      </Stack>

      <StatGrid>
        <StatCard
          label="Evidence claims verified"
          value={`${stats.rate}%`}
          sub={`${stats.verifiedCount.toLocaleString()} accepted claims · ${stats.quarantinedCount} quarantined claims`}
          accent={colors.verified}
          valueColor={colors.verified}
        />
        <StatCard
          label="Sent to expensive analysis"
          value={`${visibleData.deepAnalysisRate}%`}
          sub={`${(cascade.find((s) => s.id === "extracted")?.count ?? 0).toLocaleString()} of ${(cascade.find((s) => s.id === "relevance")?.count ?? 0).toLocaleString()} pages`}
          accent={severityColor.critical}
        />
        <StatCard
          label="Cached AI results"
          value={visibleData.cacheSummary.repeatCallsAvoided.toLocaleString()}
          sub={`${visibleData.cacheSummary.missingCandidates.toLocaleString()} candidates pending`}
          accent={colors.ion}
          valueColor={colors.ion}
        />
        <StatCard
          label="Stored AI errors"
          value={visibleData.cacheSummary.errorRows.toLocaleString()}
          sub="cached and not retried automatically"
          accent={severityColor.medium}
        />
      </StatGrid>

      {tab === "cascade" && (
        <Panel
          title="Detection Cascade"
          meta="RED = BILLED STAGE"
          sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          <Cascade stages={cascade} fill />
        </Panel>
      )}

      {tab === "quality" && (
      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", lg: "1.4fr 1fr" },
          flex: 1,
          minHeight: 0,
        }}
      >
        <Panel
          title="Rejected Graph Elements"
          meta="WHY THEY WERE REJECTED"
          sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          <Box
            sx={{
              flex: 1,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
            }}
          >
            <DonutChart
              // The panel stretches to the viewport, so the donut is sized to
              // hold that space rather than float in the middle of it — the
              // same reason the cascade opts into `fill`.
              size={240}
              totalLabel="REJECTED"
              data={visibleData.rejectionReasons.map((r) => ({
                key: r.reason,
                label: (
                  <>
                    <Box
                      component="span"
                      sx={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.label}
                    </Box>
                    {r.reason === "unmatched_evidence" && (
                      <Tag tone="critical">hallucination</Tag>
                    )}
                  </>
                ),
                value: r.count,
                color:
                  r.severity === "critical"
                    ? severityColor.critical
                    : r.severity === "high"
                      ? severityColor.high
                      : r.severity === "medium"
                        ? severityColor.medium
                        : severityColor.low,
              }))}
            />
          </Box>
          <Box
            sx={{
              mt: 2,
              pt: 1.6,
              borderTop: `1px solid ${colors.edge}`,
              flexShrink: 0,
              fontSize: 11.5,
              color: colors.text2,
              lineHeight: 1.65,
            }}
          >
            <b style={{ color: colors.text1 }}>
              {rejectedGraphElementCount.toLocaleString()} rejected graph elements
            </b>{" "}
            were stopped before graph promotion. Separately,{" "}
            <b style={{ color: colors.text1 }}>
              {stats.verifiedCount.toLocaleString()} of {stats.totalExtractedClaims.toLocaleString()}
            </b>{" "}
            extracted claims were accepted as grounded evidence. Rejected elements do not appear in
            severity scores.
          </Box>
        </Panel>

        <Panel title="Accuracy metrics">
          <DataGapNote>
            <b>Precision, recall and calibration are deliberately absent.</b> They need a labelled
            gold set — roughly 40 hand-reviewed pages — which does not exist yet. Showing an
            invented accuracy figure would be worse than showing none. Build the gold set and this
            panel fills itself in.
          </DataGapNote>
        </Panel>
      </Box>
      )}

      {tab === "health" && (
      <>
      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" } }}>
        <Panel title="Version drift" meta="BASELINE VS CURRENT">
          <Box sx={{ overflowX: "auto" }}>
            <Table headers={["Stage", "Baseline", "Current", "Rows behind"]}>
              {versionDriftRows.map((d) => (
                <Box component="tr" key={d.stage}>
                  <Td>{d.stage}</Td>
                  <Td>
                    <Mono size={10.5} color={colors.text3}>
                      {d.baselineVersion ?? "—"}
                    </Mono>
                  </Td>
                  <Td>
                    <Mono size={10.5} color={d.rowsBehind ? severityColor.medium : colors.verified}>
                      {d.currentVersion}
                    </Mono>
                  </Td>
                  <Td>
                    <Mono color={d.rowsBehind ? severityColor.medium : colors.text1}>
                      {d.rowsBehind}
                    </Mono>
                  </Td>
                </Box>
              ))}
            </Table>
          </Box>
          <Box sx={{ mt: 1.8 }}>
            <DataGapNote>
              <b>{driftRowsBehind} rows</b> carry an older method version and are not directly
              comparable to today&apos;s ranking until they are intentionally recomputed.
            </DataGapNote>
          </Box>
        </Panel>

        <Panel title="Processing health" meta={isFleetScope ? "PER TENANT" : "THIS ORGANIZATION"}>
          <Box sx={{ overflowX: "auto" }}>
            <Table
              headers={[
                ...(isFleetScope ? ["Tenant"] : []),
                "Last ingest",
                "Verified",
                "Quarantined",
                "Errors",
                "Status",
              ]}
            >
              {health.map((h) => (
                <Box
                  component="tr"
                  key={h.orgId ?? "org"}
                  sx={{
                    background:
                      h.status !== "healthy"
                        ? `linear-gradient(90deg, ${alpha(severityColor.medium, 0.08)}, transparent 42%)`
                        : "none",
                  }}
                >
                  {isFleetScope && <Td>{h.organizationName}</Td>}
                  <Td>
                    <Mono color={h.status === "healthy" ? colors.text2 : severityColor.medium}>
                      {h.lastIngestAt ? relativeTime(h.lastIngestAt, relativeNow) : "never"}
                    </Mono>
                  </Td>
                  <Td>
                    <Mono color={h.groundingRate >= 92 ? colors.verified : severityColor.medium}>
                      {h.groundingRate}%
                    </Mono>
                  </Td>
                  <Td><Mono>{h.quarantinedCount}</Mono></Td>
                  <Td>
                    <Mono color={h.aiErrorCount ? severityColor.medium : colors.text1}>
                      {h.aiErrorCount}
                    </Mono>
                  </Td>
                  <Td>
                    <Tag tone={h.status === "healthy" ? "ok" : "medium"}>
                      {h.status === "healthy"
                        ? "Healthy"
                        : h.status === "degraded"
                          ? "Degraded"
                          : "Ingest Lagging"}
                    </Tag>
                  </Td>
                </Box>
              ))}
            </Table>
          </Box>
        </Panel>
      </Box>

      <Panel title="Task health" meta={`${scheduledTaskCount} SCHEDULED · ${streamTaskCount} STREAM-TRIGGERED`}>
        <Box sx={{ overflowX: "auto" }}>
          <Table headers={["Task", "Trigger", "State", "Last run", "Pending", "Errors"]}>
            {taskRows.map((t) => (
              <Box component="tr" key={t.taskName}>
                <Td>
                  <Mono size={11}>{t.taskName}</Mono>
                </Td>
                <Td>
                  <Tag tone={t.trigger === "stream" ? "ion" : "neutral"}>
                    {t.trigger === "stream" ? "stream" : `${t.scheduleLabel} schedule`}
                  </Tag>
                </Td>
                <Td>
                  <Tag tone={t.state === "queued" ? "medium" : "ok"}>
                    {t.state[0]!.toUpperCase() + t.state.slice(1)}
                  </Tag>
                </Td>
                <Td>
                  <Mono color={colors.text2}>
                    {t.lastRunAt ? relativeTime(t.lastRunAt, relativeNow) : "never"}
                  </Mono>
                </Td>
                <Td>
                  <Mono color={t.pendingCandidates ? severityColor.medium : colors.text1}>
                    {t.pendingCandidates ?? "—"}
                  </Mono>
                </Td>
                <Td>
                  <Mono color={t.errorCount ? severityColor.medium : colors.text1}>
                    {t.errorCount}
                  </Mono>
                </Td>
              </Box>
            ))}
          </Table>
        </Box>
        <Typography sx={{ mt: 1.5, fontSize: 11, color: colors.text3, lineHeight: 1.6 }}>
          Stream-triggered tasks run only when new work exists. A waiting task holds no warehouse,
          so an idle pipeline costs nothing.
        </Typography>
      </Panel>
      </>
      )}
    </Stack>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", minWidth: 480 }}>
      <Box component="thead">
        <Box component="tr">
          {headers.map((h) => (
            <Box
              key={h}
              component="th"
              sx={{
                textAlign: "left",
                fontFamily: fonts.mono,
                fontSize: 9.5,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: colors.text3,
                fontWeight: 500,
                p: 1.2,
                borderBottom: `1px solid ${colors.edge}`,
                whiteSpace: "nowrap",
              }}
            >
              {h}
            </Box>
          ))}
        </Box>
      </Box>
      <Box component="tbody">{children}</Box>
    </Box>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="td"
      sx={{
        p: 1.2,
        borderBottom: "1px solid rgba(122,164,255,0.07)",
        fontSize: 11.5,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </Box>
  );
}

function Mono({
  children,
  color,
  size = 12,
}: {
  children: React.ReactNode;
  color?: string;
  size?: number;
}) {
  return (
    <Box component="span" sx={{ fontFamily: fonts.mono, fontSize: size, color: color ?? colors.text1 }}>
      {children}
    </Box>
  );
}

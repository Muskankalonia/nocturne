"use client";

import { useCallback, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import { Box, Button, Stack, Typography, alpha } from "@mui/material";
import { useAuth } from "@/contexts/AuthContext";
import { usePosture } from "@/contexts/PostureContext";
import { Panel } from "@/components/ui/Panel";
import { Cascade } from "@/components/ui/Cascade";
import { PostureFlow } from "@/components/ui/PostureFlow";
import {
  BarListSkeleton,
  CanvasSkeleton,
  StatGridSkeleton,
  TableSkeleton,
} from "@/components/ui/Skeletons";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { colors, fonts, severityColor , layout as layoutTokens} from "@/theme/tokens";
import { hostOf } from "@/lib/format";

export default function CommandCenterPage() {
  const router = useRouter();
  const { isFleetScope, activeOrg, switchableOrgs, isSuperAdmin } = useAuth();
  // The fetch, the scope guard and the auto-refresh live in PostureContext so
  // the sidebar badge and the tenant switcher read the same numbers this page
  // renders, off one query rather than three.
  const {
    data: visibleData,
    isLoading,
    isRefreshing,
    error,
    refresh,
  } = usePosture();

  // Manual pipeline kick. Available at every scope a fleet admin can reach,
  // including a single tenant — the run itself is account-wide, so the button
  // means the same thing wherever it is pressed.
  const [runState, setRunState] = useState({
    busy: false,
    message: null as string | null,
    error: false,
  });

  /**
   * Hand off to the live scan page rather than starting anything here.
   *
   * This button used to POST /api/pipeline/run, which executes the Snowflake
   * ingest task — it loads GCS batches that a crawl already produced, and does
   * nothing at all when there is no new batch waiting. Pressed in front of an
   * audience expecting a dark-web scan, it looked like a no-op.
   *
   * The real scan is the crawler job, and watching it is the whole point, so
   * the button now goes where the log stream and the stage rail are and starts
   * the run there. `autostart` is consumed and stripped from the URL on arrival
   * so that a later reload of that page does not launch a second crawl.
   */
  const runPipeline = useCallback(() => {
    setRunState({ busy: true, message: "Opening live leak scan…", error: false });
    router.push("/pipeline/live-scan?autostart=1");
  }, [router]);

  const scored = visibleData?.incidents.filter(
    (incident) => incident.triagePriorityScore !== null,
  ) ?? [];
  const cascade = visibleData?.cascade ?? [];

  const queue = useMemo(
    () => [...scored].sort(
      (a, b) => (b.triagePriorityScore ?? 0) - (a.triagePriorityScore ?? 0),
    ),
    [scored],
  );

  // Every incident in the visible scope. Kept as a hook above the loading gate
  // below — a `useMemo` after a conditional return breaks the rules of hooks.
  const incidentsInScope = useMemo(
    () => visibleData?.incidents ?? [],
    [visibleData],
  );

  // The onion hosts this scope actually saw, ranked by how much they produced.
  const sourceRank = useMemo(() => {
    const counts = new Map<string, number>();
    for (const incident of incidentsInScope) {
      const host = hostOf(incident.topUrl);
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [incidentsInScope]);

  const organizationName = isFleetScope
    ? "Fleet"
    : visibleData?.organizations[0]?.organizationName
      ?? activeOrg?.canonicalName
      ?? "Organization";

  // Loading and failure are different states and must not share a placeholder.
  // While the fetch is in flight the page shape is already known, so keep the
  // real heading and skeleton only the boxes that are waiting on Snowflake.
  if (!visibleData && isLoading) {
    return (
      <Stack gap={2} sx={{ minHeight: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)`, pb: 1 }}>
        <PageHeading
          title={`${organizationName} posture`}
          subtitle={
            isFleetScope
              ? `Aggregated across ${switchableOrgs.length} organizations.`
              : "What of yours was exposed, how badly, and what to do about it."
          }
        />
        <StatGridSkeleton cards={4} />
        <Panel padded={false}>
          <CanvasSkeleton height={300} />
        </Panel>
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" } }}>
          <Panel title="Detection cascade">
            <BarListSkeleton rows={9} />
          </Panel>
          <Panel title="Incidents by band">
            <BarListSkeleton rows={5} />
          </Panel>
        </Box>
        <Panel title="Priority queue — ranked by triage score">
          <TableSkeleton rows={6} columns={6} />
        </Panel>
      </Stack>
    );
  }

  if (!visibleData) {
    return (
      <Stack gap={2}>
        <PageHeading
          title={`${organizationName} posture`}
          subtitle={
            isFleetScope
              ? `Aggregated across ${switchableOrgs.length} organizations.`
              : "What of yours was exposed, how badly, and what to do about it."
          }
        />
        <Panel>
          <Stack alignItems="center" gap={1.5} sx={{ py: 6 }}>
            <Typography sx={{ color: colors.text1 }}>Live posture unavailable</Typography>
            {error && (
              <Typography sx={{ color: colors.critical, fontSize: 12 }}>
                {error}
              </Typography>
            )}
            <Button size="small" onClick={refresh}>
              Retry
            </Button>
          </Stack>
        </Panel>
      </Stack>
    );
  }

  const metrics = visibleData.totals;
  const stats = metrics.grounding;
  const topImpact = metrics.topImpactSeverityScore;
  const topImpactBand = metrics.topImpactSeverityBand;
  const criticals = metrics.incidentsByBand.critical;
  const stageCount = (id: string) => cascade.find((stage) => stage.id === id)?.count ?? 0;
  const extractedCount = stageCount("extracted");
  const relevanceCount = stageCount("relevance");

  /* ── hero flow inputs ────────────────────────────────────────────────────── */

  const maxSource = sourceRank[0]?.[1] ?? 1;
  const flowSources = sourceRank.slice(0, 7).map(([label, count]) => ({
    label,
    weight: count / maxSource,
  }));

  // The hero's arithmetic has to close: the incidents node is the population,
  // and every downstream branch is a partition of it. Pipeline volumes on the
  // left are last-24h throughput; these are the incidents actually in scope.
  const confirmedIncidents = incidentsInScope.filter(
    (incident) => incident.route === "target_confirmed",
  );
  const confirmed = confirmedIncidents.length;
  const unconfirmed = incidentsInScope.length - confirmed;
  const openConfirmed = confirmedIncidents.filter(
    (incident) =>
      incident.remediationStatus !== "resolved" &&
      incident.remediationStatus !== "contained",
  );
  const openNow = openConfirmed.length;
  const resolved = confirmed - openNow;

  // Derived from the same rows as `openNow` rather than from the server's
  // aggregate, so the chips always sum to the number they sit beside.
  const flowBands = (["critical", "high", "medium", "low", "informational"] as const).map(
    (band) => ({
      band,
      count: openConfirmed.filter((incident) => incident.impactSeverityBand === band).length,
    }),
  );

  return (
    <Stack gap={2}>
      <PageHeading
        title={`${organizationName} posture`}
        subtitle={
          isFleetScope
            ? `Aggregated across ${visibleData.organizations.length} organizations.`
            : "What of yours was exposed, how badly, and what to do about it."
        }
        lastUpdatedAt={visibleData.lastUpdatedAt}
        isRefreshing={isRefreshing}
        onRefresh={refresh}
        onRunPipeline={isSuperAdmin ? runPipeline : undefined}
        runState={runState}
      />

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

      {/* hero — the whole pipeline as one left-to-right statement */}
      <Panel padded={false}>
        <Box sx={{ px: { xs: 1.5, md: 2.5 }, pt: 2.5, pb: 1 }}>
          <PostureFlow
            sources={flowSources}
            extraSourceCount={Math.max(0, sourceRank.length - flowSources.length)}
            collected={stageCount("collected")}
            relevant={stageCount("relevance")}
            deepAnalysis={stageCount("extracted")}
            incidents={incidentsInScope.length}
            confirmed={confirmed}
            needsReview={unconfirmed}
            resolved={resolved}
            open={openNow}
            bands={flowBands}
            groundingRate={stats.rate}
          />
        </Box>
      </Panel>

      {/* KPI row */}
      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", sm: "repeat(2,1fr)", lg: "repeat(4,1fr)" },
        }}
      >
        {isFleetScope ? (
          <Kpi
            label="Tenants monitored"
            value={String(visibleData.organizations.length)}
            sub="enabled in Snowflake"
            accent={colors.ion}
          />
        ) : (
          <Kpi
            label="Top impact severity"
            value={topImpact === null ? "—" : String(topImpact)}
            sub={<SeverityChip band={topImpactBand} />}
            accent={severityColor[topImpactBand ?? "informational"]}
            valueColor={
              topImpactBand ? severityColor[topImpactBand] : colors.text1
            }
          />
        )}
        <Kpi
          label={isFleetScope ? "Critical · fleet" : "Open incidents"}
          value={String(isFleetScope ? criticals : metrics.openIncidentCount)}
          sub={
            isFleetScope ? (
              `of ${metrics.openIncidentCount} open`
            ) : (
              <span style={{ color: severityColor.critical }}>{criticals} critical</span>
            )
          }
          accent={severityColor.high}
          valueColor={isFleetScope ? severityColor.critical : undefined}
        />
        <Kpi
          label="Evidence grounding rate"
          value={`${stats.rate}%`}
          sub={`${stats.verifiedCount.toLocaleString()} grounded claims · ${stats.quarantinedCount.toLocaleString()} ungrounded claims`}
          accent={colors.verified}
          valueColor={colors.verified}
        />
        <Kpi
          label="Distinct threat actors"
          value={String(metrics.distinctThreatActorCount)}
          sub="identified in confirmed incidents"
          accent={colors.ion}
        />
      </Box>

      {/* cascade + severity split */}
      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" },
        }}
      >
        <Panel
          // "last 24h" was never true: every count in VW_COMMAND_CENTER is a
          // lifetime aggregate with no time predicate, so the panel was
          // labelling cumulative totals as a rolling day. Windowing it needs a
          // date filter in the view — see prod_requirement.md — so until that
          // lands the label states what the numbers actually are.
          title={isFleetScope ? "Fleet cascade — all tenants" : "Detection cascade — cumulative"}
          meta="RED = BILLED (AI) STAGE"
        >
          <Cascade stages={cascade} />
          <Box
            sx={{
              mt: 1.6,
              px: 1.5,
              py: 1.1,
              border: `1px dashed ${alpha(colors.critical, 0.32)}`,
              borderRadius: "7px",
              backgroundColor: alpha(colors.critical, 0.05),
              fontSize: 11.5,
              color: colors.text2,
              lineHeight: 1.6,
            }}
          >
            Expensive extraction ran on{" "}
            <Box component="b" sx={{ color: colors.critical, fontFamily: fonts.mono }}>
              {extractedCount.toLocaleString()} / {relevanceCount.toLocaleString()}
            </Box>{" "}
            pages. A send-everything baseline would have run the expensive model on all of them.
          </Box>
        </Panel>

        <Panel title="Incidents by band">
          <Stack gap={1.4}>
            {(["critical", "high", "medium", "low", "informational"] as const).map((band) => {
              const n = metrics.incidentsByBand[band];
              const pct = metrics.openIncidentCount
                ? (n / metrics.openIncidentCount) * 100
                : 0;
              return (
                <Box key={band}>
                  <Stack direction="row" alignItems="center" gap={1}>
                    <SeverityChip band={band} compact />
                    <Typography
                      sx={{
                        ml: "auto",
                        fontFamily: fonts.mono,
                        fontSize: 12,
                        color: n ? colors.text1 : colors.text3,
                      }}
                    >
                      {n}
                    </Typography>
                  </Stack>
                  <Box
                    sx={{
                      mt: 0.7,
                      height: 5,
                      borderRadius: "3px",
                      backgroundColor: "rgba(255,255,255,0.05)",
                      overflow: "hidden",
                    }}
                  >
                    <Box
                      sx={{
                        height: "100%",
                        width: `${pct}%`,
                        backgroundColor: severityColor[band],
                        borderRadius: "3px",
                      }}
                    />
                  </Box>
                </Box>
              );
            })}
          </Stack>
        </Panel>
      </Box>

      {/* priority queue */}
      <Panel
        title="Priority queue — ranked by triage score"
        meta={`LAST UPDATED ${formatTimestamp(visibleData.lastUpdatedAt)}`}
      >
        <Box sx={{ overflowX: "auto" }}>
          <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <Box component="thead">
              <Box component="tr">
                {[
                  ...(isFleetScope ? ["Organization"] : []),
                  "Incident",
                  "Actor",
                  "Data types",
                  "Impact",
                  "Confidence",
                  "Triage",
                ].map((h) => (
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
            <Box component="tbody">
              {queue.length === 0 && (
                <Box component="tr">
                  <Box
                    component="td"
                    colSpan={isFleetScope ? 7 : 6}
                    sx={{ py: 4, textAlign: "center", color: colors.text3 }}
                  >
                    No confirmed target incidents are available for this scope.
                  </Box>
                </Box>
              )}
              {queue.map((row) => (
                /* Every row here comes from VW_INCIDENTS, which is the same
                 * view `/api/incidents/[key]` reads, so a detail page exists
                 * for all of them — no `detailAvailable` gate is needed as it
                 * is on the breach monitor, whose rows include pages that never
                 * became incidents. The anchor in the first cell carries the
                 * keyboard and open-in-new-tab affordances; the row handler is
                 * a convenience for pointer users and stands down whenever the
                 * click already landed on a link.
                 *
                 * This landed twice, independently. The other implementation
                 * put role="link" + tabIndex + onKeyDown on the <tr> itself;
                 * that reads as a link to a screen reader but costs the row and
                 * cell semantics of the table, and gives up ⌘-click, middle
                 * click and the status-bar href that a real anchor provides for
                 * free. Its aria-label and ion-tinted hover were better than
                 * mine and are kept below. */
                <Box
                  component="tr"
                  key={row.incidentKey}
                  onClick={(event: React.MouseEvent<HTMLTableRowElement>) => {
                    if ((event.target as HTMLElement).closest("a")) return;
                    router.push(`/leaks/${encodeURIComponent(row.incidentKey)}`);
                  }}
                  sx={{
                    cursor: "pointer",
                    background:
                      row.impactSeverityBand === "critical"
                        ? `linear-gradient(90deg, ${alpha(colors.critical, 0.09)}, transparent 42%)`
                        : "none",
                    transition: "background-color 120ms ease",
                    "&:hover": { backgroundColor: alpha(colors.ion, 0.055) },
                    // The anchor lives in the first cell; light the whole row
                    // when it takes focus so keyboard and pointer agree on what
                    // is selected.
                    "&:has(a:focus-visible)": {
                      backgroundColor: alpha(colors.ion, 0.055),
                    },
                    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
                  }}
                >
                  {isFleetScope && (
                    <Td stripe={row.impactSeverityBand}>
                      <b>{row.organizationName}</b>
                    </Td>
                  )}
                  <Td stripe={isFleetScope ? null : row.impactSeverityBand}>
                    <Stack>
                      {row.insight.status === "success" && row.insight.headline && (
                        <Box
                          sx={{
                            color: colors.verified,
                            fontFamily: fonts.mono,
                            fontSize: 8.5,
                            letterSpacing: "0.1em",
                            textTransform: "uppercase",
                          }}
                        >
                          AI insight
                        </Box>
                      )}
                      <Box
                        component={NextLink}
                        href={`/leaks/${encodeURIComponent(row.incidentKey)}`}
                        aria-label={`Open incident ${row.insight.headline ?? row.topTitle}`}
                        sx={{
                          fontWeight: 600,
                          fontSize: 12.5,
                          color: "inherit",
                          textDecoration: "none",
                          "&:hover": { color: colors.ionBright },
                          "&:focus-visible": {
                            outline: `2px solid ${alpha(colors.ion, 0.7)}`,
                            outlineOffset: 2,
                            borderRadius: "3px",
                          },
                        }}
                      >
                        {row.insight.headline ?? row.topTitle}
                      </Box>
                      {row.insight.headline && row.insight.headline !== row.topTitle && (
                        <Box sx={{ color: colors.text2, fontSize: 10.5 }}>
                          {row.topTitle}
                        </Box>
                      )}
                      <Box sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 10.5 }}>
                        {hostname(row.topUrl)}
                      </Box>
                    </Stack>
                  </Td>
                  <Td>
                    <Box sx={{ fontFamily: fonts.mono, color: row.actorName ? colors.ion : colors.text3 }}>
                      {row.actorName ?? "unattributed"}
                    </Box>
                  </Td>
                  <Td>
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      {row.leakTypes.slice(0, 2).map((t) => (
                        <Box
                          key={t}
                          component="span"
                          sx={{
                            fontFamily: fonts.mono,
                            fontSize: 10,
                            px: 0.8,
                            py: 0.2,
                            borderRadius: "4px",
                            border: `1px solid ${colors.edge}`,
                            color: colors.text2,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {t}
                        </Box>
                      ))}
                      {row.leakTypes.length > 2 && (
                        <Box component="span" sx={{ fontFamily: fonts.mono, fontSize: 10, color: colors.text3 }}>
                          +{row.leakTypes.length - 2}
                        </Box>
                      )}
                    </Stack>
                  </Td>
                  <Td>
                    <Box sx={{ fontFamily: fonts.mono, color: severityColor.critical }}>
                      {row.impactSeverityScore}
                    </Box>
                  </Td>
                  <Td>
                    <Box sx={{ fontFamily: fonts.mono, color: colors.verified }}>
                      {row.evidenceConfidenceScore}
                    </Box>
                  </Td>
                  <Td>
                    <SeverityChip
                      band={row.triagePriorityBand}
                      score={row.triagePriorityScore}
                    />
                  </Td>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
      </Panel>
    </Stack>
  );
}

function PageHeading({
  title,
  subtitle,
  lastUpdatedAt,
  isRefreshing = false,
  onRefresh,
  onRunPipeline,
  runState,
}: {
  title: string;
  subtitle: string;
  lastUpdatedAt?: string | null;
  isRefreshing?: boolean;
  onRefresh?: () => void;
  onRunPipeline?: () => void;
  runState?: { busy: boolean; message: string | null; error: boolean };
}) {
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      alignItems={{ xs: "flex-start", sm: "center" }}
      justifyContent="space-between"
      gap={1.5}
    >
      <Box>
        <Typography variant="h2">{title}</Typography>
        <Typography sx={{ color: colors.text2, fontSize: 13, mt: 0.3 }}>
          {subtitle}
        </Typography>
      </Box>
      {onRefresh && (
        <Stack alignItems={{ xs: "flex-start", sm: "flex-end" }} gap={0.8}>
          <Typography
            sx={{
              color: colors.verified,
              fontFamily: fonts.mono,
              fontSize: 9.5,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            {runState?.message
              ? runState.message
              : isRefreshing
                ? "Querying Snowflake…"
                : `Live Snowflake · updated ${formatTimestamp(lastUpdatedAt ?? null)}`}
          </Typography>
          {/* One row, primary action first. Stacked, the two read as a list of
            * unrelated options; side by side they read as what they are — the
            * thing that starts work, and the thing that re-reads it. */}
          <Stack direction="row" gap={1} alignItems="center">
            {onRunPipeline && (
              <Button
                size="small"
                variant="contained"
                disabled={runState?.busy}
                onClick={onRunPipeline}
              >
                {runState?.busy ? "Starting…" : "Run pipeline"}
              </Button>
            )}
            <Button
              size="small"
              variant="outlined"
              disabled={isRefreshing}
              onClick={onRefresh}
            >
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return "not available";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

function Td({
  children,
  stripe,
}: {
  children: React.ReactNode;
  stripe?: string | null;
}) {
  return (
    <Box
      component="td"
      sx={{
        p: 1.2,
        borderBottom: `1px solid ${alpha(colors.edge, 0.5)}`,
        fontSize: 12,
        verticalAlign: "middle",
        boxShadow: stripe
          ? `inset 2px 0 0 ${severityColor[stripe as keyof typeof severityColor]}`
          : "none",
      }}
    >
      {children}
    </Box>
  );
}

function Kpi({
  label,
  value,
  sub,
  accent,
  valueColor,
}: {
  label: string;
  value: string;
  sub: React.ReactNode;
  accent: string;
  valueColor?: string;
}) {
  return (
    <Panel>
      <Box sx={{ position: "relative", overflow: "hidden" }}>
        <Box
          sx={{
            position: "absolute",
            left: -16,
            top: -16,
            bottom: -16,
            width: 2,
            backgroundColor: accent,
            boxShadow: `0 0 14px ${accent}`,
          }}
        />
        <Stack gap={1}>
          <Typography
            sx={{
              fontFamily: fonts.mono,
              fontSize: 10,
              letterSpacing: "0.13em",
              textTransform: "uppercase",
              color: colors.text3,
            }}
          >
            {label}
          </Typography>
          <Typography
            sx={{
              fontFamily: fonts.mono,
              fontSize: 30,
              fontWeight: 600,
              lineHeight: 1,
              letterSpacing: "-0.02em",
              color: valueColor ?? colors.text1,
            }}
          >
            {value}
          </Typography>
          <Box sx={{ fontSize: 11.5, color: colors.text2, display: "flex", alignItems: "center", gap: 0.8 }}>
            {sub}
          </Box>
        </Stack>
      </Box>
    </Panel>
  );
}

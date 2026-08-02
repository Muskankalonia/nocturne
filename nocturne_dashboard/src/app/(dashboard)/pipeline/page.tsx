"use client";

import { useMemo } from "react";
import { Box, Stack, Typography, alpha } from "@mui/material";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { cascadeForScope, groundingStats } from "@/mocks/pipeline";
import {
  cacheSavings,
  costByStage,
  pipelineHealthByTenant,
  rejectionReasons,
  tasks,
  versionDrift,
} from "@/mocks/fleet";
import { Panel } from "@/components/ui/Panel";
import { Cascade } from "@/components/ui/Cascade";
import {
  BarList,
  DataGapNote,
  PageHeader,
  StatCard,
  StatGrid,
  Tag,
} from "@/components/ui/Primitives";
import { colors, fonts, severityColor } from "@/theme/tokens";
import { relativeTime } from "@/lib/format";

const NOW = Date.parse("2026-08-01T16:05:00Z");

export default function PipelinePage() {
  const { session, isFleetScope } = useAuth();

  const stats = isFleetScope ? groundingStats.fleet : groundingStats.org;
  const cascade = session ? cascadeForScope(session.scope) : [];

  const health = useMemo(() => {
    if (!session) return [];
    const orgId = scopeOrgId(session.scope);
    return orgId === null
      ? pipelineHealthByTenant
      : pipelineHealthByTenant.filter((h) => h.orgId === orgId);
  }, [session]);

  const totalSpend = costByStage.reduce((s, c) => s + c.spendUsd, 0);
  const extracted = cascade.find((s) => s.id === "extracted")?.count ?? 0;
  const relevance = cascade.find((s) => s.id === "relevance")?.count ?? 1;
  const deepPct = ((extracted / relevance) * 100).toFixed(1);

  return (
    <Stack gap={2}>
      <PageHeader
        title="Pipeline"
        subtitle="How evidence is verified, what gets thrown away, and what it costs."
      />

      <StatGrid>
        <StatCard
          label="Evidence verified verbatim"
          value={`${stats.rate}%`}
          sub={`${stats.verified.toLocaleString()} quotes · ${stats.quarantined} quarantined`}
          accent={colors.verified}
          valueColor={colors.verified}
        />
        <StatCard
          label="Sent to expensive analysis"
          value={`${deepPct}%`}
          sub={`${extracted.toLocaleString()} of ${relevance.toLocaleString()} pages`}
          accent={severityColor.critical}
        />
        <StatCard
          label="Repeat calls avoided"
          value={cacheSavings.callsAvoided.toLocaleString()}
          sub={`≈ $${cacheSavings.usdAvoided} not spent`}
          accent={colors.ion}
          valueColor={colors.ion}
        />
        <StatCard
          label="Spend · 30 days"
          value={`$${totalSpend.toFixed(2)}`}
          sub="across all AI stages"
          accent={severityColor.medium}
        />
      </StatGrid>

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" } }}>
        <Panel title="Detection Cascade" meta="RED = BILLED STAGE">
          <Cascade stages={cascade} />
        </Panel>

        <Panel title="Quarantined Extractions" meta="WHY THEY WERE REJECTED">
          <BarList
            data={rejectionReasons.map((r) => ({
              label: (
                <>
                  {r.label}
                  {r.reason === "unmatched_evidence" && <Tag tone="critical">hallucination</Tag>}
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
          <Box
            sx={{
              mt: 2,
              pt: 1.6,
              borderTop: `1px solid ${colors.edge}`,
              fontSize: 11.5,
              color: colors.text2,
              lineHeight: 1.65,
            }}
          >
            <b style={{ color: colors.text1 }}>
              {stats.quarantined} of {(stats.verified + stats.quarantined).toLocaleString()}
            </b>{" "}
            extracted elements failed verbatim verification and never reached the graph. None of
            them appear in any score.
          </Box>
        </Panel>
      </Box>

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" } }}>
        <Panel title="Version drift" meta="BASELINE VS CURRENT">
          <Box sx={{ overflowX: "auto" }}>
            <Table headers={["Stage", "Baseline", "Current", "Rows behind"]}>
              {versionDrift.map((d) => (
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
              <b>14 rows</b> were scored with the previous method version and are not directly
              comparable to today&apos;s ranking until they are recomputed.
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
                      {relativeTime(h.lastIngestAt, NOW)}
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
                      {h.status === "healthy" ? "Healthy" : "Ingest Lagging"}
                    </Tag>
                  </Td>
                </Box>
              ))}
            </Table>
          </Box>
        </Panel>
      </Box>

      <Panel title="Task health" meta="2 SCHEDULED · 4 STREAM-TRIGGERED">
        <Box sx={{ overflowX: "auto" }}>
          <Table headers={["Task", "Trigger", "State", "Last run", "Pending", "Errors"]}>
            {tasks.map((t) => (
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
                    {t.lastRunAt ? relativeTime(t.lastRunAt, NOW) : "never"}
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

      <Panel title="Accuracy metrics">
        <DataGapNote>
          <b>Precision, recall and calibration are deliberately absent.</b> They need a labelled
          gold set — roughly 40 hand-reviewed pages — which does not exist yet. Showing an invented
          accuracy figure would be worse than showing none. Build the gold set and this panel fills
          itself in.
        </DataGapNote>
      </Panel>
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

"use client";

import { useMemo } from "react";
import { Box, Stack, Typography, alpha } from "@mui/material";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { incidents } from "@/mocks/incidents";
import { cascadeForScope, groundingStats } from "@/mocks/pipeline";
import { Panel } from "@/components/ui/Panel";
import { Cascade } from "@/components/ui/Cascade";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { colors, fonts, severityColor } from "@/theme/tokens";

export default function CommandCenterPage() {
  const { session, isFleetScope, activeOrg, switchableOrgs } = useAuth();

  const scoped = useMemo(() => {
    if (!session) return [];
    const orgId = scopeOrgId(session.scope);
    return orgId === null ? incidents : incidents.filter((i) => i.orgId === orgId);
  }, [session]);

  const scored = scoped.filter((i) => i.triagePriorityScore !== null);
  const stats = isFleetScope ? groundingStats.fleet : groundingStats.org;

  const topImpact = scored.reduce((m, i) => Math.max(m, i.impactSeverityScore ?? 0), 0);
  const criticals = scored.filter((i) => i.impactSeverityBand === "critical").length;
  const distinctActors = new Set(
    scored.map((i) => i.actorName).filter(Boolean),
  ).size;

  const cascade = session ? cascadeForScope(session.scope) : [];

  const queue = [...scored].sort(
    (a, b) => (b.triagePriorityScore ?? 0) - (a.triagePriorityScore ?? 0),
  );

  return (
    <Stack gap={2}>
      <Box>
        <Typography variant="h2">
          {isFleetScope ? "Fleet posture" : `${activeOrg?.canonicalName} posture`}
        </Typography>
        <Typography sx={{ color: colors.text2, fontSize: 13, mt: 0.3 }}>
          {isFleetScope
            ? `Aggregated across ${switchableOrgs.length} organizations.`
            : "What of yours was exposed, how badly, and what to do about it."}
        </Typography>
      </Box>

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
            value={String(switchableOrgs.length)}
            sub="all ingesting"
            accent={colors.ion}
          />
        ) : (
          <Kpi
            label="Top impact severity"
            value={topImpact ? String(topImpact) : "—"}
            sub={<SeverityChip band={topImpact >= 80 ? "critical" : topImpact >= 60 ? "high" : "medium"} />}
            accent={severityColor.critical}
            valueColor={severityColor.critical}
          />
        )}
        <Kpi
          label={isFleetScope ? "Critical · fleet" : "Open incidents"}
          value={String(isFleetScope ? criticals : scored.length)}
          sub={
            isFleetScope ? (
              `of ${scored.length} open`
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
          sub={`${stats.verified.toLocaleString()} verbatim · ${stats.quarantined} quarantined`}
          accent={colors.verified}
          valueColor={colors.verified}
        />
        <Kpi
          label="Distinct threat actors"
          value={String(distinctActors)}
          sub={isFleetScope ? "3 hitting 2+ tenants" : "across 3 marketplaces"}
          accent={colors.ion}
        />
      </Box>

      {/* cascade */}
      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" },
        }}
      >
        <Panel
          title={isFleetScope ? "Fleet cascade — all tenants" : "Detection cascade — last 24h"}
          meta="RED = BILLED STAGE"
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
              {cascade.find((s) => s.id === "extracted")?.count.toLocaleString()} /{" "}
              {cascade.find((s) => s.id === "relevance")?.count.toLocaleString()}
            </Box>{" "}
            pages. A send-everything baseline would have run the expensive model on all of them.
          </Box>
        </Panel>

        <Panel title="Incidents by band">
          <Stack gap={1.4}>
            {(["critical", "high", "medium", "low", "informational"] as const).map((band) => {
              const n = scored.filter((i) => i.impactSeverityBand === band).length;
              const pct = scored.length ? (n / scored.length) * 100 : 0;
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
      <Panel title="Priority queue — ranked by triage score" meta="LAST UPDATED 04:05 PM">
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
              {queue.map((row) => (
                <Box
                  component="tr"
                  key={row.incidentKey}
                  sx={{
                    background:
                      row.impactSeverityBand === "critical"
                        ? `linear-gradient(90deg, ${alpha(colors.critical, 0.09)}, transparent 42%)`
                        : "none",
                  }}
                >
                  {isFleetScope && (
                    <Td stripe={row.impactSeverityBand}>
                      <b>{row.organizationName}</b>
                    </Td>
                  )}
                  <Td stripe={isFleetScope ? null : row.impactSeverityBand}>
                    <Stack>
                      <Box sx={{ fontWeight: 600, fontSize: 12.5 }}>{row.topTitle}</Box>
                      <Box sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 10.5 }}>
                        {new URL(row.topUrl).hostname}
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

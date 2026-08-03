"use client";

import { useRouter } from "next/navigation";
import { Box, Stack, Typography, alpha } from "@mui/material";
import { useAuth } from "@/contexts/AuthContext";
import { exposureMatrix, fleetSummary, orgPostures } from "@/mocks/fleet";
import { Panel } from "@/components/ui/Panel";
import { SeverityChip } from "@/components/ui/SeverityChip";
import {
  PageHeader,
  Sparkline,
  StatCard,
  StatGrid,
  Tag,
} from "@/components/ui/Primitives";
import { colors, fonts, severityColor } from "@/theme/tokens";
import { leakTypeLabel, relativeTime } from "@/lib/format";
import AdminOnly from "@/components/layout/AdminOnly";

const NOW = Date.parse("2026-08-01T16:05:00Z");
const LEAK_TYPES = ["credential", "corporate_data", "pii", "financial", "malware_exploit"] as const;

export default function FleetCommandPage() {
  const router = useRouter();
  const { setScope } = useAuth();

  const ranked = [...orgPostures].sort(
    (a, b) => (b.topTriagePriorityScore ?? 0) - (a.topTriagePriorityScore ?? 0),
  );
  const maxCell = Math.max(...exposureMatrix.flatMap((r) => Object.values(r.counts)));

  return (
    <AdminOnly>
      <Stack gap={2}>
        <PageHeader
          title="Fleet Command"
          subtitle="Every tenant ranked by risk. The unit here is the organization, not the incident."
        />

        <StatGrid>
          <StatCard label="Tenants monitored" value={String(fleetSummary.tenantCount)} sub="all ingesting" />
          <StatCard
            label="Critical across fleet"
            value={String(fleetSummary.criticalIncidents)}
            sub={`of ${fleetSummary.totalIncidents} open incidents`}
            accent={severityColor.critical}
            valueColor={severityColor.critical}
          />
          <StatCard
            label="Actors hitting 2+ tenants"
            value={String(fleetSummary.crossTenantActorCount)}
            sub={`of ${fleetSummary.totalActorCount} distinct actors`}
            accent={severityColor.high}
            valueColor={severityColor.high}
          />
          <StatCard
            label="Fleet spend · 30d"
            value={`$${fleetSummary.spendUsd30d.toFixed(2)}`}
            sub={`${fleetSummary.pagesProcessed30d.toLocaleString()} pages processed`}
            accent={colors.verified}
          />
        </StatGrid>

        <Panel title="Tenant risk leaderboard" meta="RANKED BY TOP TRIAGE PRIORITY">
          <Box sx={{ overflowX: "auto" }}>
            <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
              <Box component="thead">
                <Box component="tr">
                  {["Organization", "Incidents", "Critical", "Top impact", "Actors", "30-day trend", "Last activity", "Ingest"].map(
                    (h) => (
                      <Box key={h} component="th" sx={thSx}>
                        {h}
                      </Box>
                    ),
                  )}
                </Box>
              </Box>
              <Box component="tbody">
                {ranked.map((org) => {
                  const band = org.topImpactSeverityBand ?? "informational";
                  const rising = org.trend[org.trend.length - 1]! > org.trend[0]!;
                  const stale = Date.parse(org.lastActivity) < NOW - 60 * 60 * 1000;
                  return (
                    <Box
                      component="tr"
                      key={org.orgId}
                      onClick={() => {
                        setScope({ kind: "org", orgId: org.orgId });
                        router.push("/");
                      }}
                      sx={{
                        cursor: "pointer",
                        background:
                          band === "critical"
                            ? `linear-gradient(90deg, ${alpha(colors.critical,0.09)}, transparent 42%)`
                            : "none",
                        "&:hover": { backgroundColor: alpha(colors.ion, 0.06) },
                      }}
                    >
                      <Td stripe={band}>
                        <Stack sx={{ lineHeight: 1.35 }}>
                          <Box sx={{ fontWeight: 600, fontSize: 12.5 }}>{org.canonicalName}</Box>
                          <Box sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 10.5 }}>
                            {org.orgId}
                          </Box>
                        </Stack>
                      </Td>
                      <Td><Mono>{org.incidentCount}</Mono></Td>
                      <Td><SeverityChip band={band} score={org.criticalIncidents} /></Td>
                      <Td>
                        <Stack direction="row" alignItems="center" gap={1}>
                          <Mono color={severityColor[band]}>{org.topImpactSeverityScore}</Mono>
                          <Box
                            sx={{
                              width: 54,
                              height: 4,
                              borderRadius: "2px",
                              backgroundColor: "rgba(255,255,255,0.07)",
                              overflow: "hidden",
                            }}
                          >
                            <Box
                              sx={{
                                height: "100%",
                                width: `${org.topImpactSeverityScore ?? 0}%`,
                                backgroundColor: severityColor[band],
                              }}
                            />
                          </Box>
                        </Stack>
                      </Td>
                      <Td><Mono>{org.distinctActors}</Mono></Td>
                      <Td>
                        <Sparkline
                          data={org.trend}
                          color={rising ? severityColor.critical : colors.verified}
                        />
                      </Td>
                      <Td>
                        <Mono color={stale ? severityColor.medium : colors.text2}>
                          {relativeTime(org.lastActivity, NOW)}
                        </Mono>
                      </Td>
                      <Td>
                        <Tag tone={stale ? "medium" : "ok"}>{stale ? "lagging" : "healthy"}</Tag>
                      </Td>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Box>
          <Typography sx={{ mt: 1.5, fontSize: 11, color: colors.text3 }}>
            Selecting a row switches scope to that tenant and opens its Command Center.
          </Typography>
        </Panel>

        <Panel title="Exposure by data class" meta="TENANT × TYPE">
          <Box sx={{ overflowX: "auto" }}>
            {/* `width: 100%` matters: without it the table sizes to its content
                and leaves the right half of the panel empty. */}
            <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
              <Box component="thead">
                <Box component="tr">
                  <Box component="th" sx={{ ...thSx, width: "22%", minWidth: 130 }}>
                    Tenant
                  </Box>
                  {LEAK_TYPES.map((t) => (
                    <Box key={t} component="th" sx={{ ...thSx, textAlign: "center" }}>
                      {leakTypeLabel[t]}
                    </Box>
                  ))}
                </Box>
              </Box>
              <Box component="tbody">
                {exposureMatrix.map((row) => (
                  <Box component="tr" key={row.orgId}>
                    <Td>
                      <Box sx={{ fontSize: 11.5 }}>{row.label}</Box>
                    </Td>
                    {LEAK_TYPES.map((t) => {
                      const v = row.counts[t] ?? 0;
                      const intensity = v / maxCell;
                      const bg =
                        intensity > 0.6
                          ? alpha(colors.critical, 0.35 + intensity * 0.4)
                          : intensity > 0.3
                            ? alpha(colors.high, 0.25 + intensity * 0.4)
                            : intensity > 0
                              ? alpha(colors.medium, 0.15 + intensity * 0.3)
                              : alpha(colors.informational, 0.18);
                      return (
                        <Td key={t}>
                          <Box
                            sx={{
                              width: 30,
                              mx: "auto",
                              textAlign: "center",
                              py: 0.4,
                              borderRadius: "4px",
                              backgroundColor: bg,
                              fontFamily: fonts.mono,
                              fontSize: 10.5,
                              color: intensity > 0.3 ? "#180208" : colors.text2,
                            }}
                          >
                            {v}
                          </Box>
                        </Td>
                      );
                    })}
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        </Panel>
      </Stack>
    </AdminOnly>
  );
}

const thSx = {
  textAlign: "left" as const,
  fontFamily: fonts.mono,
  fontSize: 9.5,
  letterSpacing: "0.12em",
  textTransform: "uppercase" as const,
  color: colors.text3,
  fontWeight: 500,
  p: 1.2,
  borderBottom: `1px solid ${colors.edge}`,
  whiteSpace: "nowrap" as const,
};

function Td({ children, stripe }: { children: React.ReactNode; stripe?: string | null }) {
  return (
    <Box
      component="td"
      sx={{
        p: 1.2,
        borderBottom: "1px solid rgba(122,164,255,0.07)",
        fontSize: 12,
        boxShadow: stripe
          ? `inset 2px 0 0 ${severityColor[stripe as keyof typeof severityColor]}`
          : "none",
      }}
    >
      {children}
    </Box>
  );
}

function Mono({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <Box component="span" sx={{ fontFamily: fonts.mono, fontSize: 12, color: color ?? colors.text1 }}>
      {children}
    </Box>
  );
}

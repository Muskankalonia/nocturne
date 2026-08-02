"use client";

import { Box, Stack, Typography, alpha } from "@mui/material";
import { cacheSavings, costByStage, costByTenant, fleetSummary } from "@/mocks/fleet";
import { fleetCascade } from "@/mocks/pipeline";
import { Panel } from "@/components/ui/Panel";
import { BarList, PageHeader, StatCard, StatGrid } from "@/components/ui/Primitives";
import { colors, fonts, severityColor } from "@/theme/tokens";
import AdminOnly from "@/components/layout/AdminOnly";

export default function FleetCostPage() {
  const total = costByStage.reduce((s, c) => s + c.spendUsd, 0);
  const perThousand = (total / (fleetSummary.pagesProcessed30d / 1000)).toFixed(2);
  const perIncident = (total / fleetSummary.totalIncidents).toFixed(2);

  const relevance = fleetCascade.find((s) => s.id === "relevance")?.count ?? 1;
  const extracted = fleetCascade.find((s) => s.id === "extracted")?.count ?? 0;
  // What a send-everything baseline would have cost: the expensive extraction
  // model run on every deduplicated page instead of the 6.4% that survive gating.
  const unitCost = (costByStage[0]!.spendUsd / extracted) || 0;
  const baselineCost = unitCost * relevance;

  return (
    <AdminOnly>
      <Stack gap={2}>
        <PageHeader
          title="Fleet Cost and Usage"
          subtitle="What each tenant costs, where it goes, and what the caches saved."
        />

        <StatGrid>
          <StatCard
            label="Spend · 30 days"
            value={`$${total.toFixed(2)}`}
            sub={`${fleetSummary.pagesProcessed30d.toLocaleString()} pages`}
            accent={severityColor.medium}
          />
          <StatCard label="Cost per 1,000 pages" value={`$${perThousand}`} accent={colors.ion} />
          <StatCard
            label="Cost per incident"
            value={`$${perIncident}`}
            sub={`${fleetSummary.totalIncidents} incidents raised`}
            accent={colors.ion}
          />
          <StatCard
            label="Repeat calls avoided"
            value={cacheSavings.callsAvoided.toLocaleString()}
            sub={`≈ $${cacheSavings.usdAvoided} not spent`}
            accent={colors.verified}
            valueColor={colors.verified}
          />
        </StatGrid>

        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1.4fr 1fr" } }}>
          <Panel title="Spend by tenant · 30 days" meta={`TOTAL $${total.toFixed(2)}`}>
            <Box sx={{ overflowX: "auto" }}>
              <Box component="table" sx={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                <Box component="thead">
                  <Box component="tr">
                    {["Tenant", "Pages", "Deep analyses", "Spend", "Per incident"].map((h) => (
                      <Box key={h} component="th" sx={thSx}>
                        {h}
                      </Box>
                    ))}
                  </Box>
                </Box>
                <Box component="tbody">
                  {costByTenant.map((t) => (
                    <Box component="tr" key={t.orgId}>
                      <Td>
                        <Box sx={{ fontSize: 11.5 }}>{t.organizationName}</Box>
                      </Td>
                      <Td><Mono>{t.pagesProcessed.toLocaleString()}</Mono></Td>
                      <Td><Mono>{t.deepAnalyses}</Mono></Td>
                      <Td>
                        <Mono color={t.spendUsd > 4 ? severityColor.medium : colors.text1}>
                          ${t.spendUsd.toFixed(2)}
                        </Mono>
                      </Td>
                      <Td><Mono>${t.costPerIncidentUsd.toFixed(2)}</Mono></Td>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Box>
          </Panel>

          <Panel title="Spend by stage" meta="BY QUERY TAG">
            <BarList
              data={costByStage.map((c) => ({
                label: c.label,
                value: c.spendUsd,
                display: `$${c.spendUsd.toFixed(2)}`,
                color:
                  c.stage === "l2_extraction"
                    ? severityColor.critical
                    : c.stage === "relationship"
                      ? severityColor.high
                      : c.stage === "leak_type"
                        ? severityColor.medium
                        : severityColor.low,
              }))}
            />
            <Stack gap={0.6} sx={{ mt: 2, pt: 1.6, borderTop: `1px solid ${colors.edge}` }}>
              {costByStage.map((c) => (
                <Stack key={c.queryTag} direction="row" gap={1}>
                  <Typography sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.text3, flex: 1 }}>
                    {c.queryTag}
                  </Typography>
                  <Typography sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.text2 }}>
                    {c.callCount.toLocaleString()} calls
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Panel>
        </Box>

        <Panel title="What the gating saved" meta="VS A SEND-EVERYTHING BASELINE">
          <Stack gap={2}>
            <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" } }}>
              <Box
                sx={{
                  p: 2,
                  borderRadius: "8px",
                  border: `1px solid ${alpha(severityColor.critical, 0.28)}`,
                  backgroundColor: alpha(severityColor.critical, 0.06),
                }}
              >
                <Typography variant="overline" sx={{ display: "block" }}>
                  Baseline — every page to the expensive model
                </Typography>
                <Typography
                  sx={{ fontFamily: fonts.mono, fontSize: 26, fontWeight: 600, color: severityColor.critical, mt: 0.6 }}
                >
                  ${baselineCost.toFixed(2)}
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: colors.text2, mt: 0.4 }}>
                  {relevance.toLocaleString()} deep analyses
                </Typography>
              </Box>
              <Box
                sx={{
                  p: 2,
                  borderRadius: "8px",
                  border: `1px solid ${alpha(colors.verified, 0.28)}`,
                  backgroundColor: alpha(colors.verified, 0.06),
                }}
              >
                <Typography variant="overline" sx={{ display: "block" }}>
                  Nocturne — gated cascade
                </Typography>
                <Typography
                  sx={{ fontFamily: fonts.mono, fontSize: 26, fontWeight: 600, color: colors.verified, mt: 0.6 }}
                >
                  ${costByStage[0]!.spendUsd.toFixed(2)}
                </Typography>
                <Typography sx={{ fontSize: 11.5, color: colors.text2, mt: 0.4 }}>
                  {extracted.toLocaleString()} deep analyses ·{" "}
                  {((extracted / relevance) * 100).toFixed(1)}% of pages
                </Typography>
              </Box>
            </Box>
            <Typography sx={{ fontSize: 11.5, color: colors.text3, lineHeight: 1.65 }}>
              Baseline is modelled as the same extraction model run on every deduplicated page, at
              the unit cost actually observed. It excludes the cheap relevance pass, which the
              cascade still runs on everything — the saving comes from what never reaches the
              expensive stage.
            </Typography>
          </Stack>
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

function Td({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="td"
      sx={{ p: 1.2, borderBottom: "1px solid rgba(122,164,255,0.07)", fontSize: 11.5 }}
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

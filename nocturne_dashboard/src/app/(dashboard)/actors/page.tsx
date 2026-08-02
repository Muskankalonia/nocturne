"use client";

import { useMemo, useState } from "react";
import { Box, Divider, Stack, Typography } from "@mui/material";
import type { ColDef, ICellRendererParams, RowClassParams } from "ag-grid-community";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { actors } from "@/mocks/actors";
import { findOrganization } from "@/mocks/organizations";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/DataTable";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { BarList, DataGapNote, PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import { bandForScore, colors, fonts, severityColor } from "@/theme/tokens";
import { relativeTime } from "@/lib/format";
import type { ThreatActor } from "@/types";

const NOW = Date.parse("2026-08-01T16:05:00Z");
const GENERIC = ["admin", "seller", "user", "vendor"];

export default function ThreatActorsPage() {
  const { session, isFleetScope } = useAuth();

  const scoped = useMemo(() => {
    if (!session) return [];
    const orgId = scopeOrgId(session.scope);
    const rows = orgId === null ? actors : actors.filter((a) => a.orgId === orgId);
    return [...rows].sort((a, b) => b.credibilityScore - a.credibilityScore);
  }, [session]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = scoped.find((a) => a.actorNodeKey === selectedKey) ?? scoped[0] ?? null;

  const corroborated = scoped.reduce((s, a) => s + a.corroboratedClaimCount, 0);
  const markets = new Set(scoped.flatMap((a) => a.marketplaces)).size;

  const columns = useMemo<ColDef<ThreatActor>[]>(() => {
    const base: ColDef<ThreatActor>[] = [
      {
        headerName: "Alias",
        field: "actorName",
        minWidth: 150,
        cellRenderer: (p: ICellRendererParams<ThreatActor>) => {
          const generic = GENERIC.includes(String(p.value).toLowerCase());
          return (
            <Box sx={{ fontFamily: fonts.mono, fontSize: 12.5, color: generic ? colors.text3 : colors.ion }}>
              {p.value}
              {generic && (
                <Box component="span" sx={{ fontSize: 10, color: colors.text3 }}>
                  {" "}
                  (generic)
                </Box>
              )}
            </Box>
          );
        },
      },
      { headerName: "Claims", field: "totalClaimCount", minWidth: 92, maxWidth: 110 },
      {
        headerName: "Confirmed",
        field: "corroboratedClaimCount",
        minWidth: 104,
        maxWidth: 124,
        cellRenderer: (p: ICellRendererParams<ThreatActor>) => (
          <Box sx={{ fontFamily: fonts.mono, fontSize: 12, color: p.value ? colors.verified : colors.text3 }}>
            {p.value}
          </Box>
        ),
      },
      { headerName: "Markets", field: "marketplaceCount", minWidth: 92, maxWidth: 110 },
      {
        headerName: "Credibility",
        field: "credibilityScore",
        minWidth: 118,
        maxWidth: 138,
        cellRenderer: (p: ICellRendererParams<ThreatActor>) => (
          <SeverityChip band={bandForScore(p.value as number)} score={p.value as number} />
        ),
      },
      {
        headerName: "Last seen",
        field: "lastSeen",
        minWidth: 110,
        cellRenderer: (p: ICellRendererParams<ThreatActor>) => (
          <Box sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>
            {relativeTime(String(p.value), NOW)}
          </Box>
        ),
      },
    ];

    if (isFleetScope) {
      base.splice(1, 0, {
        headerName: "Tenant",
        field: "orgId",
        minWidth: 150,
        valueFormatter: (p) => findOrganization(String(p.value))?.canonicalName ?? String(p.value),
      });
    }
    return base;
  }, [isFleetScope]);

  return (
    <Stack gap={2}>
      <PageHeader
        title="Threat Actors"
        subtitle="Credibility is computed from the graph, not asserted — every component is visible."
      />

      <StatGrid>
        <StatCard label="Actors observed" value={String(scoped.length)} />
        <StatCard
          label="Confirmed claims"
          value={String(corroborated)}
          accent={colors.verified}
          valueColor={colors.verified}
        />
        <StatCard label="Marketplaces" value={String(markets)} />
        <StatCard
          label="Highest credibility"
          value={String(scoped[0]?.credibilityScore ?? 0)}
          accent={severityColor.critical}
          valueColor={severityColor.critical}
        />
      </StatGrid>

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" } }}>
        <Panel title={isFleetScope ? "Actors across all tenants" : "Actors targeting you"}>
          <DataTable<ThreatActor>
            rowData={scoped}
            columnDefs={columns}
            getRowId={(p) => p.data.actorNodeKey}
            searchPlaceholder="Filter by alias, marketplace, channel…"
            height={340}
            rowStyle={{ cursor: "pointer" }}
            getRowClass={(p: RowClassParams<ThreatActor>) => {
              const band = bandForScore(p.data?.credibilityScore ?? 0);
              return band ? `row-${band}` : "";
            }}
            onRowClicked={(e) => e.data && setSelectedKey(e.data.actorNodeKey)}
          />
          <Typography sx={{ mt: 1.5, fontSize: 11, color: colors.text3, lineHeight: 1.6 }}>
            Generic aliases are keyed per source page, never merged — two unrelated sellers both
            calling themselves “seller” stay two separate actors.
          </Typography>
        </Panel>

        {selected && (
          <Panel title={`${selected.actorName} · credibility breakdown`}>
            <BarList
              data={[
                {
                  label: (
                    <>
                      Confirmed claims <Tag>weight 40</Tag>
                    </>
                  ),
                  value: Math.min(selected.corroboratedClaimCount / 3, 1) * 100,
                  display: `${selected.corroboratedClaimCount}/3`,
                  color: colors.verified,
                },
                {
                  label: (
                    <>
                      Marketplaces <Tag>weight 25</Tag>
                    </>
                  ),
                  value: Math.min(selected.marketplaceCount / 3, 1) * 100,
                  display: String(selected.marketplaceCount),
                  color: colors.ion,
                },
                {
                  label: (
                    <>
                      Independent posts <Tag>weight 20</Tag>
                    </>
                  ),
                  value: Math.min(selected.docCount / 3, 1) * 100,
                  display: String(selected.docCount),
                  color: colors.ion,
                },
                {
                  label: (
                    <>
                      Disputed claims <Tag>penalty 20</Tag>
                    </>
                  ),
                  value: Math.min(selected.disputedClaimCount / 2, 1) * 100,
                  display: String(selected.disputedClaimCount),
                  color: severityColor.critical,
                },
              ]}
              max={100}
            />

            <Divider sx={{ my: 2, borderColor: colors.edge }} />
            <Stack direction="row" alignItems="baseline" gap={1.2}>
              <Typography
                sx={{
                  fontFamily: fonts.mono,
                  fontSize: 30,
                  fontWeight: 600,
                  color: severityColor[bandForScore(selected.credibilityScore) ?? "informational"],
                }}
              >
                {selected.credibilityScore}
              </Typography>
              <Typography sx={{ fontSize: 11, color: colors.text3 }}>/ 100 credibility</Typography>
            </Stack>

            <Typography variant="overline" sx={{ display: "block", mt: 2.2, mb: 1 }}>
              Known venues
            </Typography>
            <Stack direction="row" gap={0.6} flexWrap="wrap">
              {[...selected.marketplaces, ...selected.contactChannels].map((m) => (
                <Tag key={m}>{m}</Tag>
              ))}
              {selected.marketplaces.length + selected.contactChannels.length === 0 && (
                <Typography sx={{ fontSize: 11, color: colors.text3 }}>none recorded</Typography>
              )}
            </Stack>

            {isFleetScope && (
              <Box sx={{ mt: 2.2 }}>
                <DataGapNote>
                  This list is still per-tenant. Merging <b>{selected.actorName}</b> across tenants
                  needs <Box component="code" sx={{ fontFamily: fonts.mono }}>GLOBAL_NODE_KEY</Box>.
                </DataGapNote>
              </Box>
            )}
          </Panel>
        )}
      </Box>
    </Stack>
  );
}

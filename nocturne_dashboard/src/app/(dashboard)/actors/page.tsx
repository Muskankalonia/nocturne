"use client";

import { useEffect, useMemo, useState } from "react";
import { Box, Divider, Stack, Typography } from "@mui/material";
import type { ColDef, ICellRendererParams, RowClassParams } from "ag-grid-community";
import { useAuth } from "@/contexts/AuthContext";
import { usePosture } from "@/contexts/PostureContext";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/DataTable";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { TableSkeleton, TextBlockSkeleton } from "@/components/ui/Skeletons";
import { DataGapNote, PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import { bandForScore, colors, fonts, layout as layoutTokens, severityColor } from "@/theme/tokens";
import { relativeTime } from "@/lib/format";
import {
  CREDIBILITY_TERMS,
  isGenericAlias,
  rollUpActors,
  type ActorRollup,
} from "@/lib/actor-rollup";

export default function ThreatActorsPage() {
  const { isFleetScope } = useAuth();
  const { incidents, isLoading, error } = usePosture();

  const actors = useMemo(() => rollUpActors(incidents), [incidents]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    actors.find((a) => a.actorNodeKey === selectedKey) ?? actors[0] ?? null;

  // Switching tenant replaces the roster; a stale key would pin the inspector
  // to an actor that is no longer in scope.
  useEffect(() => {
    setSelectedKey(null);
  }, [isFleetScope]);

  const corroborated = actors.reduce((sum, a) => sum + a.corroboratingDocs, 0);
  const venues = new Set(actors.flatMap((a) => a.venues)).size;

  const columns = useMemo<ColDef<ActorRollup>[]>(() => {
    const base: ColDef<ActorRollup>[] = [
      {
        headerName: "Alias",
        field: "actorName",
        minWidth: 150,
        flex: 1.4,
        cellRenderer: (p: ICellRendererParams<ActorRollup>) => {
          const generic = isGenericAlias(String(p.value));
          return (
            <Box
              sx={{
                fontFamily: fonts.mono,
                fontSize: 12.5,
                color: generic ? colors.text3 : colors.ion,
              }}
            >
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
      { headerName: "Incidents", field: "incidentCount", minWidth: 100, maxWidth: 124 },
      {
        headerName: "Corroborating docs",
        field: "corroboratingDocs",
        minWidth: 140,
        maxWidth: 170,
        cellRenderer: (p: ICellRendererParams<ActorRollup>) => (
          <Box
            sx={{
              fontFamily: fonts.mono,
              fontSize: 12,
              color: p.value ? colors.verified : colors.text3,
            }}
          >
            {p.value}
          </Box>
        ),
      },
      {
        headerName: "Venues",
        valueGetter: (p) => p.data?.venues.length ?? 0,
        minWidth: 92,
        maxWidth: 112,
      },
      {
        headerName: "Credibility",
        field: "credibilityScore",
        minWidth: 118,
        maxWidth: 138,
        cellRenderer: (p: ICellRendererParams<ActorRollup>) => (
          <SeverityChip band={bandForScore(p.value as number)} score={p.value as number} />
        ),
      },
      {
        headerName: "Last seen",
        field: "lastSeen",
        minWidth: 110,
        cellRenderer: (p: ICellRendererParams<ActorRollup>) => (
          <Box sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>
            {relativeTime(String(p.value), Date.now())}
          </Box>
        ),
      },
    ];

    if (isFleetScope) {
      base.splice(1, 0, {
        headerName: "Tenant",
        field: "organizationName",
        minWidth: 150,
      });
    }
    return base;
  }, [isFleetScope]);

  return (
    // Claim the fold: the shell's 52px header plus its vertical padding, less a
    // small breathing gap at the bottom so the panels do not butt the edge.
    <Stack
      gap={2}
      sx={{
        height: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2 + 8}px)`,
      }}
    >
      <PageHeader
        title="Threat Actors"
        subtitle="Credibility is computed from the graph, not asserted — the formula and every sighting behind it are shown."
      />

      <StatGrid>
        <StatCard label="Actors observed" value={String(actors.length)} />
        <StatCard
          label="Corroborating documents"
          value={String(corroborated)}
          accent={colors.verified}
          valueColor={colors.verified}
        />
        <StatCard label="Venues" value={String(venues)} />
        <StatCard
          label="Highest credibility"
          value={String(actors[0]?.credibilityScore ?? 0)}
          accent={severityColor.critical}
          valueColor={severityColor.critical}
        />
      </StatGrid>

      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" },
          flex: 1,
          minHeight: 0,
        }}
      >
        <Panel
          title={isFleetScope ? "Actors across all tenants" : "Actors targeting you"}
          meta={`${actors.length} OBSERVED`}
          sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          {isLoading && actors.length === 0 ? (
            <TableSkeleton rows={8} columns={6} />
          ) : actors.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: colors.text3 }}>
              {error
                ? "Live actor data is unavailable."
                : "No incident in this scope has a named actor yet."}
            </Typography>
          ) : (
            <>
              <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                <DataTable<ActorRollup>
                  rowData={actors}
                  columnDefs={columns}
                  getRowId={(p) => p.data.actorNodeKey}
                  searchPlaceholder="Filter by alias, tenant, venue…"
                  height="100%"
                  rowStyle={{ cursor: "pointer" }}
                  getRowClass={(p: RowClassParams<ActorRollup>) => {
                    const band = bandForScore(p.data?.credibilityScore ?? 0);
                    return band ? `row-${band}` : "";
                  }}
                  onRowClicked={(e) => e.data && setSelectedKey(e.data.actorNodeKey)}
                />
              </Box>
              <Typography
                sx={{ mt: 1.5, fontSize: 11, color: colors.text3, lineHeight: 1.6, flexShrink: 0 }}
              >
                Generic aliases are keyed per source page, never merged — two unrelated sellers
                both calling themselves “seller” stay two separate actors.
              </Typography>
            </>
          )}
        </Panel>

        <Panel
          title={selected ? `${selected.actorName} · credibility` : "Credibility breakdown"}
          meta={selected ? `${selected.incidentCount} INCIDENTS` : undefined}
          sx={{ display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto" }}
        >
          {isLoading && !selected ? (
            <TextBlockSkeleton lines={8} />
          ) : !selected ? (
            <Typography sx={{ fontSize: 12, color: colors.text3 }}>
              Select an actor to see how their score was reached.
            </Typography>
          ) : (
            <>
              <Stack direction="row" alignItems="baseline" gap={1.2}>
                <Typography
                  sx={{
                    fontFamily: fonts.mono,
                    fontSize: 34,
                    fontWeight: 600,
                    lineHeight: 1,
                    color:
                      severityColor[bandForScore(selected.credibilityScore) ?? "informational"],
                  }}
                >
                  {selected.credibilityScore}
                </Typography>
                <Typography sx={{ fontSize: 11, color: colors.text3 }}>/ 100 credibility</Typography>
              </Stack>

              <Typography variant="overline" sx={{ display: "block", mt: 2.4, mb: 1 }}>
                How the score is built
              </Typography>
              <Stack gap={0.8}>
                {CREDIBILITY_TERMS.map((term) => (
                  <Stack key={term.label} direction="row" alignItems="center" gap={1}>
                    <Box
                      component="span"
                      sx={{
                        fontFamily: fonts.mono,
                        fontSize: 11,
                        width: 34,
                        flexShrink: 0,
                        textAlign: "right",
                        color: term.sign === "−" ? severityColor.critical : colors.verified,
                      }}
                    >
                      {term.sign}
                      {term.weight}
                    </Box>
                    <Typography sx={{ fontSize: 11.5, color: colors.text2 }}>
                      {term.label}
                    </Typography>
                    <Typography
                      sx={{ ml: "auto", fontSize: 10, color: colors.text3, whiteSpace: "nowrap" }}
                    >
                      {term.basis}
                    </Typography>
                  </Stack>
                ))}
              </Stack>

              <Divider sx={{ my: 2, borderColor: colors.edge }} />

              <Typography variant="overline" sx={{ display: "block", mb: 1 }}>
                Observed for this actor
              </Typography>
              <Stack gap={0.8}>
                <Kv k="Incidents" v={String(selected.incidentCount)} />
                <Kv
                  k="Corroborating docs"
                  v={String(selected.corroboratingDocs)}
                  color={selected.corroboratingDocs ? colors.verified : undefined}
                />
                <Kv k="Sightings" v={String(selected.sightings)} />
                <Kv k="Reposts / mirrors" v={String(selected.mirrorSightings)} />
                <Kv k="Top impact" v={String(selected.topImpactScore)} />
                <Kv k="First seen" v={relativeTime(selected.firstSeen, Date.now())} />
                <Kv k="Last seen" v={relativeTime(selected.lastSeen, Date.now())} />
              </Stack>

              <Typography variant="overline" sx={{ display: "block", mt: 2.4, mb: 1 }}>
                Venues seen on
              </Typography>
              <Stack direction="row" gap={0.6} flexWrap="wrap">
                {selected.venues.map((v) => (
                  <Tag key={v}>{v}</Tag>
                ))}
                {selected.venues.length === 0 && (
                  <Typography sx={{ fontSize: 11, color: colors.text3 }}>none recorded</Typography>
                )}
              </Stack>

              <Box sx={{ mt: 2.4 }}>
                <DataGapNote>
                  The numbers above are incident-level counts. The score&apos;s own inputs are
                  claim-level and live in{" "}
                  <Box component="code" sx={{ fontFamily: fonts.mono }}>
                    RAW.DT_L3_ACTOR_CREDIBILITY
                  </Box>
                  , which the console cannot read — the UI contract is the{" "}
                  <Box component="code" sx={{ fontFamily: fonts.mono }}>
                    DASHBOARD
                  </Box>{" "}
                  schema and there is no actor view in it yet. Filling these bars from incident
                  counts would show a different number to the one being explained.
                </DataGapNote>
              </Box>

              {isFleetScope && (
                <Box sx={{ mt: 1.5 }}>
                  <DataGapNote>
                    Actors are scoped per tenant. Merging{" "}
                    <b>{selected.actorName}</b> across tenants needs{" "}
                    <Box component="code" sx={{ fontFamily: fonts.mono }}>
                      GLOBAL_NODE_KEY
                    </Box>
                    .
                  </DataGapNote>
                </Box>
              )}
            </>
          )}
        </Panel>
      </Box>
    </Stack>
  );
}

function Kv({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <Stack direction="row" gap={1.2} alignItems="baseline">
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 9.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: colors.text3,
          width: 128,
          flexShrink: 0,
        }}
      >
        {k}
      </Typography>
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 11.5, color: color ?? colors.text1 }}>
        {v}
      </Typography>
    </Stack>
  );
}

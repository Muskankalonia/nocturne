"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Divider, Stack, Typography } from "@mui/material";
import { RefreshCw } from "lucide-react";
import type { ColDef, ICellRendererParams, RowClassParams } from "ag-grid-community";
import { useAuth } from "@/contexts/AuthContext";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/DataTable";
import { StatGridSkeleton, TableSkeleton } from "@/components/ui/Skeletons";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { BarList, DataGapNote, PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import {
  bandForScore,
  colors,
  fonts,
  layout as layoutTokens,
  severityColor,
} from "@/theme/tokens";
import { relativeTime } from "@/lib/format";
import type { ThreatActor } from "@/types";
import type { ThreatActorsResponse } from "@/types/dashboard";

const GENERIC = ["admin", "seller", "user", "vendor"];
const configuredRefreshMs = Number(
  process.env.NEXT_PUBLIC_DASHBOARD_REFRESH_MS ?? "300000",
);
const refreshIntervalMs =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs >= 30_000
    ? configuredRefreshMs
    : 300_000;

export default function ThreatActorsPage() {
  const { session, isLoading: isAuthLoading, isFleetScope } = useAuth();
  const [data, setData] = useState<ThreatActorsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal, background = false) => {
    if (!session || session.scope.kind !== "org") return;
    if (background) setIsRefreshing(true);

    const query = new URLSearchParams();
    if (session.user.role === "SUPER_ADMIN") {
      query.set("orgId", session.scope.orgId);
    }
    const url = query.size
      ? `/api/threat-actors?${query.toString()}`
      : "/api/threat-actors";

    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        signal,
      });
      const body = (await response.json()) as
        | ThreatActorsResponse
        | { error?: string };
      if (!response.ok || !("actors" in body) || !("summary" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Unable to load live threat-actor data.",
        );
      }
      if (
        body.scope.kind !== "org"
        || body.scope.orgId !== session.scope.orgId
      ) {
        throw new Error("The actor response did not match the selected organization.");
      }
      setData(body);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load live threat-actor data.",
      );
    } finally {
      if (background) setIsRefreshing(false);
    }
  }, [session]);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!session || session.scope.kind !== "org") {
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

  useEffect(() => {
    if (!data?.actors.length) {
      setSelectedKey(null);
      return;
    }
    if (!data.actors.some((actor) => actor.actorNodeKey === selectedKey)) {
      setSelectedKey(data.actors[0].actorNodeKey);
    }
  }, [data, selectedKey]);

  const actors = data?.actors ?? [];
  const selected = actors.find((actor) => actor.actorNodeKey === selectedKey)
    ?? actors[0]
    ?? null;
  const relativeNow = data ? Date.parse(data.fetchedAt) : Date.now();

  const columns = useMemo<ColDef<ThreatActor>[]>(() => [
    {
      headerName: "Alias",
      field: "actorName",
      minWidth: 150,
      cellRenderer: (params: ICellRendererParams<ThreatActor>) => {
        const generic = GENERIC.includes(String(params.value).toLowerCase());
        return (
          <Box sx={{ fontFamily: fonts.mono, fontSize: 12.5, color: generic ? colors.text3 : colors.ion }}>
            {params.value}
            {generic && (
              <Box component="span" sx={{ fontSize: 10, color: colors.text3 }}>
                {" "}(generic)
              </Box>
            )}
          </Box>
        );
      },
    },
    { headerName: "Claims", field: "totalClaimCount", minWidth: 92, maxWidth: 110 },
    {
      headerName: "Corroborated",
      field: "corroboratedClaimCount",
      minWidth: 118,
      maxWidth: 138,
      cellRenderer: (params: ICellRendererParams<ThreatActor>) => (
        <Box sx={{ fontFamily: fonts.mono, fontSize: 12, color: params.value ? colors.verified : colors.text3 }}>
          {params.value}
        </Box>
      ),
    },
    { headerName: "Markets", field: "marketplaceCount", minWidth: 92, maxWidth: 110 },
    {
      headerName: "Credibility",
      field: "credibilityScore",
      minWidth: 118,
      maxWidth: 138,
      cellRenderer: (params: ICellRendererParams<ThreatActor>) => (
        <SeverityChip band={bandForScore(params.value as number)} score={params.value as number} />
      ),
    },
    {
      headerName: "Last seen",
      field: "lastSeen",
      minWidth: 120,
      cellRenderer: (params: ICellRendererParams<ThreatActor>) => (
        <Box sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>
          {relativeTime(String(params.value), relativeNow)}
        </Box>
      ),
    },
  ], [relativeNow]);

  const highestScore = data?.summary.highestCredibilityScore ?? 0;
  const highestBand = bandForScore(highestScore) ?? "informational";
  const headerRight = (
    <Stack direction="row" gap={1} alignItems="center">
      {data && (
        <Typography sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.text3 }}>
          LIVE SNOWFLAKE · {new Date(data.fetchedAt).toLocaleString()}
        </Typography>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<RefreshCw size={13} />}
        disabled={!session || isFleetScope || isLoading || isRefreshing}
        onClick={() => void load(undefined, true)}
      >
        {isRefreshing ? "Refreshing" : "Refresh"}
      </Button>
    </Stack>
  );

  if (isAuthLoading || isLoading) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Threat Actors"
          subtitle="Credibility is computed from grounded claim evidence, not asserted."
          right={headerRight}
        />
        <StatGridSkeleton />
        <Panel><TableSkeleton rows={5} /></Panel>
      </Stack>
    );
  }

  if (!data) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Threat Actors"
          subtitle="Credibility is computed from grounded claim evidence, not asserted."
          right={headerRight}
        />
        <Panel>
          <Stack alignItems="center" gap={1} sx={{ py: 8 }}>
            <Typography sx={{ color: colors.text1 }}>
              {isFleetScope
                ? "Select one organization to view its isolated threat actors."
                : "Threat actor data is unavailable."}
            </Typography>
            {!isFleetScope && error && (
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
        height: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2 + 8}px)`,
      }}
    >
      <PageHeader
        title="Threat Actors"
        subtitle="Credibility is computed from grounded claim evidence, not asserted — every score component is visible."
        right={headerRight}
      />

      {error && (
        <DataGapNote>Refresh failed; showing the last successful Snowflake result.</DataGapNote>
      )}

      <StatGrid>
        <StatCard label="Actors observed" value={String(data.summary.actorCount)} />
        <StatCard
          label="Corroborated claims"
          value={String(data.summary.corroboratedClaimCount)}
          accent={colors.verified}
          valueColor={colors.verified}
        />
        <StatCard label="Marketplaces" value={String(data.summary.marketplaceCount)} />
        <StatCard
          label="Highest credibility"
          value={String(highestScore)}
          accent={severityColor[highestBand]}
          valueColor={severityColor[highestBand]}
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
          title="Actors targeting you"
          meta={`${actors.length} OBSERVED`}
          sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}
        >
          <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <DataTable<ThreatActor>
              rowData={actors}
              columnDefs={columns}
              getRowId={(params) => params.data.actorNodeKey}
              searchPlaceholder="Filter by alias or marketplace…"
              height="100%"
              rowStyle={{ cursor: "pointer" }}
              getRowClass={(params: RowClassParams<ThreatActor>) => {
                const band = bandForScore(params.data?.credibilityScore ?? 0);
                return band ? `row-${band}` : "";
              }}
              onRowClicked={(event) => event.data && setSelectedKey(event.data.actorNodeKey)}
            />
          </Box>
        </Panel>

        {selected ? (
          <Panel
            title={`${selected.actorName} · credibility breakdown`}
            sx={{ minHeight: 0, overflowY: "auto" }}
          >
            <BarList
              data={[
                {
                  label: <>Corroborated claims <Tag>max 45</Tag></>,
                  value: ((selected.corroborationComponent ?? 0) / 45) * 100,
                  display: `+${selected.corroborationComponent ?? 0}/45`,
                  color: colors.verified,
                },
                {
                  label: <>Self-evidenced claims <Tag>max 25</Tag></>,
                  value: ((selected.selfEvidenceComponent ?? 0) / 25) * 100,
                  display: `+${selected.selfEvidenceComponent ?? 0}/25`,
                  color: colors.verified,
                },
                {
                  label: <>Independent documents <Tag>max 20</Tag></>,
                  value: ((selected.independentHistoryComponent ?? 0) / 20) * 100,
                  display: `+${selected.independentHistoryComponent ?? 0}/20`,
                  color: colors.ion,
                },
                {
                  label: <>Claim history <Tag>max 10</Tag></>,
                  value: ((selected.claimHistoryComponent ?? 0) / 10) * 100,
                  display: `+${selected.claimHistoryComponent ?? 0}/10`,
                  color: colors.ion,
                },
                {
                  label: <>Actor-specific disputes <Tag>penalty 30</Tag></>,
                  value: ((selected.disputePenalty ?? 0) / 30) * 100,
                  display: `−${selected.disputePenalty ?? 0}/30`,
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
              <Typography sx={{ fontSize: 11, color: colors.text3 }}>
                / 100 evidence support
              </Typography>
            </Stack>
            <Typography sx={{ mt: 0.7, fontFamily: fonts.mono, fontSize: 9.5, color: colors.text3 }}>
              {selected.credibilityMethodVersion ?? "method unavailable"}
            </Typography>

            <Typography variant="overline" sx={{ display: "block", mt: 2.2, mb: 1 }}>
              Known venues
            </Typography>
            <Stack direction="row" gap={0.6} flexWrap="wrap">
              {selected.marketplaces.map((marketplace) => (
                <Tag key={marketplace}>{marketplace}</Tag>
              ))}
              {(selected.contactChannelCount ?? 0) > 0 && (
                <Tag>{selected.contactChannelCount} contact channel{selected.contactChannelCount === 1 ? "" : "s"} hidden</Tag>
              )}
              {selected.marketplaces.length === 0
                && (selected.contactChannelCount ?? 0) === 0 && (
                  <Typography sx={{ fontSize: 11, color: colors.text3 }}>none recorded</Typography>
                )}
            </Stack>
          </Panel>
        ) : (
          <Panel title="Credibility breakdown">
            <Typography sx={{ color: colors.text3, fontSize: 12 }}>
              No target-connected actor has reached L3 for this organization.
            </Typography>
          </Panel>
        )}
      </Box>
    </Stack>
  );
}

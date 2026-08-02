"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Box, Button, Stack, Typography } from "@mui/material";
import { Download } from "lucide-react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, RowClassParams } from "ag-grid-community";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { incidents } from "@/mocks/incidents";
import { DataTable } from "@/components/ui/DataTable";
import { Panel } from "@/components/ui/Panel";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import { colors, fonts, severityColor } from "@/theme/tokens";
import {
  formatCount,
  hostOf,
  leakTypeLabel,
  remediationLabel,
  remediationTone,
  routeLabel,
  routeTone,
} from "@/lib/format";
import type { BreachRecord } from "@/types";

type StatusFilter = "all" | "confirmed" | "ambiguous" | "other";

export default function BreachMonitorPage() {
  const router = useRouter();
  const params = useSearchParams();
  const gridRef = useRef<AgGridReact<BreachRecord>>(null);
  const { session, isFleetScope } = useAuth();

  const [status, setStatus] = useState<StatusFilter>("all");

  // The page is statically prerendered, so `useSearchParams()` is empty on the
  // first render and a useState initializer would capture "all" forever. Sync
  // from the URL after hydration so the sidebar's sub-menu links actually land
  // on their filter.
  useEffect(() => {
    const next = params.get("status");
    if (next === "confirmed" || next === "ambiguous" || next === "other") {
      setStatus(next);
    } else {
      setStatus("all");
    }
  }, [params]);

  const scoped = useMemo(() => {
    if (!session) return [];
    const orgId = scopeOrgId(session.scope);
    return orgId === null ? incidents : incidents.filter((i) => i.orgId === orgId);
  }, [session]);

  const rows = useMemo(() => {
    switch (status) {
      case "confirmed":
        return scoped.filter((i) => i.route === "target_confirmed");
      case "ambiguous":
        return scoped.filter((i) => i.route === "ambiguous");
      case "other":
        return scoped.filter((i) => i.route === "other_organization_confirmed");
      default:
        return scoped;
    }
  }, [scoped, status]);

  const confirmed = scoped.filter((i) => i.route === "target_confirmed");
  const totalRecords = confirmed.reduce((s, i) => s + (i.quantityClaimed ?? 0), 0);
  const dataClasses = new Set(confirmed.flatMap((i) => i.leakTypes)).size;
  const awaitingTriage = confirmed.filter((i) => i.remediationStatus === "new").length;

  const columns = useMemo<ColDef<BreachRecord>[]>(() => {
    const orgCol: ColDef<BreachRecord> = {
      headerName: "Organization",
      field: "organizationName",
      minWidth: 170,
      flex: 1.2,
      cellRenderer: (p: ICellRendererParams<BreachRecord>) => (
        <Stack sx={{ lineHeight: 1.35 }}>
          <Box sx={{ fontWeight: 600, fontSize: 12.5 }}>{p.data?.organizationName}</Box>
          <Box sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 10.5 }}>
            {p.data?.organizationDomain ?? "—"}
          </Box>
        </Stack>
      ),
    };

    const rest: ColDef<BreachRecord>[] = [
      {
        headerName: "Incident",
        field: "topTitle",
        minWidth: 260,
        flex: 2,
        cellRenderer: (p: ICellRendererParams<BreachRecord>) => (
          <Stack sx={{ lineHeight: 1.35, minWidth: 0 }}>
            <Box
              sx={{
                fontWeight: 600,
                fontSize: 12.5,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {p.data?.topTitle}
            </Box>
            <Box sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 10.5 }}>
              {p.data ? hostOf(p.data.topUrl) : ""}
            </Box>
          </Stack>
        ),
      },
      {
        headerName: "Discovered",
        field: "firstSeen",
        minWidth: 118,
        maxWidth: 132,
        valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : ""),
        cellStyle: { fontFamily: fonts.mono, fontSize: "11px", color: colors.text2 },
      },
      {
        headerName: "Status",
        field: "route",
        minWidth: 148,
        cellRenderer: (p: ICellRendererParams<BreachRecord>) =>
          p.data ? <Tag tone={routeTone[p.data.route]}>{routeLabel[p.data.route]}</Tag> : null,
      },
      {
        headerName: "Exposed data",
        field: "leakTypes",
        minWidth: 190,
        flex: 1.3,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<BreachRecord>) => {
          const types = p.data?.leakTypes ?? [];
          if (!types.length)
            return <Box sx={{ color: colors.text3, fontSize: 11 }}>none extracted</Box>;
          return (
            <Stack direction="row" gap={0.5} flexWrap="nowrap" sx={{ overflow: "hidden" }}>
              {types.slice(0, 2).map((t) => (
                <Tag key={t} tone={t === "credential" || t === "financial" ? "critical" : "neutral"}>
                  {leakTypeLabel[t]}
                </Tag>
              ))}
              {types.length > 2 && <Tag>+{types.length - 2}</Tag>}
            </Stack>
          );
        },
      },
      {
        headerName: "Records",
        field: "quantityClaimed",
        minWidth: 108,
        maxWidth: 128,
        cellRenderer: (p: ICellRendererParams<BreachRecord>) => (
          <Box
            sx={{
              fontFamily: fonts.mono,
              fontSize: 12,
              color: p.value === null ? colors.text3 : colors.text1,
            }}
          >
            {formatCount(p.value as number | null)}
          </Box>
        ),
      },
      {
        headerName: "Impact",
        field: "impactSeverityScore",
        minWidth: 104,
        maxWidth: 120,
        cellRenderer: (p: ICellRendererParams<BreachRecord>) => (
          <SeverityChip band={p.data?.impactSeverityBand ?? null} score={p.value as number} />
        ),
      },
      {
        headerName: "Confidence",
        field: "evidenceConfidenceScore",
        minWidth: 104,
        maxWidth: 122,
        cellRenderer: (p: ICellRendererParams<BreachRecord>) => (
          <Box
            sx={{
              fontFamily: fonts.mono,
              fontSize: 12,
              color: p.value === null ? colors.text3 : colors.verified,
            }}
          >
            {p.value ?? "—"}
          </Box>
        ),
      },
      {
        headerName: "Actor",
        field: "actorName",
        minWidth: 118,
        cellRenderer: (p: ICellRendererParams<BreachRecord>) => (
          <Box
            sx={{
              fontFamily: fonts.mono,
              fontSize: 11.5,
              color: p.value ? colors.ion : colors.text3,
            }}
          >
            {p.value ?? "unattributed"}
          </Box>
        ),
      },
      {
        headerName: "Workflow",
        field: "remediationStatus",
        minWidth: 130,
        cellRenderer: (p: ICellRendererParams<BreachRecord>) =>
          p.data ? (
            <Tag tone={remediationTone[p.data.remediationStatus]}>
              {remediationLabel[p.data.remediationStatus]}
            </Tag>
          ) : null,
      },
    ];

    return isFleetScope ? [orgCol, ...rest] : rest;
  }, [isFleetScope]);

  const getRowClass = useCallback((p: RowClassParams<BreachRecord>) => {
    const band = p.data?.impactSeverityBand;
    return band ? `row-${band}` : "row-informational";
  }, []);

  return (
    <Stack gap={2}>
      <PageHeader
        title="Breach Monitor"
        subtitle={
          isFleetScope
            ? "Confirmed leaks across every tenant."
            : "Confirmed leaks, plus the pages we refused to confirm and why."
        }
        right={
          <Button
            variant="outlined"
            size="small"
            startIcon={<Download size={14} />}
            onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: "nocturne-leaks.csv" })}
            sx={{ borderColor: colors.edgeHi, color: colors.ion }}
          >
            Export CSV
          </Button>
        }
      />

      <StatGrid>
        <StatCard label="Confirmed leaks" value={String(confirmed.length)} accent={severityColor.critical} />
        <StatCard label="Records claimed" value={totalRecords ? totalRecords.toLocaleString() : "—"} />
        <StatCard label="Exposed data classes" value={`${dataClasses}/5`} />
        <StatCard
          label="Awaiting triage"
          value={String(awaitingTriage)}
          accent={severityColor.high}
          valueColor={awaitingTriage ? severityColor.high : undefined}
        />
      </StatGrid>

      <Panel padded={false}>
        <Stack
          direction="row"
          gap={1}
          flexWrap="wrap"
          alignItems="center"
          sx={{ px: 2, py: 1.6, borderBottom: `1px solid ${colors.edge}` }}
        >
          {(
            [
              ["all", "All"],
              ["confirmed", "Confirmed yours"],
              ["ambiguous", "Needs review"],
              ["other", "Another company"],
            ] as [StatusFilter, string][]
          ).map(([key, label]) => (
            <Box
              key={key}
              component="button"
              type="button"
              onClick={() => setStatus(key)}
              sx={{
                px: 1.4,
                py: 0.6,
                cursor: "pointer",
                font: "inherit",
                fontSize: 11.5,
                borderRadius: "6px",
                color: status === key ? colors.ion : colors.text2,
                border: `1px solid ${status === key ? "rgba(34,211,238,0.35)" : colors.edge}`,
                backgroundColor: status === key ? "rgba(34,211,238,0.08)" : "transparent",
                "&:hover": { color: colors.text1 },
              }}
            >
              {label}
            </Box>
          ))}
          <Typography
            sx={{ ml: "auto", fontFamily: fonts.mono, fontSize: 11, color: colors.text3 }}
          >
            {rows.length} of {scoped.length} rows
          </Typography>
        </Stack>

        <Box sx={{ p: 2 }}>
          <DataTable<BreachRecord>
            gridRef={gridRef}
            rowData={rows}
            columnDefs={columns}
            getRowClass={getRowClass}
            getRowId={(p) => p.data.incidentKey}
            // Every row opens its detail page. Unconfirmed rows are the most
            // useful ones to inspect — the detail view explains why the
            // pipeline refused to confirm them.
            onRowClicked={(e) => {
              if (e.data) router.push(`/leaks/${e.data.incidentKey}`);
            }}
            searchPlaceholder="Filter by organization, actor, host…"
            rowStyle={{ cursor: "pointer" }}
            pagination
            paginationPageSize={20}
            height={520}
          />
        </Box>

        <Stack
          direction="row"
          gap={1}
          alignItems="flex-start"
          sx={{ px: 2, py: 1.6, borderTop: `1px solid ${colors.edge}` }}
        >
          <Typography sx={{ fontSize: 11, color: colors.text3, lineHeight: 1.6 }}>
            Rows without a score are kept deliberately. A page that named your organization but
            produced no grounded ownership evidence is <b>suppressed, not deleted</b> — the routing
            reason travels with it so you can audit why it stopped.
          </Typography>
        </Stack>
      </Panel>
    </Stack>
  );
}

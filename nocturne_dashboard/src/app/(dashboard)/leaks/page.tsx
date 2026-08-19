"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  Skeleton,
  Stack,
  Typography,
  alpha,
} from "@mui/material";
import { Download, Eye, RefreshCw, X } from "lucide-react";
import type { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, RowClassParams } from "ag-grid-community";
import { ExportEvidenceButton } from "@/components/triage/ExportEvidenceButton";
import { ReviewCapturePanel } from "@/components/triage/ReviewCapturePanel";
import { useAuth } from "@/contexts/AuthContext";
import { usePosture } from "@/contexts/PostureContext";
import { DataTable } from "@/components/ui/DataTable";
import { Panel } from "@/components/ui/Panel";
import { StatGridSkeleton, TableSkeleton } from "@/components/ui/Skeletons";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import { colors, fonts, layout, layout as layoutTokens, severityColor } from "@/theme/tokens";
import {
  formatCount,
  hostOf,
  leakTypeLabel,
  remediationLabel,
  remediationTone,
} from "@/lib/format";
import type {
  BreachMonitorRecord,
  BreachMonitorResponse,
  BreachMonitorStatus,
} from "@/types/dashboard";

type StatusFilter =
  | "all"
  | "confirmed"
  | "ambiguous"
  | "mitigated"
  | "dismissed"
  | "other";

const monitorStatusLabel: Record<BreachMonitorStatus, string> = {
  confirmed_yours: "Confirmed Breach",
  needs_review: "Needs Review",
  another_company: "Other Company Breach ",
  dismissed: "Dismissed",
};

const monitorStatusTone: Record<
  BreachMonitorStatus,
  "ok" | "medium" | "neutral"
> = {
  confirmed_yours: "ok",
  needs_review: "medium",
  another_company: "neutral",
  dismissed: "neutral",
};

const configuredRefreshMs = Number(
  process.env.NEXT_PUBLIC_DASHBOARD_REFRESH_MS ?? "300000",
);
const refreshIntervalMs =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs >= 30_000
    ? configuredRefreshMs
    : 300_000;

export default function BreachMonitorPage() {
  const router = useRouter();
  const params = useSearchParams();
  const gridRef = useRef<AgGridReact<BreachMonitorRecord>>(null);
  const { session, isFleetScope } = useAuth();
  const { fleetSelection } = usePosture();
  const canViewExternalContext = session?.user.role === "SUPER_ADMIN";

  const [status, setStatus] = useState<StatusFilter>("all");
  const [data, setData] = useState<BreachMonitorResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The row whose captured page is open for review. Needs-review rows have no
  // incident and therefore no detail page to navigate to, so the verdict is
  // taken here, over the capture.
  const [reviewRow, setReviewRow] = useState<BreachMonitorRecord | null>(null);

  const load = useCallback(async (signal?: AbortSignal, background = false) => {
    if (!session) return;
    if (background) setIsRefreshing(true);
    const query = new URLSearchParams();
    if (session.user.role === "SUPER_ADMIN" && session.scope.kind === "org") {
      query.set("orgId", session.scope.orgId);
    }
    // Fleet rows must honour the same tenant selection as the command centre,
    // or the two screens disagree about which tenants are in view.
    if (session.scope.kind === "fleet" && fleetSelection) {
      query.set("orgIds", fleetSelection.join(","));
    }
    const url = query.size
      ? `/api/breach-monitor?${query.toString()}`
      : "/api/breach-monitor";

    try {
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const body = (await response.json()) as
        | BreachMonitorResponse
        | { error?: string };
      if (!response.ok || !("rows" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Unable to load live breach-monitor data.",
        );
      }
      setData(body);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load live breach-monitor data.",
      );
    } finally {
      if (background) setIsRefreshing(false);
    }
  }, [session, fleetSelection]);

  // The page is statically prerendered, so `useSearchParams()` is empty on the
  // first render and a useState initializer would capture "all" forever. Sync
  // from the URL after hydration so the sidebar's sub-menu links actually land
  // on their filter.
  useEffect(() => {
    const next = params.get("status");
    if (
      next === "confirmed"
      || next === "ambiguous"
      || next === "mitigated"
      || next === "dismissed"
      || (next === "other" && canViewExternalContext)
    ) {
      setStatus(next);
    } else {
      setStatus("all");
    }
  }, [canViewExternalContext, params]);

  useEffect(() => {
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
  }, [load, session]);

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

  const scoped = visibleData?.rows ?? [];

  const rows = useMemo(() => {
    switch (status) {
      case "confirmed":
        return scoped.filter(
          (row) =>
            row.monitorStatus === "confirmed_yours"
            && row.remediationStatus !== "mitigated",
        );
      case "ambiguous":
        // A row someone has already handled is not still waiting for review, so
        // the queue that means "needs a decision" excludes mitigated rows.
        return scoped.filter(
          (row) =>
            row.monitorStatus === "needs_review"
            && row.remediationStatus !== "mitigated",
        );
      case "mitigated":
        return scoped.filter((row) => row.remediationStatus === "mitigated");
      case "dismissed":
        return scoped.filter((row) => row.monitorStatus === "dismissed");
      case "other":
        return canViewExternalContext
          ? scoped.filter((row) => row.monitorStatus === "another_company")
          : scoped;
      default:
        return scoped;
    }
  }, [canViewExternalContext, scoped, status]);

  const tabs = useMemo<[StatusFilter, string][]>(() => {
    const permittedTabs: [StatusFilter, string][] = [
      ["all", "All"],
      ["confirmed", "Confirmed Breach"],
      ["ambiguous", "Needs Review"],
      ["mitigated", "Mitigated"],
      ["dismissed", "Dismissed"],
    ];
    if (canViewExternalContext) {
      permittedTabs.push(["other", "Other Company Breach"]);
    }
    return permittedTabs;
  }, [canViewExternalContext]);

  const selectedMetrics = useMemo(() => {
    const confirmed = rows.filter(
      (row) => row.monitorStatus === "confirmed_yours",
    );
    const needsReview = rows.filter(
      (row) => row.monitorStatus === "needs_review",
    );
    const exposedDataClasses = new Set(
      confirmed.flatMap((row) => row.leakTypes),
    ).size;
    const recordsClaimed = confirmed.reduce(
      (total, row) => total + (row.quantityClaimed ?? 0),
      0,
    );

    if (status === "ambiguous") {
      return {
        primaryLabel: "Needs-review rows",
        primaryValue: needsReview.length,
        primaryAccent: severityColor.high,
        fourthLabel: "Stopped before incident",
        fourthValue: rows.filter((row) => !row.detailAvailable).length,
        fourthAccent: severityColor.high,
        recordsClaimed,
        exposedDataClasses,
      };
    }

    if (status === "mitigated") {
      return {
        primaryLabel: "Mitigated",
        primaryValue: rows.length,
        primaryAccent: colors.verified,
        fourthLabel: "Closed via Jira",
        fourthValue: rows.filter((row) => row.mitigatedBy?.startsWith("jira:")).length,
        fourthAccent: colors.ion,
        recordsClaimed,
        exposedDataClasses,
      };
    }

    if (status === "dismissed") {
      return {
        primaryLabel: "Dismissed after review",
        primaryValue: rows.length,
        primaryAccent: colors.text2,
        fourthLabel: "Ruled not a breach",
        fourthValue: rows.filter((row) => row.reviewDecision === "not_a_breach").length,
        fourthAccent: colors.text2,
        recordsClaimed,
        exposedDataClasses,
      };
    }

    if (status === "other") {
      return {
        primaryLabel: "External-context rows",
        primaryValue: rows.length,
        primaryAccent: colors.text2,
        fourthLabel: "Excluded from target alerts",
        fourthValue: rows.length,
        fourthAccent: colors.text2,
        recordsClaimed,
        exposedDataClasses,
      };
    }

    return {
      primaryLabel: "Confirmed Leaks",
      primaryValue: confirmed.length,
      primaryAccent: severityColor.critical,
      fourthLabel: status === "confirmed" ? "Detail Ready" : "Needs Review",
      fourthValue: status === "confirmed"
        ? confirmed.filter((row) => row.detailAvailable).length
        : needsReview.length,
      fourthAccent: status === "confirmed"
        ? colors.verified
        : severityColor.high,
      recordsClaimed,
      exposedDataClasses,
    };
  }, [rows, status]);

  const columns = useMemo<ColDef<BreachMonitorRecord>[]>(() => {
    const orgCol: ColDef<BreachMonitorRecord> = {
      headerName: "Organization",
      field: "organizationName",
      minWidth: 170,
      flex: 1.2,
      cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) => (
        <Stack sx={{ lineHeight: 1.35 }}>
          <Box sx={{ fontWeight: 600, fontSize: 12.5 }}>{p.data?.organizationName}</Box>
          <Box sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 10.5 }}>
            {p.data?.organizationDomain ?? "—"}
          </Box>
        </Stack>
      ),
    };

    const rest: ColDef<BreachMonitorRecord>[] = [
      {
        headerName: "Incident",
        field: "title",
        minWidth: 260,
        flex: 2,
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) => (
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
              {p.data?.title}
            </Box>
            <Box sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 10.5 }}>
              {p.data ? hostOf(p.data.url) : ""}
            </Box>
          </Stack>
        ),
      },
      {
        headerName: "Discovered",
        field: "discoveredAt",
        minWidth: 118,
        maxWidth: 132,
        valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : ""),
        cellStyle: { fontFamily: fonts.mono, fontSize: "11px", color: colors.text2 },
      },
      {
        headerName: "Status",
        field: "monitorStatus",
        minWidth: 148,
        // Tick "Confirmed yours", not "confirmed_yours".
        filterParams: { valueLabel: monitorStatusLabel },
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) =>
          p.data ? (
            <Box title={humanize(p.data.routingReason)}>
              <Tag tone={monitorStatusTone[p.data.monitorStatus]}>
                {monitorStatusLabel[p.data.monitorStatus]}
              </Tag>
            </Box>
          ) : null,
      },
      {
        headerName: "Exposed data",
        field: "leakTypes",
        minWidth: 190,
        flex: 1.3,
        sortable: false,
        filterParams: { valueLabel: leakTypeLabel },
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) => {
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
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) => (
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
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) => (
          <SeverityChip band={p.data?.impactSeverityBand ?? null} score={p.value as number} />
        ),
      },
      {
        headerName: "Confidence",
        field: "evidenceConfidenceScore",
        minWidth: 104,
        maxWidth: 122,
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) => (
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
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) => (
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
        minWidth: 140,
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) =>
          p.data ? (
            <Stack sx={{ lineHeight: 1.3 }}>
              <Box>
                <Tag tone={remediationTone[p.data.remediationStatus]}>
                  {remediationLabel[p.data.remediationStatus]}
                </Tag>
              </Box>
              {p.data.mitigatedAt && (
                <Box sx={{ color: colors.text3, fontSize: 9.5, fontFamily: fonts.mono }}>
                  {p.data.mitigatedAt.slice(0, 10)}
                  {p.data.mitigatedBy?.startsWith("jira:") ? " · jira" : ""}
                </Box>
              )}
            </Stack>
          ) : null,
      },
      {
        headerName: "Action",
        // Not backed by a field: this column is a control, so it neither sorts
        // nor filters, and the grid's search must not try to match against it.
        colId: "action",
        minWidth: 132,
        maxWidth: 150,
        sortable: false,
        filter: false,
        cellRenderer: (p: ICellRendererParams<BreachMonitorRecord>) => {
          const row = p.data;
          if (!row) return null;

          // A row that never became an incident has nothing to open, but it is
          // exactly the row an admin needs to look at — so it gets the capture
          // and the verdict instead of a dead link.
          if (!row.detailAvailable || !row.incidentKey) {
            if (row.monitorStatus === "another_company") return null;
            return (
              <Button
                size="small"
                variant="text"
                startIcon={<Eye size={13} />}
                onClick={(event) => {
                  event.stopPropagation();
                  setReviewRow(row);
                }}
                sx={{ fontSize: 11, color: colors.ion, px: 0.8 }}
              >
                {row.reviewDecision ? "View ruling" : "Review page"}
              </Button>
            );
          }

          return (
            <Button
              size="small"
              variant="text"
              onClick={(event) => {
                event.stopPropagation();
                router.push(`/leaks/${encodeURIComponent(row.incidentKey!)}`);
              }}
              sx={{ fontSize: 11, color: colors.ion, px: 0.8 }}
            >
              Open &amp; act
            </Button>
          );
        },
      },
    ];

    return isFleetScope ? [orgCol, ...rest] : rest;
  }, [isFleetScope, router]);

  const getRowClass = useCallback((p: RowClassParams<BreachMonitorRecord>) => {
    const band = p.data?.impactSeverityBand;
    return band ? `row-${band}` : "row-informational";
  }, []);

  // Fleet scope can take ~9s cold, so this placeholder is on screen long enough
  // to matter. Keep the heading real and mirror the grid's shape underneath.
  if (!visibleData && isLoading) {
    return (
      <Stack gap={2} sx={{ minHeight: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)`, pb: 1 }}>
        <PageHeader
          title="Breach Monitor"
        />
        <StatGridSkeleton cards={4} />
        <Panel padded={false}>
          <Box sx={{ px: 2, py: 1.6, borderBottom: `1px solid ${colors.edge}` }}>
            <Stack direction="row" gap={1}>
              {[92, 118, 104, 140].map((w) => (
                <Skeleton key={w} variant="rounded" width={w} height={26} sx={{ borderRadius: "6px" }} />
              ))}
            </Stack>
          </Box>
          <Box sx={{ p: 2 }}>
            <TableSkeleton rows={8} columns={6} />
          </Box>
        </Panel>
      </Stack>
    );
  }

  if (!visibleData) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Breach Monitor"
        />
        <Panel>
          <Stack alignItems="center" gap={1.5} sx={{ py: 6 }}>
            <Typography sx={{ color: colors.text1 }}>Breach Monitor unavailable</Typography>
            {error && (
              <Typography sx={{ color: colors.critical, fontSize: 12 }}>
                {error}
              </Typography>
            )}
            <Button size="small" onClick={() => void load(undefined, true)}>
              Retry
            </Button>
          </Stack>
        </Panel>
      </Stack>
    );
  }

  return (
    <Stack gap={2}>
      <PageHeader
        title="Breach Monitor"
        right={
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <Typography sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.verified }}>
              LIVE SNOWFLAKE · {formatTimestamp(visibleData.lastUpdatedAt)}
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RefreshCw size={13} />}
              disabled={isRefreshing}
              onClick={() => void load(undefined, true)}
            >
              {isRefreshing ? "Refreshing…" : "Refresh"}
            </Button>
            {/* Two exports, deliberately. This one is the grid as filtered on
                screen; the other is a period-scoped evidence artifact built
                server-side from Snowflake and independent of the view. */}
            <Button
              variant="outlined"
              size="small"
              startIcon={<Download size={14} />}
              onClick={() => gridRef.current?.api.exportDataAsCsv({ fileName: "nocturne-leaks.csv" })}
              sx={{ borderColor: colors.edgeHi, color: colors.ion }}
            >
              Export view
            </Button>
            <ExportEvidenceButton
              orgId={session?.scope.kind === "org" ? session.scope.orgId : null}
              label="Evidence report"
            />
          </Stack>
        }
      />

      {error && (
        <Box sx={{ color: colors.critical, fontSize: 11.5 }}>
          Refresh failed: {error}. Displaying the last successful response.
        </Box>
      )}

      <StatGrid>
        <StatCard
          label={selectedMetrics.primaryLabel}
          value={String(selectedMetrics.primaryValue)}
          accent={selectedMetrics.primaryAccent}
        />
        <StatCard
          label="Leaked Records Claimed"
          value={selectedMetrics.recordsClaimed
            ? selectedMetrics.recordsClaimed.toLocaleString()
            : "—"}
        />
        <StatCard
          label="Exposed Data Classes"
          value={`${selectedMetrics.exposedDataClasses}/5`}
        />
        <StatCard
          label={selectedMetrics.fourthLabel}
          value={String(selectedMetrics.fourthValue)}
          accent={selectedMetrics.fourthAccent}
          valueColor={selectedMetrics.fourthValue
            ? selectedMetrics.fourthAccent
            : undefined}
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
          {tabs.map(([key, label]) => (
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
                borderRadius: `${layout.radiusSm}px`,
                color: status === key ? colors.ion : colors.text2,
                border: `1px solid ${status === key ? alpha(colors.ion, 0.38) : colors.edge}`,
                backgroundColor: status === key ? alpha(colors.ion, 0.1) : "transparent",
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
          <DataTable<BreachMonitorRecord>
            gridRef={gridRef}
            rowData={rows}
            columnDefs={columns}
            getRowClass={getRowClass}
            getRowId={(p) => p.data.monitorKey}
            onRowClicked={(e) => {
              if (e.data?.detailAvailable && e.data.incidentKey) {
                router.push(`/leaks/${e.data.incidentKey}`);
              }
            }}
            searchPlaceholder="Filter by organization, actor, host…"
            getRowStyle={(p) => ({
              cursor: p.data?.detailAvailable ? "pointer" : "default",
            })}
            pagination
            paginationPageSize={10}
            paginationPageSizeSelector={[10, 20, 50, 100]}
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

      {/* Capture-and-rule for a row the cascade could not decide. Rendered as a
          dialog rather than a route because these rows have no incident key to
          hang a URL on. */}
      <Dialog
        open={reviewRow !== null}
        onClose={() => setReviewRow(null)}
        maxWidth="md"
        fullWidth
        scroll="paper"
      >
        <DialogTitle sx={{ fontSize: 15, pr: 6 }}>
          {reviewRow?.title}
          <IconButton
            aria-label="Close"
            onClick={() => setReviewRow(null)}
            sx={{ position: "absolute", right: 8, top: 8 }}
          >
            <X size={16} />
          </IconButton>
          <Typography sx={{ fontSize: 11.5, color: colors.text3, mt: 0.5 }}>
            {reviewRow && humanize(reviewRow.routingReason)}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          {reviewRow && (
            <ReviewCapturePanel
              orgId={reviewRow.orgId}
              monitorKey={reviewRow.monitorKey}
              url={reviewRow.url}
              decision={reviewRow.reviewDecision}
              decidedBy={reviewRow.reviewDecidedBy}
              canDecide={session?.user.role === "SUPER_ADMIN"}
              onDecided={() => {
                // Refresh rather than patching locally: the ruling changes the
                // row's effective status, which is computed in Snowflake.
                void load(undefined, true);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </Stack>
  );
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
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

"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Button, Snackbar, Stack, Switch, Typography } from "@mui/material";
import { Plus } from "lucide-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { useAuth } from "@/contexts/AuthContext";
import { organizations as seedOrganizations } from "@/mocks/organizations";
import { orgPostures } from "@/mocks/fleet";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/DataTable";
import { PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import { colors, fonts, severityColor } from "@/theme/tokens";
import { formatDate } from "@/lib/format";
import AdminOnly from "@/components/layout/AdminOnly";
import type { Organization } from "@/types";

export default function OrganizationsPage() {
  const router = useRouter();
  const { setScope } = useAuth();

  // Local working copy so the enable/disable switch is a real control. In the
  // live build this is a mutation against MONITORED_ORGANIZATIONS; the optimistic
  // update stays because the toggle has to feel instant.
  const [orgs, setOrgs] = useState<Organization[]>(seedOrganizations);
  const [toast, setToast] = useState<string | null>(null);

  const toggleOrg = useCallback((orgId: string) => {
    setOrgs((prev) => {
      const next = prev.map((o) =>
        o.orgId === orgId
          ? { ...o, enabled: !o.enabled, updatedAt: new Date().toISOString() }
          : o,
      );
      const changed = next.find((o) => o.orgId === orgId)!;
      setToast(
        `Monitoring ${changed.enabled ? "enabled" : "paused"} for ${changed.canonicalName}`,
      );
      return next;
    });
  }, []);

  const enabled = orgs.filter((o) => o.enabled).length;
  const totalDomains = orgs.reduce((s, o) => s + o.domains.length, 0);
  const withoutAliases = orgs.filter((o) => o.aliases.length === 0).length;

  const columns = useMemo<ColDef<Organization>[]>(
    () => [
      {
        headerName: "Org ID",
        field: "orgId",
        minWidth: 170,
        cellRenderer: (p: ICellRendererParams<Organization>) => (
          <Box sx={{ fontFamily: fonts.mono, fontSize: 11 }}>{p.value}</Box>
        ),
      },
      {
        headerName: "Canonical name",
        field: "canonicalName",
        minWidth: 190,
        cellRenderer: (p: ICellRendererParams<Organization>) => (
          <Box
            component="button"
            type="button"
            onClick={() => {
              if (!p.data) return;
              setScope({ kind: "org", orgId: p.data.orgId });
              router.push("/settings");
            }}
            sx={{
              border: 0,
              background: "none",
              p: 0,
              font: "inherit",
              fontSize: 12,
              fontWeight: 600,
              color: colors.ion,
              cursor: "pointer",
              textAlign: "left",
              "&:hover": { textDecoration: "underline" },
              "&:focus-visible": { outline: `2px solid ${colors.ion}`, outlineOffset: 2 },
            }}
          >
            {p.value}
          </Box>
        ),
      },
      {
        headerName: "Domains",
        field: "domains",
        minWidth: 210,
        flex: 1.4,
        // Flatten arrays so the quick filter can search inside them.
        valueGetter: (p) => (p.data?.domains ?? []).join(" "),
        cellRenderer: (p: ICellRendererParams<Organization>) => (
          <Stack direction="row" gap={0.5} flexWrap="nowrap" sx={{ overflow: "hidden" }}>
            {(p.data?.domains ?? []).map((d) => (
              <Tag key={d} tone="ok">
                {d}
              </Tag>
            ))}
          </Stack>
        ),
      },
      {
        headerName: "Aliases",
        field: "aliases",
        minWidth: 150,
        valueGetter: (p) => (p.data?.aliases ?? []).join(" "),
        cellRenderer: (p: ICellRendererParams<Organization>) => {
          const list = p.data?.aliases ?? [];
          if (!list.length) return <Box sx={{ color: colors.text3, fontSize: 11 }}>—</Box>;
          return (
            <Stack direction="row" gap={0.5} flexWrap="nowrap" sx={{ overflow: "hidden" }}>
              {list.map((a) => (
                <Tag key={a}>{a}</Tag>
              ))}
            </Stack>
          );
        },
      },
      {
        headerName: "Crawl",
        field: "crawlCadence",
        minWidth: 100,
        maxWidth: 120,
        cellRenderer: (p: ICellRendererParams<Organization>) => (
          <Box sx={{ fontFamily: fonts.mono, fontSize: 11, color: p.value ? colors.text2 : colors.text3 }}>
            {p.value ?? "paused"}
          </Box>
        ),
      },
      {
        headerName: "Updated",
        field: "updatedAt",
        minWidth: 110,
        maxWidth: 130,
        valueFormatter: (p) => (p.value ? formatDate(String(p.value)) : ""),
        cellStyle: { fontFamily: fonts.mono, fontSize: "11px", color: colors.text3 },
      },
      {
        headerName: "Monitoring",
        field: "enabled",
        minWidth: 130,
        maxWidth: 140,
        sortable: true,
        filter: false,
        cellRenderer: (p: ICellRendererParams<Organization>) => (
          <Stack direction="row" alignItems="center" gap={0.8}>
            <Switch
              checked={Boolean(p.value)}
              size="small"
              color="secondary"
              onChange={() => p.data && toggleOrg(p.data.orgId)}
              onClick={(e) => e.stopPropagation()}
              inputProps={{
                "aria-label": `Monitoring for ${p.data?.canonicalName ?? "organization"}`,
              }}
            />
            <Typography sx={{ fontSize: 11, color: p.value ? colors.verified : colors.text3 }}>
              {p.value ? "On" : "Paused"}
            </Typography>
          </Stack>
        ),
      },
    ],
    [toggleOrg],
  );

  return (
    <AdminOnly>
      <Stack gap={2}>
        <PageHeader
          title="Organizations"
          subtitle="Tenant identity and crawl configuration. These values drive ownership matching."
          right={
            <Button variant="contained" size="small" startIcon={<Plus size={14} />}>
              Add organization
            </Button>
          }
        />

        <StatGrid columns={3}>
          <StatCard
            label="Tenants configured"
            value={String(orgs.length)}
            sub={`${enabled} enabled · ${orgs.length - enabled} paused`}
          />
          <StatCard label="Domains monitored" value={String(totalDomains)} accent={colors.verified} />
          <StatCard
            label="Missing aliases"
            value={String(withoutAliases)}
            sub="weaker name matching"
            accent={severityColor.medium}
            valueColor={withoutAliases ? severityColor.medium : undefined}
          />
        </StatGrid>

        <Panel title="Monitored organizations" meta="NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS">
          <DataTable<Organization>
            rowData={orgs}
            columnDefs={columns}
            getRowId={(p) => p.data.orgId}
            searchPlaceholder="Filter by name, org id, domain, alias…"
            height={400}
            getRowClass={(p) => (p.data?.enabled ? "" : "row-informational")}
            // No row-click navigation here on purpose: this grid contains live
            // controls, and AG Grid's row listener is a native one that fires
            // before React's synthetic stopPropagation can cancel it — so a
            // click on the switch would also navigate. The name is the link.
          />
          <Typography sx={{ mt: 1.5, fontSize: 11, color: colors.text3, lineHeight: 1.6 }}>
            Select an organization name to edit its assets. Pausing a tenant stops new pages
            entering the pipeline; data already collected stays queryable.
          </Typography>
        </Panel>

        <Snackbar
          open={Boolean(toast)}
          autoHideDuration={2600}
          onClose={() => setToast(null)}
          message={toast}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        />
      </Stack>
    </AdminOnly>
  );
}

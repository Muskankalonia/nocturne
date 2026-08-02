"use client";

import { Box, Stack, Typography } from "@mui/material";
import type { ICellRendererParams } from "ag-grid-community";
import { findOrganization, users } from "@/mocks/organizations";
import { Panel } from "@/components/ui/Panel";
import { DataTable } from "@/components/ui/DataTable";
import { DataGapNote, PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import { colors, fonts, severityColor } from "@/theme/tokens";
import { relativeTime } from "@/lib/format";
import AdminOnly from "@/components/layout/AdminOnly";
import type { User } from "@/types";

const NOW = Date.parse("2026-08-01T16:05:00Z");

export default function UsersPage() {
  const admins = users.filter((u) => u.role === "SUPER_ADMIN").length;
  const neverSignedIn = users.filter((u) => !u.lastSignInAt).length;

  return (
    <AdminOnly>
      <Stack gap={2}>
        <PageHeader
          title="Users and Access"
          subtitle="Who can sign in, and which tenant each account is pinned to."
        />

        <StatGrid columns={3}>
          <StatCard label="Accounts" value={String(users.length)} />
          <StatCard
            label="Fleet administrators"
            value={String(admins)}
            sub="can read every tenant"
            accent={severityColor.critical}
            valueColor={severityColor.critical}
          />
          <StatCard
            label="Never signed in"
            value={String(neverSignedIn)}
            accent={severityColor.medium}
            valueColor={neverSignedIn ? severityColor.medium : undefined}
          />
        </StatGrid>

        <Panel title="Accounts" meta="APPLICATION DIRECTORY">
          <DataTable<User>
            rowData={users}
            getRowId={(p) => p.data.username}
            searchPlaceholder="Filter by username, organization, role…"
            height={330}
            getRowClass={(p) => (p.data?.role === "SUPER_ADMIN" ? "row-critical" : "")}
            columnDefs={[
              {
                headerName: "Username",
                field: "username",
                minWidth: 170,
                cellRenderer: (p: ICellRendererParams<User>) => (
                  <Box sx={{ fontFamily: fonts.mono, fontSize: 11 }}>{p.value}</Box>
                ),
              },
              { headerName: "Display name", field: "displayName", minWidth: 160 },
              {
                headerName: "Organization",
                field: "orgId",
                minWidth: 180,
                valueGetter: (p) =>
                  p.data?.role === "SUPER_ADMIN"
                    ? "All organizations"
                    : (findOrganization(p.data?.orgId ?? "")?.canonicalName ?? p.data?.orgId ?? ""),
                cellRenderer: (p: ICellRendererParams<User>) => (
                  <Box
                    sx={{
                      fontSize: 11.5,
                      color: p.data?.role === "SUPER_ADMIN" ? severityColor.critical : colors.text1,
                    }}
                  >
                    {p.value}
                  </Box>
                ),
              },
              {
                headerName: "Role",
                field: "role",
                minWidth: 150,
                cellRenderer: (p: ICellRendererParams<User>) => (
                  <Tag tone={p.value === "SUPER_ADMIN" ? "critical" : "ion"}>{p.value}</Tag>
                ),
              },
              {
                headerName: "Last sign-in",
                field: "lastSignInAt",
                minWidth: 130,
                cellRenderer: (p: ICellRendererParams<User>) => (
                  <Box
                    sx={{
                      fontFamily: fonts.mono,
                      fontSize: 11,
                      color: p.value ? colors.text2 : colors.text3,
                    }}
                  >
                    {p.value ? relativeTime(String(p.value), NOW) : "never"}
                  </Box>
                ),
              },
            ]}
          />
        </Panel>

        <Panel title="Authentication">
          <DataGapNote>
            <b>The current credential scheme is username = password, for demo only.</b> Replace it
            with real identity before anyone outside the team signs in. Independent of that: hiding
            the Fleet menu and locking the organization badge are conveniences, not access controls
            — the session must carry the tenant scope and every API route must filter on it. If a
            route ever trusts an organization id sent by the browser, any tenant can read any
            other tenant&apos;s breaches.
          </DataGapNote>
          <Stack gap={1} sx={{ mt: 2 }}>
            <Rule>ORG_USER → scope forced to their own organization, client input ignored</Rule>
            <Rule>SUPER_ADMIN → may narrow to one organization, or omit for fleet scope</Rule>
            <Rule>Every query filtered by the session scope, server-side, without exception</Rule>
          </Stack>
        </Panel>
      </Stack>
    </AdminOnly>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <Stack direction="row" gap={1.2} alignItems="flex-start">
      <Box sx={{ color: colors.verified, fontFamily: fonts.mono, fontSize: 12, mt: 0.1 }}>✓</Box>
      <Typography sx={{ fontSize: 12, color: colors.text2, lineHeight: 1.6 }}>{children}</Typography>
    </Stack>
  );
}


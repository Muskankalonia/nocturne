"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Checkbox,
  Divider,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import { BarChart3, Building2, ChevronDown, Lock } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { usePosture } from "@/contexts/PostureContext";
import GlobalSearch from "./GlobalSearch";
import { colors, fonts, gradients, layout, severityColor, shadows } from "@/theme/tokens";

/** Kept in step with DEMO_ORG_ID in src/server/demo-backend.ts. */
const DEMO_TENANT_ID = "demo_org";

export function Header() {
  const { isSuperAdmin, isFleetScope, activeOrg, switchableOrgs, setScope } = useAuth();
  const { summaryFor, organizations, isLoading, fleetSelection, setFleetSelection } =
    usePosture();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  // Enabled tenants per CONFIG.MONITORED_ORGANIZATIONS. Null until the first
  // response lands, so the roster length stands in rather than a flash of "0".
  const monitoredCount = isLoading && organizations.length === 0
    ? null
    : organizations.length;

  // Per-tenant triage summary so the switcher is itself a triage list. The
  // numbers come from the same live response the page renders; a tenant the
  // current scope excludes reports `hasData: false` and shows a dash instead of
  // a zero, which would read as "nothing wrong there".
  // A null selection means the server default, which is every tenant except
  // the fabricated demo one. Resolving that here keeps the checkboxes honest
  // about what the totals below them actually cover.
  const includedOrgIds = useMemo(() => {
    if (fleetSelection) return new Set(fleetSelection);
    return new Set(
      switchableOrgs.map((org) => org.orgId).filter((orgId) => orgId !== DEMO_TENANT_ID),
    );
  }, [fleetSelection, switchableOrgs]);
  const soleIncludedOrgId = includedOrgIds.size === 1
    ? [...includedOrgIds][0] ?? null
    : null;

  useEffect(() => {
    if (!isSuperAdmin || !isFleetScope || !soleIncludedOrgId) return;
    setScope({ kind: "org", orgId: soleIncludedOrgId });
  }, [isFleetScope, isSuperAdmin, setScope, soleIncludedOrgId]);

  const toggleOrg = (orgId: string) => {
    const next = new Set(includedOrgIds);
    if (next.has(orgId)) next.delete(orgId);
    else next.add(orgId);
    // Never leave the fleet view with nothing in it: an empty aggregate reads
    // as "no incidents" rather than "you deselected everything".
    if (next.size === 0) return;
    setFleetSelection([...next]);

    // Narrowing to a single tenant means "show me only this one", so move the
    // whole session into that scope. Knowledge Graph and Threat Actors are
    // single-organization screens by design — left in fleet scope they render
    // "select one organization" and the selection appears to do nothing.
    if (next.size === 1) setScope({ kind: "org", orgId: [...next][0]! });
    else if (!isFleetScope) setScope({ kind: "fleet" });
  };

  const orgSummaries = useMemo(
    () => switchableOrgs.map((org) => ({ org, ...summaryFor(org.orgId) })),
    [switchableOrgs, summaryFor],
  );

  return (
    <Stack
      component="header"
      direction="row"
      alignItems="center"
      gap={2}
      sx={{
        height: layout.headerHeight,
        px: `${layout.gutter}px`,
        flexShrink: 0,
        borderBottom: `1px solid ${colors.edge}`,
        backgroundImage: gradients.chrome,
        backdropFilter: "blur(20px)",
        position: "sticky",
        top: 0,
        zIndex: 15,
      }}
    >
      <GlobalSearch />

      <Box sx={{ ml: "auto" }} />

      {/* There was an "UPDATED 04:05 PM" clock here. It was a hardcoded string
        * — no caller ever passed a value — so it showed the same time on every
        * page, for every tenant, forever, beside a pulsing "live" dot. A stale
        * clock next to a live indicator is worse than no clock: the real
        * pipeline timestamp is on each page's heading, sourced from
        * VW_COMMAND_CENTER.LAST_UPDATED_AT, and that one moves. */}

      {/* org badge (locked) or switcher */}
      {isSuperAdmin ? (
        <>
          <Stack
            component="button"
            type="button"
            direction="row"
            alignItems="center"
            gap={1.1}
            onClick={(e) => setAnchorEl(e.currentTarget)}
            aria-haspopup="listbox"
            aria-expanded={Boolean(anchorEl)}
            sx={{
              px: 1.3,
              py: 0.65,
              cursor: "pointer",
              font: "inherit",
              fontSize: 12,
              color: colors.text1,
              borderRadius: `${layout.radiusSm}px`,
              border: `1px solid ${alpha(colors.ion, 0.35)}`,
              backgroundColor: alpha(colors.ion, 0.07),
              "&:hover": { backgroundColor: alpha(colors.ion, 0.13) },
              "&:focus-visible": {
                outline: `2px solid ${alpha(colors.ion, 0.7)}`,
                outlineOffset: 2,
              },
            }}
          >
            {isFleetScope ? (
              <BarChart3 size={13} color={colors.ion} />
            ) : (
              <Building2 size={13} color={colors.ion} />
            )}
            <Box component="span" sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
              {isFleetScope ? "All Organizations" : activeOrg?.canonicalName}
            </Box>
            <ChevronDown size={12} />
          </Stack>

          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={() => setAnchorEl(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
            slotProps={{
              paper: {
                sx: {
                  mt: 1,
                  width: 280,
                  backgroundColor: colors.hullHi,
                  border: `1px solid ${colors.edgeHi}`,
                  boxShadow: shadows.menu,
                },
              },
            }}
          >
            <MenuItem
              selected={isFleetScope}
              onClick={() => {
                setScope({ kind: "fleet" });
                setAnchorEl(null);
              }}
              sx={{ gap: 1.3, fontSize: 12, borderRadius: "7px", mx: 0.5 }}
            >
              <BarChart3 size={14} />
              All Organizations
              <Typography
                sx={{ ml: "auto", fontFamily: fonts.mono, fontSize: 10.5, color: colors.text3 }}
              >
                {/* The count Snowflake actually reports as enabled, not the
                  * length of the demo tenant roster. */}
                {includedOrgIds.size} of {switchableOrgs.length}
              </Typography>
            </MenuItem>

            <Stack
              direction="row"
              alignItems="center"
              justifyContent="space-between"
              sx={{ px: 1.6, pt: 0.4, pb: 0.2 }}
            >
              <Typography
                sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.text3 }}
              >
                INCLUDE IN FLEET TOTALS
              </Typography>
              <Box
                component="button"
                type="button"
                onClick={() => setFleetSelection(null)}
                sx={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  p: 0,
                  fontFamily: fonts.mono,
                  fontSize: 9.5,
                  color: colors.ion,
                  "&:hover": { textDecoration: "underline" },
                }}
              >
                RESET
              </Box>
            </Stack>

            <Divider sx={{ my: 0.7, borderColor: colors.edge }} />

            {orgSummaries.map(({ org, criticals, topScore, band, hasData }) => (
              <MenuItem
                key={org.orgId}
                selected={!isFleetScope && activeOrg?.orgId === org.orgId}
                onClick={() => {
                  setScope({ kind: "org", orgId: org.orgId });
                  setAnchorEl(null);
                }}
                sx={{ gap: 1.3, fontSize: 12, borderRadius: "7px", mx: 0.5 }}
              >
                {/* The checkbox includes a tenant in the fleet aggregate; the
                  * rest of the row still switches scope to it. Two actions in
                  * one row, so the checkbox stops its click from bubbling. */}
                <Checkbox
                  size="small"
                  checked={includedOrgIds.has(org.orgId)}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleOrg(org.orgId);
                  }}
                  inputProps={{ "aria-label": `Include ${org.canonicalName} in the fleet view` }}
                  sx={{ p: 0.2, color: colors.text3, "&.Mui-checked": { color: colors.ion } }}
                />
                <Box
                  component="span"
                  aria-label={
                    hasData ? `${criticals} critical` : "outside the current scope"
                  }
                  sx={{
                    fontFamily: fonts.mono,
                    fontSize: 10,
                    fontWeight: 600,
                    px: 0.7,
                    py: 0.15,
                    minWidth: 20,
                    textAlign: "center",
                    borderRadius: "4px",
                    color: hasData ? severityColor[band] : colors.text3,
                    backgroundColor: hasData
                      ? alpha(severityColor[band], 0.12)
                      : "transparent",
                    border: `1px solid ${
                      hasData ? alpha(severityColor[band], 0.3) : colors.edge
                    }`,
                  }}
                >
                  {hasData ? criticals : "—"}
                </Box>
                <Box component="span" sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {org.canonicalName}
                </Box>
                <Typography
                  sx={{
                    ml: "auto",
                    fontFamily: fonts.mono,
                    fontSize: 10.5,
                    color: hasData && topScore > 0 ? severityColor[band] : colors.text3,
                  }}
                >
                  {hasData && topScore > 0 ? topScore : "—"}
                </Typography>
              </MenuItem>
            ))}
          </Menu>
        </>
      ) : (
        <Tooltip title="Your session is scoped to this organization">
          <Stack
            direction="row"
            alignItems="center"
            gap={1.1}
            sx={{
              px: 1.3,
              py: 0.65,
              fontSize: 12,
              color: colors.text2,
              borderRadius: `${layout.radiusSm}px`,
              border: `1px solid ${colors.edge}`,
            }}
          >
            <Lock size={13} />
            <Box component="span" sx={{ color: colors.text1, fontWeight: 500, whiteSpace: "nowrap" }}>
              {activeOrg?.canonicalName}
            </Box>
          </Stack>
        </Tooltip>
      )}
    </Stack>
  );
}

export default Header;

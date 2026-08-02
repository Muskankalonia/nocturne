"use client";

import { useMemo, useState } from "react";
import {
  Box,
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
import GlobalSearch from "./GlobalSearch";
import { colors, fonts, gradients, layout, severityColor, shadows } from "@/theme/tokens";
import { incidents } from "@/mocks/incidents";
import type { SeverityBand } from "@/types";

export interface HeaderProps {
  lastUpdated?: string;
}

export function Header({ lastUpdated = "04:05 PM" }: HeaderProps) {
  const { isSuperAdmin, isFleetScope, activeOrg, switchableOrgs, setScope } = useAuth();
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

  // Per-tenant triage summary so the switcher is itself a triage list.
  const orgSummaries = useMemo(() => {
    return switchableOrgs.map((org) => {
      const rows = incidents.filter(
        (i) => i.orgId === org.orgId && i.triagePriorityScore !== null,
      );
      const criticals = rows.filter((i) => i.impactSeverityBand === "critical").length;
      const top = rows.reduce(
        (max, i) => Math.max(max, i.impactSeverityScore ?? 0),
        0,
      );
      const band: SeverityBand =
        top >= 80 ? "critical" : top >= 60 ? "high" : top >= 40 ? "medium" : "low";
      return { org, criticals, top, band };
    });
  }, [switchableOrgs]);

  const liveLabel = isFleetScope
    ? `${switchableOrgs.length} TENANTS LIVE`
    : "INGEST LIVE";

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

      {/* live indicator */}
      <Stack direction="row" alignItems="center" gap={0.9}>
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            backgroundColor: colors.verified,
            boxShadow: `0 0 10px ${colors.verified}`,
            animation: "nocturne-pulse 2.4s ease-in-out infinite",
            "@keyframes nocturne-pulse": {
              "0%,100%": { opacity: 1, transform: "scale(1)" },
              "50%": { opacity: 0.45, transform: "scale(0.82)" },
            },
            "@media (prefers-reduced-motion: reduce)": { animation: "none" },
          }}
        />
        <Typography
          sx={{
            fontFamily: fonts.mono,
            fontSize: 11,
            letterSpacing: "0.1em",
            color: colors.verified,
            whiteSpace: "nowrap",
          }}
        >
          {liveLabel}
        </Typography>
      </Stack>

      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 10.5,
          color: colors.text3,
          whiteSpace: "nowrap",
          display: { xs: "none", md: "block" },
        }}
      >
        UPDATED {lastUpdated}
      </Typography>

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
                {switchableOrgs.length} orgs
              </Typography>
            </MenuItem>

            <Divider sx={{ my: 0.7, borderColor: colors.edge }} />

            {orgSummaries.map(({ org, criticals, top, band }) => (
              <MenuItem
                key={org.orgId}
                selected={!isFleetScope && activeOrg?.orgId === org.orgId}
                onClick={() => {
                  setScope({ kind: "org", orgId: org.orgId });
                  setAnchorEl(null);
                }}
                sx={{ gap: 1.3, fontSize: 12, borderRadius: "7px", mx: 0.5 }}
              >
                <Box
                  component="span"
                  aria-label={`${criticals} critical`}
                  sx={{
                    fontFamily: fonts.mono,
                    fontSize: 10,
                    fontWeight: 600,
                    px: 0.7,
                    py: 0.15,
                    minWidth: 20,
                    textAlign: "center",
                    borderRadius: "4px",
                    color: severityColor[band],
                    backgroundColor: alpha(severityColor[band], 0.12),
                    border: `1px solid ${alpha(severityColor[band], 0.3)}`,
                  }}
                >
                  {criticals}
                </Box>
                <Box component="span" sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {org.canonicalName}
                </Box>
                <Typography
                  sx={{
                    ml: "auto",
                    fontFamily: fonts.mono,
                    fontSize: 10.5,
                    color: top > 0 ? severityColor[band] : colors.text3,
                  }}
                >
                  {top > 0 ? top : "—"}
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

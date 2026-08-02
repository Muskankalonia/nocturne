"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import NextLink from "next/link";
import {
  Box,
  Collapse,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  alpha,
} from "@mui/material";
import {
  Activity,
  BarChart3,
  Building2,
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Share2,
  ShieldAlert,
  UserSearch,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { navigationForRole, sectionLabels, sectionOrder } from "@/config/navigation";
import { colors, fonts, gradients, layout } from "@/theme/tokens";
import type { NavChild, NavItem, NavSection } from "@/types";

const icons: Record<string, LucideIcon> = {
  LayoutDashboard,
  BarChart3,
  Building2,
  Users,
  ShieldAlert,
  Share2,
  UserSearch,
  Activity,
  Settings,
};

const PIN_STORAGE_KEY = "nocturne.sidebar.pinned";

export interface SidebarProps {
  /** Live counts for nav badges, keyed by NavItem.badgeKey. */
  badges?: Partial<Record<"openCritical", number>>;
}

export function Sidebar({ badges }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isSuperAdmin, session, logout, isFleetScope, activeOrg, switchableOrgs } =
    useAuth();

  // Pinned state survives reload — a rail that recollapses the moment the
  // pointer leaves is infuriating when you are cross-referencing pages.
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setPinned(window.localStorage.getItem(PIN_STORAGE_KEY) === "true");
  }, []);

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      window.localStorage.setItem(PIN_STORAGE_KEY, String(!prev));
      return !prev;
    });
  }, []);

  const expanded = pinned || hovered;
  const items = useMemo(() => navigationForRole(isSuperAdmin), [isSuperAdmin]);

  /**
   * Sub-menu items under one parent frequently share a path and differ only by
   * query string (`/leaks?status=confirmed` vs `?status=ambiguous`), so
   * comparing paths alone lights up every sibling at once. A child is active
   * when the path matches *and* every parameter it pins matches the current
   * URL.
   *
   * `siblings` handles the default-view case: a bare `/graph` sits beside
   * `/graph?view=actors`, and pinning no parameters would otherwise make it
   * match everywhere. It stays inactive while any parameter its siblings use
   * is present.
   */
  const isChildHrefActive = useCallback(
    (href: string, siblings: NavChild[] = []) => {
      const [path, query = ""] = href.split("?");
      if (pathname !== path) return false;

      const required = new URLSearchParams(query);
      for (const [key, value] of required.entries()) {
        if (searchParams.get(key) !== value) return false;
      }

      if ([...required.keys()].length === 0) {
        for (const sibling of siblings) {
          const siblingQuery = sibling.href.split("?")[1];
          if (!siblingQuery) continue;
          for (const key of new URLSearchParams(siblingQuery).keys()) {
            if (searchParams.has(key)) return false;
          }
        }
      }
      return true;
    },
    [pathname, searchParams],
  );

  const isChildActive = useCallback(
    (item: NavItem) =>
      Boolean(item.children?.some((c) => isChildHrefActive(c.href, item.children))),
    [isChildHrefActive],
  );

  // Auto-open the group containing the current route.
  useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const item of items) {
      if (isChildActive(item)) next[item.id] = true;
    }
    setOpenGroups((prev) => ({ ...next, ...prev }));
  }, [items, isChildActive]);

  const isActive = (item: NavItem) =>
    item.href ? pathname === item.href : isChildActive(item);

  const handleItemClick = (item: NavItem) => {
    if (item.children?.length) {
      if (!expanded) {
        setPinned(true);
        window.localStorage.setItem(PIN_STORAGE_KEY, "true");
      }
      setOpenGroups((prev) => ({ ...prev, [item.id]: !prev[item.id] }));
      return;
    }
    if (item.href) router.push(item.href);
  };

  const grouped = sectionOrder
    .map((section) => ({
      section,
      label: sectionLabels[section],
      items: items.filter((i) => i.section === section),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <Box
      component="nav"
      aria-label="Main navigation"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      sx={{
        width: expanded ? layout.railExpanded : layout.railCollapsed,
        flexShrink: 0,
        borderRight: `1px solid ${colors.edge}`,
        backgroundImage: gradients.chrome,
        backdropFilter: "blur(20px)",
        display: "flex",
        flexDirection: "column",
        transition: "width 180ms ease",
        overflowX: "hidden",
        height: "100vh",
        position: "sticky",
        top: 0,
        zIndex: 20,
        "@media (prefers-reduced-motion: reduce)": { transition: "none" },
      }}
    >
      {/* brand + collapse toggle */}
      <Stack
        direction="row"
        alignItems="center"
        gap={1.2}
        sx={{ px: 1.4, height: layout.headerHeight, flexShrink: 0 }}
      >
        <Box
          component="img"
          src="/nocturne-mark.png"
          alt="Nocturne"
          width={24}
          height={24}
          sx={{
            flexShrink: 0,
            display: "block",
            // The rail is the one place the mark appears without the wordmark,
            // so it keeps the accent glow the old chrome had.
            filter: `drop-shadow(0 0 10px ${alpha(colors.ion, 0.45)})`,
          }}
        />
        {expanded && (
          <>
            <Typography
              sx={{ fontWeight: 600, fontSize: 13.5, letterSpacing: "0.02em", whiteSpace: "nowrap" }}
            >
              NOCTURNE
            </Typography>
            <Tooltip title={pinned ? "Unpin sidebar" : "Pin sidebar open"}>
              <IconButton size="small" onClick={togglePin} sx={{ ml: "auto", color: colors.text3 }}>
                <Menu size={15} />
              </IconButton>
            </Tooltip>
          </>
        )}
      </Stack>

      {/* fleet scope banner — admin only */}
      {expanded && isSuperAdmin && (
        <Box
          sx={{
            mx: 1.2,
            mb: 1,
            px: 1.2,
            py: 0.9,
            borderRadius: `${layout.radiusSm}px`,
            backgroundColor: alpha(colors.critical, 0.08),
            border: `1px solid ${alpha(colors.critical, 0.24)}`,
          }}
        >
          <Typography
            sx={{
              fontFamily: fonts.mono,
              fontSize: 8.5,
              letterSpacing: "0.13em",
              color: colors.critical,
            }}
          >
            SCOPE
          </Typography>
          <Typography sx={{ fontSize: 12, mt: 0.2, whiteSpace: "nowrap" }}>
            {isFleetScope
              ? `All Organizations · ${switchableOrgs.length}`
              : activeOrg?.canonicalName}
          </Typography>
        </Box>
      )}

      {/* nav tree */}
      <Box sx={{ flex: 1, overflowY: "auto", overflowX: "hidden", px: 1.2, pb: 1 }}>
        {grouped.map((group) => (
          <Box key={group.section}>
            {expanded && group.label && (
              <Typography
                sx={{
                  fontFamily: fonts.mono,
                  fontSize: 9,
                  letterSpacing: "0.15em",
                  textTransform: "uppercase",
                  color: group.section === "fleet" ? colors.critical : colors.text3,
                  px: 1,
                  pt: 1.8,
                  pb: 0.7,
                  whiteSpace: "nowrap",
                }}
              >
                {group.label}
              </Typography>
            )}
            {!expanded && group.section !== "main" && (
              <Divider sx={{ my: 1, borderColor: colors.edge }} />
            )}

            {group.items.map((item) => {
              const Icon = icons[item.icon] ?? LayoutDashboard;
              const active = isActive(item);
              const open = Boolean(openGroups[item.id]);
              const badge = item.badgeKey ? badges?.[item.badgeKey] : undefined;
              const isFleetItem = item.section === "fleet";
              const accent = isFleetItem ? colors.critical : colors.ion;

              const row = (
                <Box
                  component="button"
                  type="button"
                  onClick={() => handleItemClick(item)}
                  aria-expanded={item.children ? open : undefined}
                  aria-current={active && item.href ? "page" : undefined}
                  sx={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 1.4,
                    px: expanded ? 1.25 : 1.15,
                    py: 1,
                    mb: 0.3,
                    border: 0,
                    cursor: "pointer",
                    borderRadius: "8px",
                    font: "inherit",
                    fontSize: 12.5,
                    textAlign: "left",
                    justifyContent: expanded ? "flex-start" : "center",
                    color: active ? accent : colors.text2,
                    backgroundColor: active ? alpha(accent, 0.1) : "transparent",
                    boxShadow: active ? `inset 0 0 0 1px ${alpha(accent, 0.28)}` : "none",
                    transition: "background-color 140ms ease, color 140ms ease",
                    "&:hover": {
                      backgroundColor: active
                        ? alpha(accent, 0.14)
                        : "rgba(255,255,255,0.045)",
                      color: active ? accent : colors.text1,
                    },
                    "&:focus-visible": {
                      outline: `2px solid ${alpha(colors.ion, 0.7)}`,
                      outlineOffset: 2,
                    },
                    "@media (prefers-reduced-motion: reduce)": { transition: "none" },
                  }}
                >
                  <Icon size={16} style={{ flexShrink: 0 }} />
                  {expanded && (
                    <>
                      <Box component="span" sx={{ whiteSpace: "nowrap" }}>
                        {item.label}
                      </Box>
                      {badge !== undefined && badge > 0 && (
                        <Box
                          component="span"
                          sx={{
                            ml: "auto",
                            fontFamily: fonts.mono,
                            fontSize: 9.5,
                            px: 0.8,
                            borderRadius: "999px",
                            backgroundColor: alpha(colors.critical, 0.16),
                            color: colors.critical,
                            border: `1px solid ${alpha(colors.critical, 0.32)}`,
                          }}
                        >
                          {badge}
                        </Box>
                      )}
                      {item.children && (
                        <Box
                          component="span"
                          sx={{ ml: badge !== undefined && badge > 0 ? 0.6 : "auto", display: "flex", color: colors.text3 }}
                        >
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </Box>
                      )}
                    </>
                  )}
                </Box>
              );

              return (
                <Box key={item.id}>
                  {expanded ? row : <Tooltip title={item.label} placement="right">{row}</Tooltip>}

                  {item.children && expanded && (
                    <Collapse in={open} timeout={160} unmountOnExit>
                      <Stack
                        gap={0.2}
                        sx={{
                          ml: 2.4,
                          pl: 1.5,
                          mb: 0.6,
                          borderLeft: `1px solid ${
                            isFleetItem ? alpha(colors.critical, 0.3) : colors.edgeHi
                          }`,
                        }}
                      >
                        {item.children.map((child) => {
                          const childActive = isChildHrefActive(child.href, item.children);
                          return (
                            <Box
                              key={child.href}
                              component={NextLink}
                              href={child.href}
                              sx={{
                                display: "flex",
                                alignItems: "center",
                                gap: 1,
                                px: 1.25,
                                py: 0.75,
                                borderRadius: "6px",
                                fontSize: 12,
                                textDecoration: "none",
                                whiteSpace: "nowrap",
                                color: childActive ? accent : colors.text3,
                                backgroundColor: childActive
                                  ? alpha(accent, 0.08)
                                  : "transparent",
                                "&:hover": {
                                  color: colors.text1,
                                  backgroundColor: "rgba(255,255,255,0.04)",
                                },
                                "&:focus-visible": {
                                  outline: `2px solid ${alpha(colors.ion, 0.7)}`,
                                  outlineOffset: 2,
                                },
                              }}
                            >
                              <Box
                                component="span"
                                sx={{
                                  width: 4,
                                  height: 4,
                                  borderRadius: "50%",
                                  backgroundColor: "currentColor",
                                  opacity: 0.7,
                                  flexShrink: 0,
                                }}
                              />
                              {child.label}
                            </Box>
                          );
                        })}
                      </Stack>
                    </Collapse>
                  )}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>

      {/* user + sign out */}
      <Box sx={{ borderTop: `1px solid ${colors.edge}`, p: 1.2, flexShrink: 0 }}>
        <Stack direction="row" alignItems="center" gap={1.2} sx={{ px: 0.4, pb: expanded ? 1.2 : 0 }}>
          <Box
            sx={{
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              fontWeight: 600,
              border: `1px solid ${colors.edgeHi}`,
              background: isSuperAdmin
                ? "linear-gradient(135deg, #4A2440, #9C3A63)"
                : "linear-gradient(135deg, #16305C, #2F6BC4)",
              color: isSuperAdmin ? "#FFD7E3" : "#D6E6FF",
              letterSpacing: "0.02em",
            }}
          >
            {session?.user.initials}
          </Box>
          {expanded && (
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: 11.5, color: colors.text1, whiteSpace: "nowrap" }}>
                {session?.user.displayName}
              </Typography>
              <Typography
                sx={{
                  fontFamily: fonts.mono,
                  fontSize: 9.5,
                  color: isSuperAdmin ? colors.critical : colors.text3,
                  whiteSpace: "nowrap",
                }}
              >
                {isSuperAdmin ? "FLEET ACCESS" : "ORG ANALYST"}
              </Typography>
            </Box>
          )}
        </Stack>

        <Tooltip title={expanded ? "" : "Sign out"} placement="right">
          <Box
            component="button"
            type="button"
            onClick={logout}
            aria-label="Sign out"
            sx={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 1,
              px: 1.25,
              py: 0.85,
              cursor: "pointer",
              borderRadius: `${layout.radiusSm}px`,
              font: "inherit",
              fontSize: 11.5,
              // Neutral at rest — red is reserved for severity, and a
              // permanently-red control in the chrome dilutes it.
              color: colors.text2,
              border: `1px solid ${colors.edge}`,
              backgroundColor: "transparent",
              transition: "color 120ms ease, border-color 120ms ease, background-color 120ms ease",
              "&:hover": {
                color: colors.critical,
                borderColor: alpha(colors.critical, 0.35),
                backgroundColor: alpha(colors.critical, 0.09),
              },
              "&:focus-visible": {
                outline: `2px solid ${alpha(colors.critical, 0.7)}`,
                outlineOffset: 2,
              },
            }}
          >
            <LogOut size={14} style={{ flexShrink: 0 }} />
            {expanded && "Sign Out"}
          </Box>
        </Tooltip>
      </Box>
    </Box>
  );
}

export default Sidebar;

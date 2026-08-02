import type { NavItem, NavSection } from "@/types";

export const sectionLabels: Record<NavSection, string | null> = {
  main: null,
  fleet: "Fleet · admin only",
  intel: "Threat intelligence",
  ops: "Operations",
};

/**
 * One tree, filtered by role. The admin navigation is a superset rather than a
 * separate app — admins still drill into individual tenants constantly, so
 * duplicating the tree would double the component surface for no user benefit.
 */
export const navigation: NavItem[] = [
  {
    id: "command-center",
    label: "Command Center",
    icon: "LayoutDashboard",
    href: "/",
    section: "main",
  },

  /* ── admin only ────────────────────────────────────────────────────────── */
  {
    id: "fleet",
    label: "Fleet Command",
    icon: "BarChart3",
    adminOnly: true,
    section: "fleet",
    children: [
      { label: "Tenant leaderboard", href: "/admin/fleet" },
      { label: "Cross-tenant actors", href: "/admin/fleet/actors" },
      { label: "Fleet cost & usage", href: "/admin/fleet/cost" },
    ],
  },
  {
    id: "organizations",
    label: "Organizations",
    icon: "Building2",
    href: "/admin/organizations",
    adminOnly: true,
    section: "fleet",
  },
  {
    id: "users",
    label: "Users & access",
    icon: "Users",
    href: "/admin/users",
    adminOnly: true,
    section: "fleet",
  },

  /* ── shared ────────────────────────────────────────────────────────────── */
  {
    id: "breaches",
    label: "Breach Monitor",
    icon: "ShieldAlert",
    section: "intel",
    badgeKey: "openCritical",
    children: [
      { label: "Confirmed yours", href: "/leaks?status=confirmed" },
      { label: "Needs review", href: "/leaks?status=ambiguous" },
      { label: "Another company", href: "/leaks?status=other" },
    ],
  },
  {
    id: "graph",
    label: "Knowledge Graph",
    icon: "Share2",
    section: "intel",
    children: [
      { label: "Incident graph", href: "/graph" },
      { label: "Actor network", href: "/graph?view=actors" },
    ],
  },
  {
    id: "actors",
    label: "Threat Actors",
    icon: "UserSearch",
    href: "/actors",
    section: "intel",
  },
  {
    id: "pipeline",
    label: "Pipeline",
    icon: "Activity",
    section: "ops",
    children: [
      { label: "Detection cascade", href: "/pipeline" },
      { label: "Evidence quality", href: "/pipeline?tab=quality" },
      { label: "Processing health", href: "/pipeline?tab=health" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "Settings",
    href: "/settings",
    section: "ops",
  },
];

export function navigationForRole(isSuperAdmin: boolean): NavItem[] {
  return navigation.filter((item) => !item.adminOnly || isSuperAdmin);
}

/** Section render order. */
export const sectionOrder: NavSection[] = ["main", "fleet", "intel", "ops"];

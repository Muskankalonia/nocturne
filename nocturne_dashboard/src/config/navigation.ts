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
      { label: "Tenant Leaderboard", href: "/admin/fleet" },
      { label: "Cross-Tenant Actors", href: "/admin/fleet/actors" },
      { label: "Fleet Cost & Usage", href: "/admin/fleet/cost" },
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
      { label: "Confirmed Breach", href: "/leaks?status=confirmed" },
      { label: "Needs Review", href: "/leaks?status=ambiguous" },
      { label: "Other Company Breach", href: "/leaks?status=other" },
    ],
  },
  {
    // A second child, "Actor Network" → /graph?view=actors, used to sit here.
    // The graph page never read `view`, so both links rendered the identical
    // page. An actor-centred graph is a different query — alias across
    // incidents, venue and channel reuse — and needs an actor-scoped view
    // before it can exist. The actor story lives on /actors until then.
    id: "graph",
    label: "Knowledge Graph",
    icon: "Share2",
    section: "intel",
    href: "/graph",
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
      { label: "Detection Cascade", href: "/pipeline" },
      { label: "Evidence Quality", href: "/pipeline?tab=quality" },
      { label: "Processing Health", href: "/pipeline?tab=health" },
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
  return navigation
    .filter((item) => !item.adminOnly || isSuperAdmin)
    .map((item) => {
      if (isSuperAdmin || item.id !== "breaches" || !item.children) {
        return item;
      }

      return {
        ...item,
        children: item.children.filter(
          (child) => child.href !== "/leaks?status=other",
        ),
      };
    });
}

/** Section render order. */
export const sectionOrder: NavSection[] = ["main", "fleet", "intel", "ops"];

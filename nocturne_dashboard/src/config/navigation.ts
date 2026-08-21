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
      { label: "Mitigated", href: "/leaks?status=mitigated" },
      { label: "Dismissed", href: "/leaks?status=dismissed" },
      { label: "Other Company Breach", href: "/leaks?status=other" },
    ],
  },
  {
    id: "graph",
    label: "Knowledge Graph",
    icon: "Share2",
    section: "intel",
    children: [
      { label: "Incident Graph", href: "/graph" },
      { label: "Actor Network", href: "/graph?view=actors" },
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
      { label: "Run Live Leak Scan", href: "/pipeline/live-scan" },
      { label: "Upload Paste Dump", href: "/pipeline/upload" },
      { label: "Detection Cascade", href: "/pipeline" },
      { label: "Evidence Quality", href: "/pipeline?tab=quality" },
      { label: "Processing Health", href: "/pipeline?tab=health" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: "FileText",
    href: "/reports",
    section: "ops",
  },
  {
    id: "settings",
    label: "Settings",
    icon: "Settings",
    section: "ops",
    children: [
      { label: "Monitored Assets", href: "/settings" },
      { label: "Integrations", href: "/settings/integrations" },
    ],
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

import type { Organization, User } from "@/types";

/**
 * Tenants. Each `orgId` must match an ORG_ID row in
 * NOCTURNE.CONFIG.MONITORED_ORGANIZATIONS — the console resolves live data by
 * that key, so a tenant listed here without a matching Snowflake row signs in
 * to an empty dashboard.
 */
export const organizations: Organization[] = [
  {
    orgId: "european_commission",
    canonicalName: "European Commission",
    aliases: ["EC"],
    domains: ["europa.eu", "ec.europa.eu"],
    products: [],
    enabled: true,
    createdAt: "2026-08-02T09:00:00Z",
    updatedAt: "2026-08-05T11:20:00Z",
    crawlCadence: "6 h",
  },
  {
    orgId: "odido",
    canonicalName: "Odido",
    aliases: ["Ben.nl", "T-Mobile Netherlands"],
    domains: ["odido.nl", "ben.nl"],
    products: [],
    enabled: true,
    createdAt: "2026-08-02T09:00:00Z",
    updatedAt: "2026-08-05T09:14:00Z",
    crawlCadence: "6 h",
  },
  {
    orgId: "demo_org",
    canonicalName: "Demo Organization",
    aliases: ["Demo"],
    domains: ["demo-org.example"],
    products: [],
    enabled: true,
    createdAt: "2026-08-02T09:00:00Z",
    updatedAt: "2026-08-05T09:14:00Z",
    crawlCadence: "12 h",
  },
];

export function findOrganization(orgId: string): Organization | undefined {
  return organizations.find((o) => o.orgId === orgId);
}

const initialsFor = (name: string) =>
  name
    .replace(/[^A-Za-z ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "??";

/**
 * Demo user directory: one user per tenant, plus the fleet admin.
 * The password for each is the username plus NOCTURNE_DEMO_PASSWORD_SUFFIX.
 * See AuthContext for why this is demo-only and what has to replace it.
 */
export const users: User[] = [
  {
    username: "admin",
    displayName: "Super Admin",
    initials: "SA",
    role: "SUPER_ADMIN",
    orgId: null,
    lastSignInAt: "2026-08-01T16:05:00Z",
    // Directory defaults. A saved profile row in Snowflake overrides these.
    email: null,
    position: null,
  },
  ...organizations.map<User>((org) => ({
    username: org.orgId,
    displayName: `${org.canonicalName} Analyst`,
    initials: initialsFor(org.canonicalName),
    role: "ORG_USER" as const,
    orgId: org.orgId,
    lastSignInAt: null,
    email: null,
    position: null,
  })),
];

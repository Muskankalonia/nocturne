import type { Organization, User } from "@/types";

/**
 * Tenants. `palo_alto_networks` mirrors the row seeded by
 * snowflake/03_target_configuration.sql; the rest are demo tenants that let the
 * fleet views show something meaningful.
 */
export const organizations: Organization[] = [
  {
    orgId: "att",
    canonicalName: "AT&T",
    aliases: ["AT&T", "ATT"],
    domains: ["att.com"],
    products: [],
    enabled: true,
    createdAt: "2026-06-02T09:00:00Z",
    updatedAt: "2026-07-28T11:20:00Z",
    crawlCadence: "6 h",
  },
  {
    orgId: "palo_alto_networks",
    canonicalName: "Palo Alto Networks",
    aliases: ["PANW", "Palo Alto"],
    domains: ["paloaltonetworks.com", "panw.com"],
    products: ["GlobalProtect", "Cortex XDR", "Prisma"],
    enabled: true,
    createdAt: "2026-07-25T08:09:44Z",
    updatedAt: "2026-08-01T09:14:00Z",
    crawlCadence: "6 h",
  },
  {
    orgId: "bank_of_baroda",
    canonicalName: "Bank of Baroda",
    aliases: ["BOB"],
    domains: ["bankofbaroda.in"],
    products: [],
    enabled: true,
    createdAt: "2026-06-18T14:30:00Z",
    updatedAt: "2026-07-19T10:05:00Z",
    crawlCadence: "12 h",
  },
  {
    orgId: "contoso_logistics",
    canonicalName: "Contoso Logistics",
    aliases: ["Contoso"],
    domains: ["contoso.com"],
    products: [],
    enabled: true,
    createdAt: "2026-07-01T12:00:00Z",
    updatedAt: "2026-07-22T16:45:00Z",
    crawlCadence: "24 h",
  },
  {
    orgId: "northwind_traders",
    canonicalName: "Northwind Traders",
    aliases: [],
    domains: ["northwind.co"],
    products: [],
    enabled: false,
    createdAt: "2026-07-20T08:00:00Z",
    updatedAt: "2026-07-20T08:00:00Z",
    crawlCadence: null,
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
 * Username === orgId, password === orgId. See AuthContext for why this is
 * demo-only and what has to replace it.
 */
export const users: User[] = [
  {
    username: "admin",
    displayName: "Super Admin",
    initials: "SA",
    role: "SUPER_ADMIN",
    orgId: null,
    lastSignInAt: "2026-08-01T16:05:00Z",
  },
  ...organizations.map<User>((org) => ({
    username: org.orgId,
    displayName:
      org.orgId === "palo_alto_networks" ? "Kurt Meyers" : `${org.canonicalName} Analyst`,
    initials: org.orgId === "palo_alto_networks" ? "KM" : initialsFor(org.canonicalName),
    role: "ORG_USER" as const,
    orgId: org.orgId,
    lastSignInAt:
      org.orgId === "palo_alto_networks" ? "2026-08-01T15:53:00Z" : null,
  })),
];

import type { ThreatActor } from "@/types";

/**
 * SQL: DT_L3_ACTOR_CREDIBILITY.
 *
 * Credibility follows the weights in snowflake/12_dt_l3_knowledge_graph.sql:
 *   40 * min(1, corroborated/3) + 25 * min(1, marketplaces/3)
 * + 20 * min(1, docs/3) + 15 - 20 * min(1, disputed/2)
 *
 * Note `globalNodeKey` is null on every row: the pipeline bakes ORG_ID into
 * NODE_KEY, so the same alias seen for two tenants is two unjoinable nodes.
 * See docs/global-node-key.md. Cross-tenant correlation stays disabled until
 * that column exists rather than being faked here.
 */
export const actors: ThreatActor[] = [
  {
    actorNodeKey: "actor-nightfox-odido",
    globalNodeKey: null,
    orgId: "odido",
    actorName: "NightFox",
    totalClaimCount: 4,
    corroboratedClaimCount: 3,
    disputedClaimCount: 0,
    docCount: 3,
    sightingCount: 4,
    mirrorSightingCount: 1,
    marketplaceCount: 2,
    credibilityScore: 80,
    firstSeen: "2026-06-14T10:20:00Z",
    lastSeen: "2026-08-01T14:02:00Z",
    contactChannels: ["tox:8f2c…"],
    marketplaces: ["darkbay-market", "ghostforum-7x"],
  },
  {
    actorNodeKey: "actor-m0rpheus-odido",
    globalNodeKey: null,
    orgId: "odido",
    actorName: "m0rpheus",
    totalClaimCount: 3,
    corroboratedClaimCount: 2,
    disputedClaimCount: 0,
    docCount: 2,
    sightingCount: 3,
    mirrorSightingCount: 1,
    marketplaceCount: 1,
    credibilityScore: 71,
    firstSeen: "2026-07-02T08:00:00Z",
    lastSeen: "2026-07-31T22:14:00Z",
    contactChannels: ["session:4a91…"],
    marketplaces: ["darkbay-market"],
  },
  {
    actorNodeKey: "actor-vex-odido",
    globalNodeKey: null,
    orgId: "odido",
    actorName: "Vex_Trader",
    totalClaimCount: 2,
    corroboratedClaimCount: 0,
    disputedClaimCount: 0,
    docCount: 1,
    sightingCount: 2,
    mirrorSightingCount: 1,
    marketplaceCount: 1,
    credibilityScore: 54,
    firstSeen: "2026-07-18T12:40:00Z",
    lastSeen: "2026-07-30T08:41:00Z",
    contactChannels: [],
    marketplaces: ["ghostforum-7x"],
  },
  {
    actorNodeKey: "actor-generic-seller-odido",
    globalNodeKey: null,
    orgId: "odido",
    actorName: "seller",
    totalClaimCount: 1,
    corroboratedClaimCount: 0,
    disputedClaimCount: 1,
    docCount: 1,
    sightingCount: 1,
    mirrorSightingCount: 0,
    marketplaceCount: 1,
    credibilityScore: 22,
    firstSeen: "2026-07-26T19:05:00Z",
    lastSeen: "2026-07-26T19:05:00Z",
    contactChannels: [],
    marketplaces: ["leakchat-hub"],
  },
  {
    actorNodeKey: "actor-nightfox-euc",
    globalNodeKey: null,
    orgId: "european_commission",
    actorName: "NightFox",
    totalClaimCount: 6,
    corroboratedClaimCount: 4,
    disputedClaimCount: 0,
    docCount: 4,
    sightingCount: 6,
    mirrorSightingCount: 2,
    marketplaceCount: 3,
    credibilityScore: 88,
    firstSeen: "2026-06-28T09:12:00Z",
    lastSeen: "2026-08-01T15:44:00Z",
    contactChannels: ["tox:8f2c…"],
    marketplaces: ["darkbay-market", "ghostforum-7x", "leakchat-hub"],
  },
  {
    actorNodeKey: "actor-m0rpheus-euc",
    globalNodeKey: null,
    orgId: "european_commission",
    actorName: "m0rpheus",
    totalClaimCount: 3,
    corroboratedClaimCount: 2,
    disputedClaimCount: 0,
    docCount: 2,
    sightingCount: 3,
    mirrorSightingCount: 1,
    marketplaceCount: 2,
    credibilityScore: 71,
    firstSeen: "2026-07-11T16:00:00Z",
    lastSeen: "2026-08-01T02:10:00Z",
    contactChannels: ["session:4a91…"],
    marketplaces: ["darkbay-market", "ghostforum-7x"],
  },
  {
    actorNodeKey: "actor-nightfox-bob",
    globalNodeKey: null,
    orgId: "demo_org",
    actorName: "NightFox",
    totalClaimCount: 2,
    corroboratedClaimCount: 1,
    disputedClaimCount: 0,
    docCount: 1,
    sightingCount: 2,
    mirrorSightingCount: 1,
    marketplaceCount: 1,
    credibilityScore: 61,
    firstSeen: "2026-07-30T11:15:00Z",
    lastSeen: "2026-07-30T11:15:00Z",
    contactChannels: ["tox:8f2c…"],
    marketplaces: ["darkbay-market"],
  },
];

/**
 * What the fleet correlation table WOULD contain once GLOBAL_NODE_KEY exists.
 * Grouped here by display name purely so the admin page can demonstrate the
 * shape — the UI labels this clearly as requiring the pipeline change rather
 * than presenting it as live data.
 */
export interface CrossTenantActor {
  actorName: string;
  affectedOrgIds: string[];
  totalClaims: number;
  corroboratedClaims: number;
  marketplaceCount: number;
  maxCredibility: number;
  firstSeen: string;
  lastSeen: string;
}

export const crossTenantActors: CrossTenantActor[] = [
  {
    actorName: "NightFox",
    affectedOrgIds: ["odido", "european_commission", "demo_org"],
    totalClaims: 12,
    corroboratedClaims: 8,
    marketplaceCount: 3,
    maxCredibility: 88,
    firstSeen: "2026-06-14T10:20:00Z",
    lastSeen: "2026-08-01T15:44:00Z",
  },
  {
    actorName: "m0rpheus",
    affectedOrgIds: ["odido", "european_commission"],
    totalClaims: 6,
    corroboratedClaims: 4,
    marketplaceCount: 2,
    maxCredibility: 71,
    firstSeen: "2026-07-02T08:00:00Z",
    lastSeen: "2026-08-01T02:10:00Z",
  },
  {
    actorName: "Vex_Trader",
    affectedOrgIds: ["odido", "demo_org"],
    totalClaims: 4,
    corroboratedClaims: 1,
    marketplaceCount: 1,
    maxCredibility: 54,
    firstSeen: "2026-07-18T12:40:00Z",
    lastSeen: "2026-07-30T08:41:00Z",
  },
];

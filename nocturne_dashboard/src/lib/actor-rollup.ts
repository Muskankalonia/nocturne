import { hostOf } from "@/lib/format";
import type { DashboardIncident } from "@/types/dashboard";

/**
 * Threat actors folded out of the incidents the session can already see.
 *
 * The warehouse has a purpose-built table for this — `RAW.DT_L3_ACTOR_CREDIBILITY`,
 * which carries TOTAL_CLAIM_COUNT, CORROBORATED_CLAIM_COUNT, DISPUTED_CLAIM_COUNT,
 * DOC_COUNT and MARKETPLACE_COUNT per actor. None of it reaches the dashboard:
 * the UI contract is `NOCTURNE.DASHBOARD.*` and there is no actor view there
 * yet, so the console cannot read it without a new view.
 *
 * What travels on every incident row *is* real, including `ACTOR_CREDIBILITY_SCORE`
 * itself — L4 denormalizes the actor-level score onto each incident. So the
 * roster, the scores and the sighting evidence below are live. What cannot be
 * derived here is the score's own decomposition, because these are incident
 * counts and the formula takes claim counts. The page says so rather than
 * filling those bars with a plausible-looking guess.
 */
export interface ActorRollup {
  actorNodeKey: string;
  actorName: string;
  /** Tenants this actor appears in — one entry unless viewing at fleet scope. */
  orgIds: string[];
  organizationName: string;
  /** L4's actor-level credibility, carried on the incident row. */
  credibilityScore: number;
  incidentCount: number;
  /** Distinct CONTENT_SHA256 backing the claims — genuine corroboration. */
  corroboratingDocs: number;
  /** Distinct DEDUPE_KEY, mirrors included. */
  sightings: number;
  mirrorSightings: number;
  /** Onion hosts this actor was seen posting on. */
  venues: string[];
  topImpactScore: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Aliases too generic to be one person. The graph keys these per source page
 * and never merges them, so two unrelated sellers both calling themselves
 * "seller" stay two actors — this only flags them for the reader.
 */
const GENERIC_ALIASES = new Set(["admin", "seller", "user", "vendor", "support", "root"]);

export function isGenericAlias(actorName: string): boolean {
  return GENERIC_ALIASES.has(actorName.trim().toLowerCase());
}

export function rollUpActors(incidents: DashboardIncident[]): ActorRollup[] {
  const byActor = new Map<string, ActorRollup & { venueSet: Set<string>; orgSet: Set<string> }>();

  for (const incident of incidents) {
    if (!incident.actorName) continue;
    // Prefer the graph's node key; fall back to the name so an unkeyed actor
    // still groups instead of splitting into one row per incident.
    const key = incident.actorNodeKey ?? `name:${incident.actorName}`;

    const existing = byActor.get(key);
    const entry = existing ?? {
      actorNodeKey: key,
      actorName: incident.actorName,
      orgIds: [],
      organizationName: incident.organizationName,
      credibilityScore: 0,
      incidentCount: 0,
      corroboratingDocs: 0,
      sightings: 0,
      mirrorSightings: 0,
      venues: [],
      topImpactScore: 0,
      firstSeen: incident.firstSeen,
      lastSeen: incident.lastSeen,
      venueSet: new Set<string>(),
      orgSet: new Set<string>(),
    };

    // Credibility is an actor-level score repeated on each row, so max is the
    // value itself rather than an aggregate that could drift with incident count.
    //
    // Rounded because L3 computes it as a weighted sum of ratios and does not
    // round in SQL: the raw value arrives as e.g. 29.999985, and every other
    // 0-100 score in this console (impact, confidence, triage) is an integer.
    // Rounding once here keeps the grid cell, the severity chip and the headline
    // figure from disagreeing about the same score.
    entry.credibilityScore = Math.max(
      entry.credibilityScore,
      Math.round(incident.actorCredibilityScore ?? 0),
    );
    entry.incidentCount += 1;
    entry.corroboratingDocs += incident.corroborationCount;
    entry.sightings += incident.sightingCount;
    entry.mirrorSightings += incident.mirrorSightingCount;
    entry.topImpactScore = Math.max(
      entry.topImpactScore,
      Math.round(incident.impactSeverityScore ?? 0),
    );
    entry.venueSet.add(hostOf(incident.topUrl));
    entry.orgSet.add(incident.orgId);
    if (incident.firstSeen < entry.firstSeen) entry.firstSeen = incident.firstSeen;
    if (incident.lastSeen > entry.lastSeen) entry.lastSeen = incident.lastSeen;

    byActor.set(key, entry);
  }

  return [...byActor.values()]
    .map(({ venueSet, orgSet, ...actor }) => ({
      ...actor,
      venues: [...venueSet].sort(),
      orgIds: [...orgSet].sort(),
    }))
    .sort(
      (a, b) =>
        b.credibilityScore - a.credibilityScore
        || b.incidentCount - a.incidentCount
        || a.actorName.localeCompare(b.actorName),
    );
}

/**
 * The L3 credibility formula, verbatim from `12_dt_l3_knowledge_graph.sql`.
 * Rendered on the page so the score is auditable even while the component
 * inputs are not yet exposed to the console.
 */
export const CREDIBILITY_TERMS = [
  { label: "Corroborated claims", weight: 40, basis: "capped at 3", sign: "+" },
  { label: "Marketplaces", weight: 25, basis: "capped at 3", sign: "+" },
  { label: "Independent documents", weight: 20, basis: "capped at 3", sign: "+" },
  { label: "Base credibility", weight: 15, basis: "every observed actor", sign: "+" },
  { label: "Disputed claims", weight: 20, basis: "capped at 2", sign: "−" },
] as const;

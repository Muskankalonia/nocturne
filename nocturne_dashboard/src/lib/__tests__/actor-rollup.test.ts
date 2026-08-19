import { describe, expect, it } from "vitest";

import { CREDIBILITY_TERMS, isGenericAlias, rollUpActors } from "@/lib/actor-rollup";
import type { DashboardIncident } from "@/types/dashboard";

function incident(overrides: Partial<DashboardIncident> = {}): DashboardIncident {
  return {
    orgId: "acme_corp",
    organizationName: "Acme Corp",
    actorName: "nightfox",
    actorNodeKey: "actor:nightfox",
    actorCredibilityScore: 60,
    corroborationCount: 1,
    sightingCount: 1,
    mirrorSightingCount: 0,
    impactSeverityScore: 50,
    topUrl: "http://abcdefgh.onion/thread/1",
    firstSeen: "2026-08-05T00:00:00Z",
    lastSeen: "2026-08-06T00:00:00Z",
    ...overrides,
  } as unknown as DashboardIncident;
}

describe("isGenericAlias", () => {
  it("flags aliases too generic to be one person", () => {
    expect(isGenericAlias("admin")).toBe(true);
    expect(isGenericAlias("  Seller ")).toBe(true);
    expect(isGenericAlias("ROOT")).toBe(true);
  });

  it("leaves a real handle alone", () => {
    expect(isGenericAlias("nightfox")).toBe(false);
  });
});

describe("rollUpActors", () => {
  it("returns nothing for incidents with no actor", () => {
    expect(rollUpActors([incident({ actorName: null })])).toEqual([]);
    expect(rollUpActors([])).toEqual([]);
  });

  it("groups incidents by the graph node key", () => {
    const [actor] = rollUpActors([
      incident({ sightingCount: 2 }),
      incident({ sightingCount: 3, corroborationCount: 4 }),
    ]);
    expect(actor.incidentCount).toBe(2);
    expect(actor.sightings).toBe(5);
    expect(actor.corroboratingDocs).toBe(5);
  });

  it("falls back to the name so an unkeyed actor still groups", () => {
    // Without the fallback an actor with no node key splits into one row per
    // incident, which reads as several different people.
    const rolled = rollUpActors([
      incident({ actorNodeKey: null }),
      incident({ actorNodeKey: null }),
    ]);
    expect(rolled).toHaveLength(1);
    expect(rolled[0].actorNodeKey).toBe("name:nightfox");
  });

  it("keeps distinct actors apart", () => {
    const rolled = rollUpActors([
      incident({ actorName: "nightfox", actorNodeKey: "actor:nightfox" }),
      incident({ actorName: "shadowmint", actorNodeKey: "actor:shadowmint" }),
    ]);
    expect(rolled).toHaveLength(2);
  });

  it("takes credibility as a max and rounds it", () => {
    // L3 computes credibility as a weighted sum of ratios and does not round,
    // so the raw value arrives as e.g. 29.999985. Every other 0-100 score in
    // the console is an integer; rounding once here keeps them agreeing.
    const [actor] = rollUpActors([
      incident({ actorCredibilityScore: 29.999985 }),
      incident({ actorCredibilityScore: 12 }),
    ]);
    expect(actor.credibilityScore).toBe(30);
  });

  it("treats a missing credibility score as zero", () => {
    const [actor] = rollUpActors([incident({ actorCredibilityScore: null })]);
    expect(actor.credibilityScore).toBe(0);
  });

  it("takes the highest impact score across the actor's incidents", () => {
    const [actor] = rollUpActors([
      incident({ impactSeverityScore: 41.4 }),
      incident({ impactSeverityScore: 87 }),
    ]);
    expect(actor.topImpactScore).toBe(87);
  });

  it("collects distinct venues, sorted", () => {
    const [actor] = rollUpActors([
      incident({ topUrl: "http://zzz.onion/a" }),
      incident({ topUrl: "http://aaa.onion/b" }),
      incident({ topUrl: "http://zzz.onion/c" }),
    ]);
    expect(actor.venues).toEqual(["aaa.onion", "zzz.onion"]);
  });

  it("widens the first/last seen window across incidents", () => {
    const [actor] = rollUpActors([
      incident({ firstSeen: "2026-08-05T00:00:00Z", lastSeen: "2026-08-06T00:00:00Z" }),
      incident({ firstSeen: "2026-08-01T00:00:00Z", lastSeen: "2026-08-09T00:00:00Z" }),
    ]);
    expect(actor.firstSeen).toBe("2026-08-01T00:00:00Z");
    expect(actor.lastSeen).toBe("2026-08-09T00:00:00Z");
  });

  it("collects every tenant an actor appears in at fleet scope", () => {
    const [actor] = rollUpActors([
      incident({ orgId: "zeta_ltd" }),
      incident({ orgId: "acme_corp" }),
    ]);
    expect(actor.orgIds).toEqual(["acme_corp", "zeta_ltd"]);
  });

  it("sorts by credibility, then incident count, then name", () => {
    const rolled = rollUpActors([
      incident({ actorName: "low", actorNodeKey: "a:low", actorCredibilityScore: 10 }),
      incident({ actorName: "high", actorNodeKey: "a:high", actorCredibilityScore: 90 }),
      incident({ actorName: "mid", actorNodeKey: "a:mid", actorCredibilityScore: 50 }),
    ]);
    expect(rolled.map((actor) => actor.actorName)).toEqual(["high", "mid", "low"]);
  });

  it("breaks a credibility tie on incident count, then alphabetically", () => {
    const rolled = rollUpActors([
      incident({ actorName: "bravo", actorNodeKey: "a:bravo", actorCredibilityScore: 50 }),
      incident({ actorName: "alpha", actorNodeKey: "a:alpha", actorCredibilityScore: 50 }),
      incident({ actorName: "charlie", actorNodeKey: "a:charlie", actorCredibilityScore: 50 }),
      incident({ actorName: "charlie", actorNodeKey: "a:charlie", actorCredibilityScore: 50 }),
    ]);
    expect(rolled.map((actor) => actor.actorName)).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("does not leak its internal accumulator sets onto the result", () => {
    const [actor] = rollUpActors([incident()]);
    expect(actor).not.toHaveProperty("venueSet");
    expect(actor).not.toHaveProperty("orgSet");
  });
});

describe("CREDIBILITY_TERMS", () => {
  it("states the L3 formula with one negative term", () => {
    expect(CREDIBILITY_TERMS.filter((term) => term.sign === "−")).toHaveLength(1);
  });

  it("adds its positive weights to 100", () => {
    const positive = CREDIBILITY_TERMS
      .filter((term) => term.sign === "+")
      .reduce((total, term) => total + term.weight, 0);
    expect(positive).toBe(100);
  });
});

import type { BreachRecord, IncidentInsight, L2Route, LeakType, RelationshipLabel } from "@/types";

/**
 * Extra synthetic incidents for the demo tenant.
 *
 * The hand-written fixtures in src/mocks cover the interesting shapes — a
 * buried confirmed leak, an unverified boast, another company's data — but only
 * nine rows, which is under one page of the Breach Monitor grid. These fill the
 * grid out so pagination, filtering and the Needs Review tab all have something
 * to work with.
 *
 * Deliberately deterministic: no Math.random or Date.now. A demo that renumbers
 * itself between two screenshots is worse than no demo, and a stable set means
 * a walkthrough can name a specific row.
 */

interface Template {
  title: string;
  host: string;
  route: L2Route;
  relationship: RelationshipLabel;
  leakTypes: LeakType[];
  quantity: number | null;
  impact: number | null;
  confidence: number | null;
  actor: string | null;
  actorCredibility: number | null;
  day: number;
  reason: string;
}

const CONFIRMED: Template[] = [
  {
    title: "Customer billing export offered by a repeat seller",
    host: "darkbay-market.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["pii", "financial"], quantity: 240_000, impact: 88, confidence: 81,
    actor: "NightFox", actorCredibility: 80, day: 29,
    reason: "grounded_claim_affects_resolved_target",
  },
  {
    title: "Support desk mailbox archive with attachments",
    host: "ghostforum-7x.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["corporate_data", "pii"], quantity: 61_500, impact: 84, confidence: 77,
    actor: "m0rpheus", actorCredibility: 74, day: 28,
    reason: "grounded_claim_affects_resolved_target",
  },
  {
    title: "Source repository snapshot with embedded secrets",
    host: "leakchat-hub.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["credential", "corporate_data"], quantity: 3_400, impact: 81, confidence: 86,
    actor: "Vex_Trader", actorCredibility: 54, day: 27,
    reason: "grounded_claim_affects_resolved_target",
  },
  {
    title: "Partner portal accounts advertised with sample",
    host: "darkbay-market.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["credential"], quantity: 12_800, impact: 76, confidence: 72,
    actor: "NightFox", actorCredibility: 80, day: 26,
    reason: "grounded_claim_affects_resolved_target",
  },
  {
    title: "Employee payroll records listed in a bundle sale",
    host: "ghostforum-7x.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["pii", "financial"], quantity: 8_900, impact: 72, confidence: 65,
    actor: "unattributed", actorCredibility: null, day: 25,
    reason: "grounded_claim_affects_resolved_target",
  },
  {
    title: "Backup archive index naming internal hosts",
    host: "leakchat-hub.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["corporate_data"], quantity: null, impact: 64, confidence: 58,
    actor: "m0rpheus", actorCredibility: 74, day: 24,
    reason: "grounded_claim_affects_resolved_target",
  },
  {
    title: "Session tokens posted in a paste with partial redaction",
    host: "ghostforum-7x.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["credential"], quantity: 640, impact: 58, confidence: 69,
    actor: "Vex_Trader", actorCredibility: 54, day: 23,
    reason: "grounded_claim_affects_resolved_target",
  },
  {
    title: "Vendor invoice set with contact details attached",
    host: "darkbay-market.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["corporate_data", "pii"], quantity: 2_100, impact: 47, confidence: 55,
    actor: "unattributed", actorCredibility: null, day: 22,
    reason: "grounded_claim_affects_resolved_target",
  },
  {
    title: "Exploit kit advertised as tested against our stack",
    host: "leakchat-hub.onion", route: "target_confirmed", relationship: "target_data_leak",
    leakTypes: ["malware_exploit"], quantity: null, impact: 41, confidence: 44,
    actor: "NightFox", actorCredibility: 80, day: 21,
    reason: "grounded_claim_affects_resolved_target",
  },
];

const NEEDS_REVIEW: Template[] = [
  {
    title: "Forum thread naming the company with no data attached",
    host: "ghostforum-7x.onion", route: "ambiguous", relationship: "target_mentioned_no_leak",
    leakTypes: [], quantity: null, impact: null, confidence: null,
    actor: null, actorCredibility: null, day: 30,
    reason: "no_grounded_ownership_evidence",
  },
  {
    title: "Credential list where ownership could not be resolved",
    host: "darkbay-market.onion", route: "ambiguous", relationship: "target_data_leak",
    leakTypes: [], quantity: null, impact: null, confidence: null,
    actor: "unattributed", actorCredibility: null, day: 29,
    reason: "entity_match_below_threshold",
  },
  {
    title: "Screenshot claiming internal access, no verbatim quote found",
    host: "leakchat-hub.onion", route: "ambiguous", relationship: "target_data_leak",
    leakTypes: [], quantity: null, impact: null, confidence: null,
    actor: null, actorCredibility: null, day: 28,
    reason: "quote_not_found_in_source",
  },
  {
    title: "Brand mentioned in a generic phishing kit listing",
    host: "ghostforum-7x.onion", route: "ambiguous", relationship: "target_mentioned_no_leak",
    leakTypes: [], quantity: null, impact: null, confidence: null,
    actor: "Vex_Trader", actorCredibility: 54, day: 27,
    reason: "mention_without_leak_claim",
  },
  {
    title: "Recruiter database naming several employers at once",
    host: "darkbay-market.onion", route: "ambiguous", relationship: "target_mentioned_no_leak",
    leakTypes: [], quantity: null, impact: null, confidence: null,
    actor: null, actorCredibility: null, day: 26,
    reason: "ambiguous_multi_organization_claim",
  },
  {
    title: "Domain typosquat advertised for sale",
    host: "leakchat-hub.onion", route: "ambiguous", relationship: "target_mentioned_no_leak",
    leakTypes: [], quantity: null, impact: null, confidence: null,
    actor: null, actorCredibility: null, day: 25,
    reason: "mention_without_leak_claim",
  },
];

const OTHER_COMPANY: Template[] = [
  {
    title: "Retail chain loyalty records offered for sale",
    host: "darkbay-market.onion", route: "other_organization_confirmed",
    relationship: "other_organization_leak",
    leakTypes: [], quantity: null, impact: null, confidence: null,
    actor: "NightFox", actorCredibility: 80, day: 30,
    reason: "grounded_claim_affects_different_organization",
  },
  {
    title: "Regional bank statement dump, unrelated institution",
    host: "ghostforum-7x.onion", route: "other_organization_confirmed",
    relationship: "other_organization_leak",
    leakTypes: [], quantity: null, impact: null, confidence: null,
    actor: "m0rpheus", actorCredibility: 74, day: 28,
    reason: "grounded_claim_affects_different_organization",
  },
];

/** Stable pseudo-hash: same input always yields the same 64 hex characters. */
function fakeSha(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i += 1) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + seed.charCodeAt(i) + i, 0x85ebca6b) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    h1 = Math.imul(h1 ^ (h1 >>> 15), 0x2545f491) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x9e3779b1) >>> 0;
    out += h1.toString(16).padStart(8, "0");
    if (out.length < 64) out += h2.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

function bandFor(score: number | null): BreachRecord["impactSeverityBand"] {
  if (score === null) return null;
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  if (score >= 20) return "low";
  return "informational";
}

function confidenceBandFor(score: number | null): BreachRecord["evidenceConfidenceBand"] {
  if (score === null) return null;
  if (score >= 85) return "very_high";
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function build(t: Template, index: number, orgId: string, orgName: string, domain: string): BreachRecord {
  const key = fakeSha(`${orgId}:${t.title}:${index}`);
  const seen = `2026-07-${String(t.day).padStart(2, "0")}T09:${String((index * 7) % 60).padStart(2, "0")}:00Z`;
  const triage =
    t.impact === null || t.confidence === null
      ? null
      : Math.round(0.8 * t.impact + 0.2 * t.confidence);

  return {
    incidentKey: key,
    orgId,
    organizationName: orgName,
    organizationDomain: domain,
    contentSha256: fakeSha(`content:${key}`),
    topTitle: t.title,
    topUrl: `http://${t.host}/listing/${key.slice(0, 10)}`,
    source: index % 2 === 0 ? "ahmia" : "dread",
    route: t.route,
    routingReason: t.reason,
    relationshipLabel: t.relationship,
    leakTypes: t.leakTypes,
    quantityClaimed: t.quantity,
    impactSeverityScore: t.impact,
    impactSeverityBand: bandFor(t.impact),
    evidenceConfidenceScore: t.confidence,
    evidenceConfidenceBand: confidenceBandFor(t.confidence),
    triagePriorityScore: triage,
    triagePriorityBand: bandFor(triage),
    scoreVector: {
      dataSensitivity: t.impact ?? 0,
      exposureActionability: t.impact === null ? 0 : Math.min(100, t.impact + 6),
      recordScale: t.quantity ? Math.min(100, Math.round(12 * Math.log10(1 + t.quantity))) : 0,
      ownershipEvidence: t.confidence ?? 0,
      grounding: t.confidence === null ? 0 : Math.min(100, t.confidence + 10),
      claimProof: t.confidence ?? 0,
      corroboration: t.actor ? 70 : 40,
      actorCredibility: t.actorCredibility ?? 0,
      impactSeverity: t.impact ?? 0,
      evidenceConfidence: t.confidence ?? 0,
      triagePriority: triage ?? 0,
    },
    scoreReasons:
      t.route === "target_confirmed"
        ? t.quantity === null
          ? ["grounded_target_ownership_confirmed", "record_count_unknown_and_omitted"]
          : ["grounded_target_ownership_confirmed", "strong_exposed_material_present"]
        : ["single_distinct_content"],
    corroborationCount: t.actor ? 2 : 1,
    sightingCount: t.actor ? 3 : 1,
    mirrorSightingCount: t.actor ? 1 : 0,
    actorNodeKey: t.actor && t.actor !== "unattributed" ? `actor-${t.actor.toLowerCase()}-${orgId}` : null,
    actorName: t.actor,
    actorCredibilityScore: t.actorCredibility,
    groundingLevel: t.route === "target_confirmed" ? (index % 3 === 0 ? "normalized" : "exact") : null,
    firstSeen: seen,
    lastSeen: seen,
    remediationStatus: t.route === "target_confirmed" ? (index % 2 === 0 ? "new" : "investigating") : "new",
  };
}

export function extraDemoIncidents(
  orgId: string,
  orgName: string,
  domain: string,
): BreachRecord[] {
  return [...CONFIRMED, ...NEEDS_REVIEW, ...OTHER_COMPANY].map((t, i) =>
    build(t, i, orgId, orgName, domain),
  );
}

/** A minimal cached narrative so generated incidents open a usable detail page. */
export function extraDemoInsight(record: BreachRecord, orgName: string): IncidentInsight {
  const scored = record.impactSeverityScore !== null;
  return {
    orgId: record.orgId,
    incidentKey: record.incidentKey,
    status: "success",
    headline: scored
      ? `${record.topTitle} — attributed to ${orgName}`
      : `${record.topTitle} — ownership unresolved`,
    executiveSummary: scored
      ? `A dark-web listing on ${new URL(record.topUrl).host} advertises material attributed to ${orgName}. Ownership was established from configured assets and the supporting quote verified against the crawled page.`
      : `A page naming ${orgName} was found on ${new URL(record.topUrl).host}, but no claim could be tied to a configured asset. It is retained for audit rather than raised as an incident.`,
    whatHappened: scored
      ? `The seller published a listing describing ${record.leakTypes.join(", ") || "unspecified"} material${record.quantityClaimed ? `, stated as ${record.quantityClaimed.toLocaleString()} records` : ""}. The routing reason recorded was ${record.routingReason}.`
      : `The page mentioned the organization without asserting a leak of its data. Routing stopped with ${record.routingReason}.`,
    businessImpact: scored
      ? "Exposed material of this class supports account takeover and follow-on fraud. Treat the claimed volume as the seller's assertion rather than a verified count."
      : "No verified exposure. This row exists so the decision not to alert can be audited.",
    recommendedActions: scored
      ? [
          "Confirm whether the named assets are still in active use",
          "Rotate credentials associated with the affected system",
          "Check for reuse of the exposed material across other services",
        ]
      : ["Review the routing reason and adjust monitored assets if this should have matched"],
    confidenceAssessment: scored
      ? `Evidence confidence is ${record.evidenceConfidenceScore}. Ownership resolved from configured assets; grounding level ${record.groundingLevel}.`
      : "Not scored. Ownership was never established, so no severity was computed.",
    caveats: [
      "Synthetic demonstration record — not derived from a real crawl",
      "Claimed record counts are seller assertions, not verified figures",
    ],
    modelName: "claude-sonnet-4-5",
    promptVersion: "ai_complete_insight_v2",
    calledAt: record.firstSeen,
  };
}

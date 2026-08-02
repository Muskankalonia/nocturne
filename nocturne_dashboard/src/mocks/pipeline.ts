import type { CascadeStage, DataScope } from "@/types";

/**
 * Detection cascade. Plain-English labels with the engineering token kept as a
 * muted secondary — nobody outside the team knows what "L2" means, but analysts
 * and reviewers still want the mapping.
 *
 * `isBilled` drives the red treatment: the whole point of this chart is showing
 * which three stages cost money and how few pages reach them.
 */
export const orgCascade: CascadeStage[] = [
  { id: "collected", label: "Pages Collected", layerTag: null, count: 4812, isBilled: false, costTier: 0 },
  { id: "screened", label: "Screened for Signals", layerTag: "L0", count: 4712, isBilled: false, costTier: 0 },
  { id: "deduped", label: "Duplicates Removed", layerTag: null, count: 3196, isBilled: false, costTier: 0 },
  { id: "relevance", label: "Checked for Relevance", layerTag: "L1", count: 3196, isBilled: true, costTier: 2 },
  { id: "selected", label: "Selected for Deep Analysis", layerTag: null, count: 214, isBilled: false, costTier: 0 },
  { id: "extracted", label: "Evidence Extracted", layerTag: "L2", count: 214, isBilled: true, costTier: 3 },
  { id: "verified", label: "Ownership Verified", layerTag: null, count: 37, isBilled: false, costTier: 0 },
  { id: "classified", label: "Data Types Classified", layerTag: null, count: 37, isBilled: true, costTier: 2 },
  { id: "incidents", label: "Incidents Raised", layerTag: "L4", count: 23, isBilled: false, costTier: 0 },
];

export const fleetCascade: CascadeStage[] = [
  { id: "collected", label: "Pages Collected", layerTag: null, count: 34610, isBilled: false, costTier: 0 },
  { id: "screened", label: "Screened for Signals", layerTag: "L0", count: 33642, isBilled: false, costTier: 0 },
  { id: "deduped", label: "Duplicates Removed", layerTag: null, count: 22184, isBilled: false, costTier: 0 },
  { id: "relevance", label: "Checked for Relevance", layerTag: "L1", count: 22184, isBilled: true, costTier: 2 },
  { id: "selected", label: "Selected for Deep Analysis", layerTag: null, count: 1418, isBilled: false, costTier: 0 },
  { id: "extracted", label: "Evidence Extracted", layerTag: "L2", count: 1418, isBilled: true, costTier: 3 },
  { id: "verified", label: "Ownership Verified", layerTag: null, count: 271, isBilled: false, costTier: 0 },
  { id: "classified", label: "Data Types Classified", layerTag: null, count: 271, isBilled: true, costTier: 2 },
  { id: "incidents", label: "Incidents Raised", layerTag: "L4", count: 89, isBilled: false, costTier: 0 },
];

export function cascadeForScope(scope: DataScope): CascadeStage[] {
  return scope.kind === "fleet" ? fleetCascade : orgCascade;
}

export const groundingStats = {
  org: { rate: 94.2, exact: 81.4, normalized: 12.8, verified: 1284, quarantined: 79 },
  fleet: { rate: 93.1, exact: 79.8, normalized: 13.3, verified: 8917, quarantined: 612 },
};

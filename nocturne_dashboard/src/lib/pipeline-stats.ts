import type { CascadeStage } from "@/types";

/**
 * Headline numbers for the sign-in poster.
 *
 * These were previously typed into the poster as string literals, and had
 * drifted from the data they claimed to summarise: the copy advertised "6.7% of
 * pages" reaching the expensive model, but 6.7% is L2 over *relevance-checked*
 * pages (214/3196), not over pages collected (214/4812 = 4.4%). Deriving them
 * from the cascade is the only way the sentence and the arithmetic stay in
 * agreement, so the numbers live here and the poster renders whatever comes out.
 *
 * Everything below is a pure function of a `CascadeStage[]` plus grounding
 * counts. That is deliberate: the same call site works whether the stages come
 * from `@/mocks/pipeline` or from `NOCTURNE.DASHBOARD.VW_COMMAND_CENTER`, whose
 * columns map one-to-one onto the fields consumed here —
 * `PAGES_COLLECTED`, `PAGES_EVIDENCE_EXTRACTED`, `EXACT_GROUNDED_COUNT`,
 * `NORMALIZED_GROUNDED_COUNT` and `QUARANTINED_COUNT`.
 */

/**
 * The cascade's rungs. This is a structural fact about the pipeline — L0 regex
 * screening, L1 relevance, L2 extraction, L3 graph, L4 severity — not a
 * measurement, so it is a constant rather than something counted off the stage
 * list. (The stage list cannot supply it: L3 builds the graph and raises no
 * stage of its own, so counting `layerTag`s there yields 4, not 5.)
 */
export const CASCADE_LAYERS = ["L0", "L1", "L2", "L3", "L4"] as const;

export interface GroundingCounts {
  /** Claims whose evidence matched the source text — `exact` + `normalized`. */
  verified: number;
  /** Claims whose quoted evidence could not be located in the source. */
  quarantined: number;
}

export interface HeadlineStats {
  /** Share of extracted claims that matched their source verbatim. */
  groundedPct: number;
  /** Share of collected pages that reached the most expensive model. */
  expensiveModelPct: number;
  /** Rungs in the cascade. */
  layerCount: number;
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((1000 * numerator) / denominator) / 10;
}

export function headlineStats(
  cascade: CascadeStage[],
  grounding: GroundingCounts,
): HeadlineStats {
  // The first stage is everything the crawler landed, before any filtering.
  const collected = cascade[0]?.count ?? 0;

  // "Expensive" is whichever stage carries the top cost tier rather than a
  // hard-coded "L2", so re-tiering the cascade cannot silently invalidate the
  // claim on the poster.
  const peakTier = cascade.reduce((max, stage) => Math.max(max, stage.costTier), 0);
  const atPeakTier = cascade.find((stage) => stage.costTier === peakTier)?.count ?? 0;

  return {
    groundedPct: pct(grounding.verified, grounding.verified + grounding.quarantined),
    expensiveModelPct: pct(atPeakTier, collected),
    layerCount: CASCADE_LAYERS.length,
  };
}

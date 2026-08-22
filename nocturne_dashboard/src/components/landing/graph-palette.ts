import { colors } from "@/theme/tokens";

/**
 * Shared categorical colour for the two landing-page graphs, keyed by entity type.
 *
 * ── Why these five and not a rainbow ────────────────────────────────────────
 *
 * A node-link graph is an "all-pairs" form: any two nodes can end up adjacent,
 * so every pair must be distinguishable, not just neighbours in a legend. That
 * is a much harder test than a bar chart's, and it caps how many hues are
 * actually affordable. Five is what survived it here.
 *
 * Two hue families were off-limits before the search started, because this
 * product already spends them:
 *
 *   - red / orange / yellow at full chroma is the severity ramp (`critical`
 *     through `informational`). A bright orange node would read as "high".
 *   - `verified` green means grounded-verbatim and nothing else.
 *
 * So the warm slots here are deliberately muted and darkened well below the
 * severity ramp's brightness — #C97A28 next to `high` #FF9436, #C2447A next to
 * `critical` #FF4463. They sit in a different register, and neither graph
 * encodes severity at all.
 *
 * ── Validated, not eyeballed ────────────────────────────────────────────────
 *
 * Checked against the #0A1120 panel surface with all pairs compared, under
 * protanopia and deuteranopia at full severity:
 *
 *   lightness band   PASS  all 5 inside OKLCH L 0.48–0.67
 *   chroma floor     PASS  all 5 >= 0.10
 *   CVD separation   PASS  worst pair #C2447A ↔ #00A9A5  ΔE 8.5 (deutan)
 *   normal vision    PASS  worst pair #00A9A5 ↔ #4C8DFF  ΔE 17.7
 *   contrast         PASS  all 5 >= 3:1 on surface
 *
 * The violet is dark on purpose. At a lighter step it collapsed into the azure
 * under deuteranopia — ΔE 6.1, below the usable floor — and pushing its
 * lightness apart was the only fix that kept the hue.
 *
 * Colour is never the only cue: every node carries a text label, the org node
 * is larger and glows, and unresolved nodes are dashed as well as dimmed.
 */

export type GraphKind = "org" | "domain" | "claim" | "actor" | "market" | "asset";

export const graphColor: Record<GraphKind, string> = {
  /** The monitored target. Keeps `ion`, which already means "this is the one". */
  org: colors.ion,
  /** A domain is a property of the organization, so it stays in the org's hue. */
  domain: colors.ion,
  claim: "#8B3FD9",
  actor: "#C2447A",
  market: "#C97A28",
  asset: "#00A9A5",
};

/** Legend order. Fixed — never re-ordered per chart, or identity stops holding. */
export const GRAPH_LEGEND: Array<{ kind: GraphKind; label: string }> = [
  { kind: "org", label: "Monitored org" },
  { kind: "claim", label: "Leak claim" },
  { kind: "actor", label: "Threat actor" },
  { kind: "market", label: "Marketplace" },
  { kind: "asset", label: "Data asset" },
];

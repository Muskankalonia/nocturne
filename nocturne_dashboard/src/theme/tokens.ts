/**
 * Nocturne design tokens.
 *
 * Two rules govern colour use, and breaking them is what makes a security
 * console look like a game menu:
 *
 *   1. `ion` (cyan) means "interactive or selected". Nothing else.
 *   2. `verified` (green) means "grounded / verified verbatim". Nothing else.
 *
 * Everything else in the chrome stays muted slate so severity actually reads as
 * severity. Semantic severity colour is separate from the accent and is always
 * paired with a text label or shape — never colour alone.
 */

export const colors = {
  void: "#060A12",
  hull: "#0C1424",
  glass: "rgba(20,31,52,0.66)",
  glassHi: "rgba(30,45,74,0.72)",
  edge: "rgba(122,164,255,0.12)",
  edgeHi: "rgba(122,164,255,0.26)",

  /** Interaction + selection ONLY. */
  ion: "#22D3EE",
  ionDim: "#128FA8",
  /** Grounded / verified ONLY. */
  verified: "#4ADE80",

  critical: "#FF3B5C",
  high: "#FF8A3D",
  medium: "#FFC53D",
  low: "#38BDF8",
  informational: "#5A6B85",

  // Blue-biased neutrals — a chosen grey, not an inherited one.
  text1: "#E6EDF7",
  text2: "#94A6C2",
  text3: "#5C6E8C",
} as const;

export const severityColor = {
  critical: colors.critical,
  high: colors.high,
  medium: colors.medium,
  low: colors.low,
  informational: colors.informational,
} as const;

export const confidenceColor = {
  very_high: colors.verified,
  high: colors.verified,
  medium: colors.medium,
  low: colors.high,
} as const;

export const fonts = {
  sans: 'var(--font-sans), system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  /** Every hash, score, IP, offset and timestamp. This is the design's voice. */
  mono: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
} as const;

export const layout = {
  railCollapsed: 56,
  railExpanded: 236,
  headerHeight: 56,
  radius: 11,
  radiusSm: 7,
} as const;

/** Maps a 0-100 score to its band using the SQL thresholds in step 13. */
export function bandForScore(
  score: number | null | undefined,
): keyof typeof severityColor | null {
  if (score === null || score === undefined) return null;
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  if (score >= 20) return "low";
  return "informational";
}

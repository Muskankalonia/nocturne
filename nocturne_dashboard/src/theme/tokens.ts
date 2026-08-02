/**
 * Nocturne design tokens.
 *
 * Two rules govern colour use, and breaking them is what makes a security
 * console look like a game menu:
 *
 *   1. `ion` (azure) means "interactive or selected". Nothing else.
 *   2. `verified` (green) means "grounded / verified verbatim". Nothing else.
 *
 * Everything else in the chrome stays muted slate so severity actually reads as
 * severity. Semantic severity colour is separate from the accent and is always
 * paired with a text label or shape — never colour alone.
 *
 * The surface family is a blue-black ramp: `abyss` is the darkest point of the
 * page gradient, `void` the base plane, `hull` a raised plane, `glass` the
 * translucent panel fill that sits over both.
 */

export const colors = {
  /** Gradient floor — the darkest blue-black on the page. */
  abyss: "#02040A",
  void: "#04070E",
  hull: "#0A1120",
  hullHi: "#0E1729",
  glass: "rgba(15,25,44,0.72)",
  glassHi: "rgba(23,37,64,0.80)",
  edge: "rgba(104,146,224,0.13)",
  edgeHi: "rgba(104,146,224,0.30)",

  /** Interaction + selection ONLY. */
  ion: "#4C8DFF",
  ionDim: "#2563EB",
  ionBright: "#82B1FF",
  /** Grounded / verified ONLY. */
  verified: "#34D399",

  // Ordinal severity ramp. Validated on the #0A1120 panel surface: worst
  // adjacent pair ΔE 11.4 (deutan) / 16.0 (normal vision), all ≥ 3:1 contrast.
  // Always rendered with its text label — never colour alone.
  critical: "#FF4463",
  high: "#FF9436",
  medium: "#FFD84D",
  low: "#48A9F8",
  informational: "#61748F",

  // Blue-biased neutrals — a chosen grey, not an inherited one.
  text1: "#E8EEFA",
  text2: "#9BADC9",
  text3: "#61748F",
} as const;

/**
 * Page and surface gradients. Kept here rather than inline so the blue-black
 * ramp stays consistent across the shell, panels and the auth screen.
 */
export const gradients = {
  /** Full-page backdrop: blue-black, lit from the top-left. */
  page: [
    `radial-gradient(1100px 620px at 8% -10%, rgba(76,141,255,0.10), transparent 62%)`,
    `radial-gradient(900px 560px at 96% 0%, rgba(37,99,235,0.07), transparent 60%)`,
    `linear-gradient(168deg, #060B16 0%, #04070E 46%, #02040A 100%)`,
  ].join(","),
  /** Panel fill — a barely-there vertical lift so cards read as surfaces. */
  panel: `linear-gradient(180deg, rgba(26,42,72,0.50) 0%, rgba(13,22,40,0.62) 100%)`,
  /** Raised chrome: header, rail, menus. */
  chrome: `linear-gradient(180deg, rgba(11,18,33,0.92) 0%, rgba(6,11,21,0.94) 100%)`,
  /** Primary action. */
  action: `linear-gradient(180deg, #5B98FF 0%, #2563EB 100%)`,
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
  sans: 'var(--font-sans), "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  /** Every hash, score, IP, offset and timestamp. This is the design's voice. */
  mono: 'var(--font-mono), "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
} as const;

export const layout = {
  railCollapsed: 60,
  railExpanded: 248,
  headerHeight: 52,
  radius: 10,
  radiusSm: 6,
  /** Outer gutter for main content. Panels sit on this rhythm. */
  gutter: 20,
  /** Standard gap between panels in a grid. */
  gap: 14,
  /** Interior padding of a panel. */
  panelPad: 16,
} as const;

/** Elevation is carried by shadow + border, never by a lighter fill alone. */
export const shadows = {
  panel: "0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px -16px rgba(0,0,0,0.9)",
  raised: "0 18px 48px -20px rgba(0,0,0,0.95)",
  menu: "0 24px 64px -20px rgba(0,0,0,0.95)",
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

"use client";

import { Box, alpha } from "@mui/material";
import { colors, fonts, severityColor } from "@/theme/tokens";
import type { SeverityBand } from "@/types";

const labels: Record<SeverityBand, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Info",
};

export interface SeverityChipProps {
  band: SeverityBand | null;
  /** Show the numeric score instead of the band word. */
  score?: number | null;
  compact?: boolean;
}

/**
 * Severity is never colour alone — the chip always carries a word or a number
 * plus a filled marker, so it survives greyscale printing, a screenshot pasted
 * into a ticket, and colour-blind viewing.
 */
export function SeverityChip({ band, score, compact = false }: SeverityChipProps) {
  if (!band) {
    return (
      <Box
        component="span"
        sx={{
          fontFamily: fonts.mono,
          fontSize: 10,
          color: colors.text3,
          border: `1px solid ${colors.edge}`,
          borderRadius: "4px",
          px: 0.9,
          py: 0.3,
          display: "inline-flex",
        }}
      >
        —
      </Box>
    );
  }

  const c = severityColor[band];
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.75,
        fontFamily: fonts.mono,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        px: compact ? 0.7 : 1,
        py: 0.4,
        borderRadius: "4px",
        color: c,
        backgroundColor: alpha(c, 0.11),
        border: `1px solid ${alpha(c, 0.3)}`,
      }}
    >
      <Box
        component="span"
        sx={{
          width: 6,
          height: 6,
          borderRadius: "1px",
          backgroundColor: "currentColor",
          boxShadow: `0 0 8px currentColor`,
          flexShrink: 0,
        }}
      />
      {score !== undefined && score !== null ? score : labels[band]}
    </Box>
  );
}

export default SeverityChip;

"use client";

import { Box, Stack, Typography, alpha } from "@mui/material";
import { colors, fonts } from "@/theme/tokens";
import type { GroundingLevel } from "@/types";

const levelLabel: Record<GroundingLevel, string> = {
  exact: "Verified quote",
  normalized: "Verified · reformatted",
  unmatched: "Unverified — quarantined",
};

export interface EvidenceQuoteProps {
  /** Text immediately before the verified span. */
  before?: string;
  /** The span that verified verbatim against the source page. */
  highlight: string;
  /** Text immediately after. */
  after?: string;
  start?: number | null;
  end?: number | null;
  windowId?: string | null;
  level: GroundingLevel;
}

/**
 * The chain of custody, rendered. Offsets are computed by SQL via POSITION(),
 * never supplied by the model — a model-generated offset that looks
 * authoritative but is wrong is worse than no offset at all.
 */
export function EvidenceQuote({
  before,
  highlight,
  after,
  start,
  end,
  windowId,
  level,
}: EvidenceQuoteProps) {
  const ok = level !== "unmatched";
  const accent = ok ? colors.verified : colors.critical;

  return (
    <Box>
      <Box
        sx={{
          fontFamily: fonts.mono,
          fontSize: 12,
          lineHeight: 1.85,
          backgroundColor: "rgba(6,11,20,0.72)",
          border: `1px solid ${colors.edge}`,
          borderLeft: `2px solid ${accent}`,
          borderRadius: "7px",
          p: 1.7,
          color: colors.text2,
        }}
      >
        {before && <span>{before}</span>}
        <Box
          component="mark"
          sx={{
            backgroundColor: alpha(accent, 0.17),
            color: ok ? "#C9FBDC" : "#FFD3DC",
            px: 0.4,
            borderRadius: "3px",
            boxShadow: `0 0 0 1px ${alpha(accent, 0.32)}`,
          }}
        >
          {highlight}
        </Box>
        {after && <span>{after}</span>}
      </Box>

      <Stack direction="row" gap={2} flexWrap="wrap" sx={{ mt: 1.2 }}>
        {start !== null && start !== undefined && (
          <Meta k="evidence_start" v={String(start)} />
        )}
        {end !== null && end !== undefined && <Meta k="evidence_end" v={String(end)} />}
        {windowId && <Meta k="window" v={windowId} />}
        <Meta k="grounding" v={levelLabel[level]} color={accent} />
      </Stack>
    </Box>
  );
}

function Meta({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <Typography sx={{ fontFamily: fonts.mono, fontSize: 10, color: colors.text3 }}>
      {k}{" "}
      <Box component="b" sx={{ color: color ?? colors.text2 }}>
        {v}
      </Box>
    </Typography>
  );
}

export default EvidenceQuote;

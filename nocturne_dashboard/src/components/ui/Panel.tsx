"use client";

import type { ReactNode } from "react";
import { Box, Paper, Stack, Typography } from "@mui/material";
import { colors, fonts, layout } from "@/theme/tokens";

export interface PanelProps {
  title?: string;
  /** Engineering token shown as a muted tag beside the title, e.g. "L2". */
  layerTag?: string | null;
  meta?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}

export function Panel({ title, layerTag, meta, children, padded = true }: PanelProps) {
  const pad = `${layout.panelPad}px`;
  return (
    <Paper
      sx={{
        borderRadius: `${layout.radius}px`,
        p: padded ? pad : 0,
        minWidth: 0,
        // A hairline of light along the top edge — the cheapest way to make a
        // flat fill read as a physical surface.
        position: "relative",
        "&::before": {
          content: '""',
          position: "absolute",
          inset: "0 12px auto 12px",
          height: "1px",
          background: `linear-gradient(90deg, transparent, ${colors.edgeHi}, transparent)`,
          pointerEvents: "none",
        },
      }}
    >
      {(title || meta) && (
        <Stack
          direction="row"
          alignItems="center"
          gap={1.1}
          sx={{
            mb: 1.6,
            px: padded ? 0 : pad,
            pt: padded ? 0 : pad,
            minHeight: 18,
          }}
        >
          {title && (
            <Typography variant="overline" sx={{ color: colors.text2 }}>
              {title}
            </Typography>
          )}
          {layerTag && <LayerTag>{layerTag}</LayerTag>}
          {meta && (
            <Box sx={{ ml: "auto", fontFamily: fonts.mono, fontSize: 10, color: colors.text3 }}>
              {meta}
            </Box>
          )}
        </Stack>
      )}
      {children}
    </Paper>
  );
}

/** The muted engineering token that sits beside plain-English labels. */
export function LayerTag({ children }: { children: ReactNode }) {
  return (
    <Box
      component="span"
      sx={{
        fontFamily: fonts.mono,
        fontSize: 8.5,
        letterSpacing: "0.08em",
        color: colors.text3,
        border: `1px solid ${colors.edge}`,
        borderRadius: "3px",
        px: 0.5,
        lineHeight: 1.5,
        flexShrink: 0,
      }}
    >
      {children}
    </Box>
  );
}

export default Panel;

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
  return (
    <Paper sx={{ borderRadius: `${layout.radius}px`, p: padded ? 2 : 0, minWidth: 0 }}>
      {(title || meta) && (
        <Stack
          direction="row"
          alignItems="center"
          gap={1.2}
          sx={{ mb: 1.5, px: padded ? 0 : 2, pt: padded ? 0 : 2 }}
        >
          {title && (
            <Typography variant="overline" sx={{ color: colors.text2 }}>
              {title}
            </Typography>
          )}
          {layerTag && <LayerTag>{layerTag}</LayerTag>}
          {meta && (
            <Box sx={{ ml: "auto", fontFamily: fonts.mono, fontSize: 10.5, color: colors.text3 }}>
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

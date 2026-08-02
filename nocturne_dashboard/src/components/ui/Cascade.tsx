"use client";

import { Box, Stack, Typography, alpha } from "@mui/material";
import { colors, fonts } from "@/theme/tokens";
import { LayerTag } from "./Panel";
import type { CascadeStage } from "@/types";

const costLabel = ["$0", "$", "$$", "$$$"] as const;

/**
 * The signature visualization: how many pages each gate throws away, and which
 * three stages cost money. This is the product's argument against the
 * "send every page to an expensive model" baseline, in one chart.
 */
export function Cascade({ stages }: { stages: CascadeStage[] }) {
  const max = Math.max(...stages.map((s) => s.count), 1);

  return (
    <Stack gap={0.9}>
      {stages.map((stage) => {
        const pct = (stage.count / max) * 100;
        // Billed stages carry the cost warning; unbilled stages stay in the
        // blue-black chrome so the expensive steps are the only thing that pops.
        const fill = stage.isBilled
          ? stage.costTier === 3
            ? `linear-gradient(90deg, #6E1B32, ${colors.critical})`
            : `linear-gradient(90deg, #55223C, #B8365C)`
          : `linear-gradient(90deg, #16294A, #2E5C96)`;

        return (
          <Box
            key={stage.id}
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "120px 1fr 64px 44px", md: "200px 1fr 76px 52px" },
              alignItems: "center",
              gap: 1.2,
            }}
          >
            <Stack direction="row" alignItems="center" gap={0.7} sx={{ minWidth: 0 }}>
              <Typography
                sx={{
                  fontSize: 11.5,
                  color: stage.isBilled ? colors.text1 : colors.text2,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {stage.label}
              </Typography>
              {stage.layerTag && <LayerTag>{stage.layerTag}</LayerTag>}
            </Stack>

            <Box
              sx={{
                height: 20,
                borderRadius: "4px",
                backgroundColor: "rgba(255,255,255,0.035)",
                overflow: "hidden",
              }}
            >
              <Box
                sx={{
                  height: "100%",
                  width: `${Math.max(pct, 0.4)}%`,
                  borderRadius: "4px",
                  backgroundImage: fill,
                  boxShadow: stage.isBilled
                    ? `0 0 18px -6px ${alpha(colors.critical, 0.8)}`
                    : "none",
                }}
              />
            </Box>

            <Typography
              sx={{
                fontFamily: fonts.mono,
                fontSize: 12,
                textAlign: "right",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {stage.count.toLocaleString()}
            </Typography>

            <Typography
              sx={{
                fontFamily: fonts.mono,
                fontSize: 10,
                textAlign: "right",
                color: stage.isBilled ? colors.critical : colors.text3,
              }}
            >
              {costLabel[stage.costTier]}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}

export default Cascade;

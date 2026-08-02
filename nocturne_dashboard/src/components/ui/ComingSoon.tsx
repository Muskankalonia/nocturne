"use client";

import { Box, Stack, Typography } from "@mui/material";
import { Panel } from "./Panel";
import { colors, fonts } from "@/theme/tokens";

/**
 * Scaffolded route. Every nav destination resolves so the shell can be walked
 * end to end; these get replaced screen by screen.
 */
export function ComingSoon({
  title,
  route,
  summary,
  backing,
}: {
  title: string;
  route: string;
  summary: string;
  backing: string[];
}) {
  return (
    <Stack gap={2}>
      <Box>
        <Typography variant="h2">{title}</Typography>
        <Typography sx={{ color: colors.text2, fontSize: 13, mt: 0.3 }}>{summary}</Typography>
      </Box>
      <Panel title="Not built yet" meta={route}>
        <Typography sx={{ fontSize: 12.5, color: colors.text2, mb: 1.5 }}>
          Backed by these warehouse objects:
        </Typography>
        <Stack direction="row" gap={0.8} flexWrap="wrap">
          {backing.map((b) => (
            <Box
              key={b}
              component="span"
              sx={{
                fontFamily: fonts.mono,
                fontSize: 10.5,
                px: 1,
                py: 0.4,
                borderRadius: "4px",
                border: `1px solid ${colors.edge}`,
                color: colors.text2,
              }}
            >
              {b}
            </Box>
          ))}
        </Stack>
      </Panel>
    </Stack>
  );
}

export default ComingSoon;

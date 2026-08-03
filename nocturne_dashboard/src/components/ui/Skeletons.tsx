"use client";

import { Box, Skeleton, Stack } from "@mui/material";
import { Panel } from "@/components/ui/Panel";
import { StatGrid } from "@/components/ui/Primitives";
import { colors, layout } from "@/theme/tokens";

/**
 * Loading placeholders.
 *
 * The rule: skeleton the boxes that are waiting on data, never the whole page.
 * The rail, the header, the page title, the tab bar and the filter controls are
 * all known before the fetch resolves — blanking them out throws away
 * information the user already has and makes the app feel slower than it is.
 *
 * Each skeleton mirrors the shape and height of the real thing so the layout
 * does not jump when the data lands. That is the entire point; a generic grey
 * rectangle that resizes on arrival is worse than a spinner.
 */

/** One stat card: small label, big number, small caption. */
export function StatCardSkeleton() {
  return (
    <Box
      sx={{
        px: 2,
        py: 1.6,
        borderRadius: `${layout.radius}px`,
        border: `1px solid ${colors.edge}`,
        backgroundColor: "rgba(15,25,44,0.45)",
      }}
    >
      <Skeleton variant="text" width="62%" height={12} />
      <Skeleton variant="text" width="45%" height={34} sx={{ my: 0.4 }} />
      <Skeleton variant="text" width="78%" height={11} />
    </Box>
  );
}

export function StatGridSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <StatGrid>
      {Array.from({ length: cards }, (_, i) => (
        <StatCardSkeleton key={i} />
      ))}
    </StatGrid>
  );
}

/**
 * A table placeholder: header rule plus evenly spaced row bars. `rows` should
 * match what the grid usually returns so the panel does not resize.
 */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  const widths = ["24%", "18%", "16%", "14%", "12%", "10%"];
  return (
    <Box>
      <Stack
        direction="row"
        gap={2}
        sx={{ pb: 1.2, mb: 1.2, borderBottom: `1px solid ${colors.edge}` }}
      >
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} variant="text" height={10} sx={{ width: widths[i % widths.length] }} />
        ))}
      </Stack>
      <Stack gap={1.4}>
        {Array.from({ length: rows }, (_, r) => (
          <Stack key={r} direction="row" gap={2} alignItems="center">
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton
                key={c}
                variant="rounded"
                height={c === 0 ? 16 : 12}
                sx={{ width: widths[c % widths.length], borderRadius: "4px" }}
              />
            ))}
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

/** Label + bar rows, matching Cascade and BarList. */
export function BarListSkeleton({ rows = 5 }: { rows?: number }) {
  // Descending widths read as a distribution rather than a stack of identical
  // blocks, which is what the real chart almost always looks like.
  const fill = [88, 62, 44, 30, 18, 12, 9, 6, 4];
  return (
    <Stack gap={1.6}>
      {Array.from({ length: rows }, (_, i) => (
        <Box key={i}>
          <Skeleton variant="text" width={`${34 - i * 2}%`} height={11} />
          <Skeleton
            variant="rounded"
            height={6}
            sx={{ mt: 0.6, width: `${fill[i % fill.length]}%`, borderRadius: "3px" }}
          />
        </Box>
      ))}
    </Stack>
  );
}

/** A block placeholder for canvas/SVG surfaces that have no internal structure. */
export function CanvasSkeleton({ height = 420 }: { height?: number | string }) {
  return (
    <Stack alignItems="center" justifyContent="center" sx={{ height, p: 2 }}>
      <Skeleton
        variant="rounded"
        sx={{ width: "100%", height: "100%", borderRadius: `${layout.radius}px` }}
      />
    </Stack>
  );
}

/** Paragraph placeholder for prose panels — AI narrative, summaries, notes. */
export function TextBlockSkeleton({ lines = 4 }: { lines?: number }) {
  const widths = ["96%", "88%", "92%", "64%", "80%", "72%"];
  return (
    <Stack gap={0.9}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} variant="text" height={12} sx={{ width: widths[i % widths.length] }} />
      ))}
    </Stack>
  );
}

/** Convenience wrapper: a titled panel whose body is still loading. */
export function PanelSkeleton({
  title,
  meta,
  children,
  sx,
}: {
  title?: string;
  meta?: string;
  children: React.ReactNode;
  sx?: React.ComponentProps<typeof Panel>["sx"];
}) {
  return (
    <Panel title={title} meta={meta} sx={sx}>
      {children}
    </Panel>
  );
}

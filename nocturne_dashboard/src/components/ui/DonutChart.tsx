"use client";

import type { ReactNode } from "react";
import { Box, Stack, Typography } from "@mui/material";
import { colors, fonts } from "@/theme/tokens";

/**
 * Part-to-whole donut with a legend.
 *
 * Two rules this component exists to enforce:
 *
 *  1. Every segment is separated by a surface-coloured gap. Slices are coloured
 *     by severity, and severity repeats — two "high" reasons sitting next to
 *     each other would otherwise read as one wedge.
 *  2. Identity never rests on colour. The legend carries the label and the
 *     count, so the chart survives greyscale, colour-blind viewing, and a
 *     screenshot pasted into a ticket.
 *
 * The hole holds the total, which is the number the surrounding copy talks
 * about. Set `innerRadius={0}` for a solid pie.
 */

export interface DonutSlice {
  key: string;
  label: ReactNode;
  value: number;
  color: string;
}

export interface DonutChartProps {
  data: DonutSlice[];
  /** Rendered inside the hole, above `totalLabel`. Defaults to the sum. */
  total?: number;
  totalLabel?: string;
  /** 0 gives a solid pie. */
  innerRadius?: number;
  size?: number;
}

const GAP_DEGREES = 2.2;

/**
 * Whole-number percentages that actually sum to 100.
 *
 * Rounding each share independently is what makes a pie chart add up to 101%:
 * five shares of 51.9/21.5/13.9/7.6/5.1 each round up. Largest-remainder gives
 * the spare points to the slices that lost the most in rounding.
 */
function wholePercentages(values: number[]): number[] {
  const sum = values.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) return values.map(() => 0);

  const exact = values.map((value) => (value / sum) * 100);
  const floors = exact.map(Math.floor);
  let remaining = 100 - floors.reduce((acc, value) => acc + value, 0);

  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);

  const out = [...floors];
  for (const { index } of order) {
    if (remaining <= 0) break;
    out[index] = out[index]! + 1;
    remaining -= 1;
  }
  return out;
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

/** Annular sector between two angles; a plain wedge when `inner` is 0. */
function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  from: number,
  to: number,
): string {
  const large = to - from > 180 ? 1 : 0;
  const o1 = polar(cx, cy, outer, from);
  const o2 = polar(cx, cy, outer, to);
  if (inner <= 0) {
    return `M ${cx} ${cy} L ${o1.x} ${o1.y} A ${outer} ${outer} 0 ${large} 1 ${o2.x} ${o2.y} Z`;
  }
  const i1 = polar(cx, cy, inner, to);
  const i2 = polar(cx, cy, inner, from);
  return [
    `M ${o1.x} ${o1.y}`,
    `A ${outer} ${outer} 0 ${large} 1 ${o2.x} ${o2.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${inner} ${inner} 0 ${large} 0 ${i2.x} ${i2.y}`,
    "Z",
  ].join(" ");
}

export function DonutChart({
  data,
  total,
  totalLabel = "TOTAL",
  innerRadius = 0.62,
  size = 168,
}: DonutChartProps) {
  const slices = data.filter((slice) => slice.value > 0);
  const sum = slices.reduce((acc, slice) => acc + slice.value, 0);
  const shownTotal = total ?? sum;
  const percentages = wholePercentages(slices.map((slice) => slice.value));

  const cx = size / 2;
  const cy = size / 2;
  const outer = size / 2 - 2;
  const inner = innerRadius > 0 ? outer * innerRadius : 0;

  // A single slice cannot be drawn as an arc — 360° start and end coincide, so
  // the path collapses. Draw it as a ring instead.
  const isSingle = slices.length === 1;
  let cursor = 0;

  return (
    <Stack direction={{ xs: "column", sm: "row" }} gap={2.5} alignItems="center">
      <Box
        component="svg"
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={
          sum === 0
            ? "No data"
            : slices
                .map(
                  (slice, i) =>
                    `${typeof slice.label === "string" ? slice.label : slice.key}: ${slice.value}, ${percentages[i] ?? 0} percent`,
                )
                .join("; ")
        }
        sx={{ flexShrink: 0, display: "block" }}
      >
        {sum === 0 ? (
          <circle
            cx={cx}
            cy={cy}
            r={(outer + inner) / 2}
            fill="none"
            stroke={colors.edge}
            strokeWidth={outer - inner || 2}
          />
        ) : isSingle ? (
          <circle
            cx={cx}
            cy={cy}
            r={(outer + inner) / 2}
            fill="none"
            stroke={slices[0]!.color}
            strokeWidth={outer - inner}
          />
        ) : (
          slices.map((slice) => {
            const share = slice.value / sum;
            const from = cursor;
            const to = cursor + share * 360;
            cursor = to;
            // Halve the gap on each side so every boundary is one gap wide,
            // and never let it swallow a genuinely small slice.
            const pad = Math.min(GAP_DEGREES / 2, (to - from) / 3);
            return (
              <path
                key={slice.key}
                d={arcPath(cx, cy, outer, inner, from + pad, to - pad)}
                fill={slice.color}
              />
            );
          })
        )}

        {inner > 0 && (
          <>
            <text
              x={cx}
              y={cy + 1}
              textAnchor="middle"
              fill={colors.text1}
              fontFamily={fonts.mono}
              fontSize={22}
              fontWeight={600}
            >
              {shownTotal.toLocaleString()}
            </text>
            <text
              x={cx}
              y={cy + 17}
              textAnchor="middle"
              fill={colors.text3}
              fontFamily={fonts.mono}
              fontSize={8.5}
              letterSpacing="0.14em"
            >
              {totalLabel}
            </text>
          </>
        )}
      </Box>

      <Stack gap={0.9} sx={{ flex: 1, minWidth: 0, width: "100%" }}>
        {slices.map((slice, index) => {
          const pct = percentages[index] ?? 0;
          return (
            <Stack key={slice.key} direction="row" alignItems="center" gap={1}>
              <Box
                sx={{
                  width: 9,
                  height: 9,
                  borderRadius: "2px",
                  backgroundColor: slice.color,
                  flexShrink: 0,
                }}
              />
              <Box
                sx={{
                  fontSize: 11.5,
                  color: colors.text2,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "center",
                  gap: 0.8,
                }}
              >
                {slice.label}
              </Box>
              <Typography
                sx={{
                  ml: "auto",
                  fontFamily: fonts.mono,
                  fontSize: 11.5,
                  color: colors.text1,
                  flexShrink: 0,
                }}
              >
                {slice.value.toLocaleString()}
              </Typography>
              <Typography
                sx={{
                  fontFamily: fonts.mono,
                  fontSize: 10.5,
                  color: colors.text3,
                  width: 38,
                  textAlign: "right",
                  flexShrink: 0,
                }}
              >
                {pct >= 1 ? pct : "<1"}%
              </Typography>
            </Stack>
          );
        })}
      </Stack>
    </Stack>
  );
}

export default DonutChart;

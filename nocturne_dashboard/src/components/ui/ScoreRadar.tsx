"use client";

import { Box, Stack, Typography } from "@mui/material";
import { colors, fonts } from "@/theme/tokens";
import type { ScoreVector } from "@/types";

const AXES = [
  { key: "dataSensitivity", label: "SENSITIVITY" },
  { key: "exposureActionability", label: "EXPOSURE" },
  { key: "recordScale", label: "SCALE" },
  { key: "ownershipEvidence", label: "OWNERSHIP" },
  { key: "grounding", label: "GROUNDING" },
  { key: "claimProof", label: "PROOF" },
  { key: "corroboration", label: "CORROB" },
  { key: "actorCredibility", label: "ACTOR" },
] as const;

/**
 * The viewBox is wider than it is tall because the labels sit outside the
 * outermost ring and the east/west ones run horizontally. The previous square
 * box clipped them: "EXPOSURE 86" starts at x=211 and needs ~50px, which ran
 * past the 220-wide edge. Anchoring each label away from the centre and giving
 * the box room for it is what lets the plot itself grow.
 */
const CX = 150;
const CY = 118;
const MAX_R = 84;
const LABEL_R = 100;
const VIEW_W = 300;
const VIEW_H = 232;

function point(index: number, radius: number, cx = CX, cy = CY) {
  // Start at 12 o'clock, step 45° clockwise.
  const angle = (-90 + index * 45) * (Math.PI / 180);
  return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
}

function ring(radius: number) {
  return AXES.map((_, i) => point(i, radius).join(",")).join(" ");
}

/** Push each label away from the centre so none of them overlap the plot. */
function anchorFor(x: number): "start" | "middle" | "end" {
  if (x > CX + 1) return "start";
  if (x < CX - 1) return "end";
  return "middle";
}

export interface ScoreRadarProps {
  vector: ScoreVector;
  /**
   * Height of the plot. Pass "100%" inside a flex column to let it claim
   * whatever the panel has left after the stats row beneath it.
   */
  height?: number | string;
}

/**
 * The eight components behind impact and confidence.
 *
 * A null component is rendered at the centre and labelled "n/a" — it had its
 * weight normalized away in SQL rather than being scored zero, and showing it
 * as zero would misrepresent the maths.
 */
export function ScoreRadar({ vector, height = 210 }: ScoreRadarProps) {
  const values = AXES.map((a) => vector[a.key]);
  const shape = values
    .map((v, i) => point(i, ((v ?? 0) / 100) * MAX_R).join(","))
    .join(" ");

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0, flex: height === "100%" ? 1 : undefined }}>
      <Plot values={values} shape={shape} height={height} />
      {/* The vertex colours were carrying a threshold with nothing to read it
        * by — a yellow dot looked like a warning rather than "this component
        * scored under half". */}
      <Stack
        direction="row"
        gap={2}
        flexWrap="wrap"
        justifyContent="center"
        sx={{ mt: 0.5 }}
      >
        <DotKey color={colors.ion} label="50 or above" />
        <DotKey color={colors.medium} label="below 50 — weak component" />
        <DotKey color={colors.text3} label="n/a — weight redistributed" />
      </Stack>
    </Box>
  );
}

function DotKey({ color, label }: { color: string; label: string }) {
  return (
    <Stack direction="row" alignItems="center" gap={0.6}>
      <Box sx={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: color, flexShrink: 0 }} />
      <Typography sx={{ fontSize: 10.5, color: colors.text3 }}>{label}</Typography>
    </Stack>
  );
}

function Plot({
  values,
  shape,
  height,
}: {
  values: Array<number | null>;
  shape: string;
  height: number | string;
}) {
  return (
    <Box
      component="svg"
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Score decomposition across eight components"
      sx={{
        width: "100%",
        height,
        display: "block",
        ...(height === "100%" ? { flex: 1, minHeight: 0 } : null),
      }}
    >
      <g fill="none" stroke="rgba(122,164,255,0.10)" strokeWidth={1}>
        {[MAX_R, MAX_R * 0.75, MAX_R * 0.5, MAX_R * 0.25].map((r) => (
          <polygon key={r} points={ring(r)} />
        ))}
      </g>
      <g stroke="rgba(122,164,255,0.10)" strokeWidth={1}>
        {AXES.map((_, i) => {
          const [x, y] = point(i, MAX_R);
          return <line key={i} x1={CX} y1={CY} x2={x} y2={y} />;
        })}
      </g>

      <polygon points={shape} fill="rgba(34,211,238,0.16)" stroke={colors.ion} strokeWidth={1.6} />

      {values.map((v, i) => {
        const [x, y] = point(i, ((v ?? 0) / 100) * MAX_R);
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={2.6}
            fill={v === null ? colors.text3 : v < 50 ? colors.medium : colors.ion}
          />
        );
      })}

      <g fontFamily={fonts.mono} fontSize={8.5} fill={colors.text3}>
        {AXES.map((axis, i) => {
          const [x, y] = point(i, LABEL_R);
          const v = values[i];
          return (
            <text key={axis.key} x={x} y={y + 3} textAnchor={anchorFor(x)}>
              {/* Rounded for display only — the plot geometry above keeps full
                * precision. Snowflake returns these components as unrounded
                * floats, so an un-rounded label reads "SCALE 72.55978333772738"
                * and runs off the edge of the box. */}
              {axis.label} {v === null ? "n/a" : Math.round(v)}
            </text>
          );
        })}
      </g>
    </Box>
  );
}

export default ScoreRadar;

"use client";

import { Box } from "@mui/material";
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

const CENTER = 110;
const MAX_R = 84;

function point(index: number, radius: number) {
  // Start at 12 o'clock, step 45° clockwise.
  const angle = (-90 + index * 45) * (Math.PI / 180);
  return [CENTER + radius * Math.cos(angle), CENTER + radius * Math.sin(angle)] as const;
}

function ring(radius: number) {
  return AXES.map((_, i) => point(i, radius).join(",")).join(" ");
}

/**
 * The eight components behind impact and confidence.
 *
 * A null component is rendered at the centre and labelled "n/a" — it had its
 * weight normalized away in SQL rather than being scored zero, and showing it
 * as zero would misrepresent the maths.
 */
export function ScoreRadar({ vector }: { vector: ScoreVector }) {
  const values = AXES.map((a) => vector[a.key]);
  const shape = values
    .map((v, i) => point(i, ((v ?? 0) / 100) * MAX_R).join(","))
    .join(" ");

  return (
    <Box
      component="svg"
      viewBox="0 0 220 232"
      role="img"
      aria-label="Score decomposition across eight components"
      sx={{ width: "100%", height: 210, display: "block" }}
    >
      <g fill="none" stroke="rgba(122,164,255,0.10)" strokeWidth={1}>
        {[MAX_R, MAX_R * 0.75, MAX_R * 0.5, MAX_R * 0.25].map((r) => (
          <polygon key={r} points={ring(r)} />
        ))}
      </g>
      <g stroke="rgba(122,164,255,0.10)" strokeWidth={1}>
        {AXES.map((_, i) => {
          const [x, y] = point(i, MAX_R);
          return <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y} />;
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

      <g fontFamily={fonts.mono} fontSize={7.5} fill={colors.text3} textAnchor="middle">
        {AXES.map((axis, i) => {
          const [x, y] = point(i, MAX_R + 17);
          const v = values[i];
          return (
            <text key={axis.key} x={x} y={y + 2.5}>
              {axis.label} {v === null ? "n/a" : v}
            </text>
          );
        })}
      </g>
    </Box>
  );
}

export default ScoreRadar;

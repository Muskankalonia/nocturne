"use client";

import type { ReactNode } from "react";
import { Box, Stack, Typography, alpha } from "@mui/material";
import { colors, fonts, layout, severityColor } from "@/theme/tokens";
import { Panel } from "./Panel";

/* ── page header ───────────────────────────────────────────────────────────── */

export function PageHeader({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <Stack direction="row" alignItems="flex-start" gap={2} flexWrap="wrap">
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h2">{title}</Typography>
        {subtitle && (
          <Typography sx={{ color: colors.text2, fontSize: 12.5, mt: 0.4, lineHeight: 1.5 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {right && <Box sx={{ ml: "auto" }}>{right}</Box>}
    </Stack>
  );
}

/* ── KPI tile ──────────────────────────────────────────────────────────────── */

export function StatCard({
  label,
  value,
  sub,
  accent = colors.ion,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  accent?: string;
  valueColor?: string;
}) {
  return (
    <Panel>
      <Box sx={{ position: "relative", overflow: "hidden" }}>
        {/* Accent spine, keyed to the tile's semantic colour. Bleeds into the
            panel padding so it reads as an edge, not a rule. */}
        <Box
          sx={{
            position: "absolute",
            left: -layout.panelPad,
            top: -layout.panelPad,
            bottom: -layout.panelPad,
            width: 2,
            background: `linear-gradient(180deg, ${accent}, ${alpha(accent, 0.15)})`,
            boxShadow: `0 0 12px -1px ${alpha(accent, 0.75)}`,
          }}
        />
        <Stack gap={0.9}>
          <Typography
            sx={{
              fontFamily: fonts.mono,
              fontSize: 9.5,
              fontWeight: 500,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: colors.text3,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {label}
          </Typography>
          <Typography
            sx={{
              fontFamily: fonts.mono,
              fontSize: 27,
              fontWeight: 600,
              lineHeight: 1.05,
              letterSpacing: "-0.03em",
              color: valueColor ?? colors.text1,
            }}
          >
            {value}
          </Typography>
          {sub && (
            <Box
              sx={{
                fontSize: 11,
                color: colors.text2,
                display: "flex",
                gap: 0.7,
                alignItems: "center",
                lineHeight: 1.45,
              }}
            >
              {sub}
            </Box>
          )}
        </Stack>
      </Box>
    </Panel>
  );
}

export function StatGrid({ children, columns = 4 }: { children: ReactNode; columns?: number }) {
  return (
    <Box
      sx={{
        display: "grid",
        gap: `${layout.gap}px`,
        gridTemplateColumns: {
          xs: "1fr",
          sm: "repeat(2,1fr)",
          lg: `repeat(${columns},1fr)`,
        },
      }}
    >
      {children}
    </Box>
  );
}

/* ── labelled bars ─────────────────────────────────────────────────────────── */

export interface BarDatum {
  label: ReactNode;
  value: number;
  /** Displayed at the right; defaults to the value. */
  display?: string;
  color?: string;
}

export function BarList({
  data,
  max,
  /** Stretch rows to fill the panel. Opt-in — see Cascade for the same reason. */
  fill = false,
}: {
  data: BarDatum[];
  max?: number;
  fill?: boolean;
}) {
  const ceiling = max ?? Math.max(...data.map((d) => d.value), 1);
  return (
    <Stack
      gap={1.3}
      sx={fill ? { flex: 1, minHeight: 0, justifyContent: "space-between" } : undefined}
    >
      {data.map((d, i) => (
        <Box
          key={i}
          sx={{
            display: "grid",
            gridTemplateColumns: "1fr 56px",
            gap: 1.4,
            alignItems: "center",
            ...(fill ? { flex: 1, minHeight: 0 } : null),
          }}
        >
          <Box>
            <Box sx={{ fontSize: 11.5, color: colors.text2, display: "flex", alignItems: "center", gap: 1 }}>
              {d.label}
            </Box>
            <Box
              sx={{
                mt: 0.65,
                height: 5,
                borderRadius: "3px",
                backgroundColor: alpha(colors.text3, 0.16),
                overflow: "hidden",
              }}
            >
              <Box
                sx={{
                  height: "100%",
                  width: `${(d.value / ceiling) * 100}%`,
                  backgroundColor: d.color ?? colors.ion,
                  // Rounded data-end anchored to the baseline.
                  borderRadius: "0 3px 3px 0",
                }}
              />
            </Box>
          </Box>
          <Typography
            sx={{ fontFamily: fonts.mono, fontSize: 11.5, textAlign: "right", color: colors.text1 }}
          >
            {d.display ?? d.value}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

/* ── sparkline ─────────────────────────────────────────────────────────────── */

export function Sparkline({
  data,
  color = colors.ion,
  width = 92,
  height = 24,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return [x, y] as const;
  });
  const last = pts[pts.length - 1]!;

  return (
    <Box
      component="svg"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`Trend, latest ${data[data.length - 1]}`}
      sx={{ display: "block" }}
    >
      <polyline
        points={pts.map((p) => p.join(",")).join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill={color} />
    </Box>
  );
}

/* ── small chips ───────────────────────────────────────────────────────────── */

export function Tag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "ion" | "critical" | "high" | "medium";
}) {
  const map = {
    neutral: colors.text2,
    ok: colors.verified,
    ion: colors.ion,
    critical: severityColor.critical,
    high: severityColor.high,
    medium: severityColor.medium,
  } as const;
  const c = map[tone];
  const tinted = tone !== "neutral";
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        fontFamily: fonts.mono,
        fontSize: 10,
        px: 0.9,
        py: 0.3,
        borderRadius: "4px",
        whiteSpace: "nowrap",
        color: c,
        border: `1px solid ${tinted ? alpha(c, 0.3) : colors.edge}`,
        backgroundColor: tinted ? alpha(c, 0.08) : "rgba(255,255,255,0.02)",
      }}
    >
      {children}
    </Box>
  );
}

export function MonoValue({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <Box component="span" sx={{ fontFamily: fonts.mono, fontSize: 12, color: color ?? colors.text1 }}>
      {children}
    </Box>
  );
}

/** A note explaining why something is absent, rather than faking the data. */
export function DataGapNote({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        px: 1.5,
        py: 1.1,
        border: `1px dashed ${alpha(colors.medium, 0.35)}`,
        borderRadius: "7px",
        backgroundColor: alpha(colors.medium, 0.05),
        fontSize: 11.5,
        color: colors.text2,
        lineHeight: 1.65,
      }}
    >
      {children}
    </Box>
  );
}

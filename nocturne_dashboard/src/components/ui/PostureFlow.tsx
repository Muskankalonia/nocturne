"use client";

import { Box, Stack, Typography } from "@mui/material";
import { colors, fonts, severityColor } from "@/theme/tokens";
import type { SeverityBand } from "@/types";

/**
 * The Command Center hero: one left-to-right sentence about the whole pipeline.
 *
 *   sources  →  pages that survived screening  →  the AI cascade  →  incidents
 *            →  confirmed vs needs-review      →  resolved vs still open
 *
 * It is a single SVG on a fixed viewBox so every coordinate below is authored in
 * one space and the whole thing scales with the panel. Nothing here is random:
 * a client component gets prerendered, and `Math.random()` in the render path
 * would desync on hydration.
 */

const VB = { w: 1560, h: 478 };

/* ── geometry ──────────────────────────────────────────────────────────────── */

const FAN_X = 352; // where source strands begin
const MERGE_X = 548; // where they converge
const MID_Y = 268;

const ALERT_X = 632; // "checked for relevance" node
const CORE_X = 830; // orbital core centre
const CORE_R = 118;
const INC_X = 1010; // "incidents" node

const BRANCH_X = 1160; // confirmed / not-confirmed split
const BRANCH_HI_Y = 186;
const BRANCH_LO_Y = 410;

const OUT_X = 1286; // ribbons terminate here
const CHIP_X = 1302; // severity chips sit clear of the ribbon
const NUM_X = 1380; // outcome numbers
// Both outcomes descend from CONFIRMED — only a confirmed breach has a
// remediation state. NOT CONFIRMED is terminal.
const RES_Y = 96;
const OPEN_Y = 272;

/** Variable-width ribbon between two points — the sankey look of the reference. */
function ribbon(
  x1: number,
  y1: number,
  w1: number,
  x2: number,
  y2: number,
  w2: number,
): string {
  const cx = (x1 + x2) / 2;
  return [
    `M ${x1} ${y1 - w1 / 2}`,
    `C ${cx} ${y1 - w1 / 2}, ${cx} ${y2 - w2 / 2}, ${x2} ${y2 - w2 / 2}`,
    `L ${x2} ${y2 + w2 / 2}`,
    `C ${cx} ${y2 + w2 / 2}, ${cx} ${y1 + w1 / 2}, ${x1} ${y1 + w1 / 2}`,
    "Z",
  ].join(" ");
}

/** Single stroked strand, used for the source fan. */
function strand(x1: number, y1: number, x2: number, y2: number): string {
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}

export interface FlowSource {
  label: string;
  /** Relative volume; only used to weight strand opacity. */
  weight?: number;
}

export interface PostureFlowProps {
  sources: FlowSource[];
  extraSourceCount: number;
  collected: number;
  relevant: number;
  deepAnalysis: number;
  incidents: number;
  confirmed: number;
  needsReview: number;
  resolved: number;
  open: number;
  bands: { band: SeverityBand; count: number }[];
  groundingRate: number;
}

export function PostureFlow({
  sources,
  extraSourceCount,
  collected,
  relevant,
  deepAnalysis,
  incidents,
  confirmed,
  needsReview,
  resolved,
  open,
  bands,
  groundingRate,
}: PostureFlowProps) {
  const n = sources.length;
  // Keep the fan centred on the flow line: with only a handful of hosts a
  // full-height spread reads as empty space rather than as volume.
  const fanSpan = Math.min(300, Math.max(120, (n - 1) * 62));
  const fanTop = MID_Y - fanSpan / 2;
  const fanGap = n > 1 ? fanSpan / (n - 1) : 0;

  // Ribbon thickness is proportional to what actually flows, with a floor so a
  // single incident is still a visible thread rather than a hairline.
  const total = Math.max(confirmed + needsReview, 1);
  const wConfirmed = Math.max(7, (confirmed / total) * 68);
  const wReview = Math.max(7, (needsReview / total) * 68);
  const outTotal = Math.max(resolved + open, 1);
  const wResolved = Math.max(6, (resolved / outTotal) * 40);
  const wOpen = Math.max(6, (open / outTotal) * 40);

  return (
    <Box
      component="svg"
      viewBox={`0 0 ${VB.w} ${VB.h}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={
        `${collected.toLocaleString()} pages collected, ${relevant.toLocaleString()} checked for relevance, ` +
        `${deepAnalysis} sent to deep analysis, ${incidents} incidents raised, ` +
        `${confirmed} confirmed and ${needsReview} not confirmed; of the confirmed, ${resolved} resolved and ${open} still open.`
      }
      sx={{
        width: "100%",
        height: "auto",
        display: "block",
        overflow: "visible",
        "& text": { fontFamily: fonts.sans },
        // Slow, low-amplitude motion: enough to read as live ingest, not enough
        // to pull attention off the numbers.
        "& .pf-strand": {
          strokeDasharray: "6 14",
          animation: "pfDash 3s linear infinite",
        },
        "& .pf-spin": { animation: "pfSpin 28s linear infinite" },
        "@keyframes pfDash": { to: { strokeDashoffset: -40 } },
        "@keyframes pfSpin": { to: { transform: "rotate(360deg)" } },
        "@media (prefers-reduced-motion: reduce)": {
          "& .pf-strand, & .pf-spin": { animation: "none" },
          "& .pf-strand": { strokeDasharray: "none" },
        },
      }}
    >
      <defs>
        {/* Ribbons that end in open space fade out rather than stopping on a
            hard edge, so nothing reads as a truncated bar. */}
        <linearGradient id="pfIntake" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={colors.ion} stopOpacity="0.55" />
          <stop offset="1" stopColor={colors.ion} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pfTerminal" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={severityColor.medium} stopOpacity="0.55" />
          <stop offset="1" stopColor={severityColor.medium} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pfConfirmed" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={colors.ion} stopOpacity="0.55" />
          <stop offset="1" stopColor={colors.verified} stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id="pfReview" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={colors.ion} stopOpacity="0.45" />
          <stop offset="1" stopColor={severityColor.medium} stopOpacity="0.7" />
        </linearGradient>
        <linearGradient id="pfResolved" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={colors.verified} stopOpacity="0.75" />
          <stop offset="1" stopColor={colors.verified} stopOpacity="0.3" />
        </linearGradient>
        <linearGradient id="pfOpen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={severityColor.medium} stopOpacity="0.6" />
          <stop offset="1" stopColor={severityColor.critical} stopOpacity="0.55" />
        </linearGradient>
        <radialGradient id="pfCoreGlow">
          <stop offset="0" stopColor={colors.ion} stopOpacity="0.22" />
          <stop offset="0.65" stopColor={colors.ion} stopOpacity="0.05" />
          <stop offset="1" stopColor={colors.ion} stopOpacity="0" />
        </radialGradient>
        <filter id="pfGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="7" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ── source fan ─────────────────────────────────────────────────────── */}
      <g>
        {sources.map((s, i) => {
          const y = fanTop + i * fanGap;
          // Strand count carries volume: a host that produced more pages sends
          // a visibly thicker bundle, without inventing a number for it.
          const bundle = 1 + Math.round((s.weight ?? 0.5) * 3);
          return (
            <g key={s.label}>
              {Array.from({ length: bundle }, (_, k) => {
                const off = (k - (bundle - 1) / 2) * 4.5;
                return (
                  <path
                    key={k}
                    d={strand(FAN_X, y + off, MERGE_X, MID_Y + off * 0.5)}
                    fill="none"
                    stroke={colors.ion}
                    strokeOpacity={0.3 - Math.abs(off) * 0.02}
                    strokeWidth={1.3}
                  />
                );
              })}
              {/* one animated tracer per source, so the bundle reads as live */}
              <path
                d={strand(FAN_X, y, MERGE_X, MID_Y)}
                fill="none"
                stroke={colors.ionBright}
                strokeOpacity={0.5}
                strokeWidth={1.5}
                className="pf-strand"
              />
              <circle cx={FAN_X} cy={y} r={3.2} fill={colors.ion} fillOpacity={0.7} />
              <text
                x={FAN_X - 14}
                y={y + 4}
                textAnchor="end"
                fill={colors.text2}
                fontSize={12.5}
                fontFamily={fonts.mono}
              >
                {s.label}
              </text>
            </g>
          );
        })}

        <text
          x={FAN_X - 14}
          y={fanTop - 34}
          textAnchor="end"
          fill={colors.text1}
          fontSize={24}
          fontFamily={fonts.mono}
          fontWeight={600}
        >
          {collected.toLocaleString()}
        </text>
        <text
          x={FAN_X - 14}
          y={fanTop - 17}
          textAnchor="end"
          fill={colors.text3}
          fontSize={10}
          fontFamily={fonts.mono}
          letterSpacing="0.14em"
        >
          PAGES COLLECTED
        </text>
        {extraSourceCount > 0 && (
          <text
            x={FAN_X - 14}
            y={fanTop + n * fanGap + 6}
            textAnchor="end"
            fill={colors.text3}
            fontSize={11.5}
            fontFamily={fonts.mono}
          >
            +{extraSourceCount} more
          </text>
        )}
        <text
          x={FAN_X - 14}
          y={fanTop + (n - 1) * fanGap + 34}
          textAnchor="end"
          fill={colors.text3}
          fontSize={10}
          fontFamily={fonts.mono}
          letterSpacing="0.14em"
        >
          {n + extraSourceCount} SOURCE{n + extraSourceCount === 1 ? "" : "S"} SEEN
        </text>
      </g>

      {/* ── convergence ────────────────────────────────────────────────────── */}
      {/* The strands already do the converging; a node marks where they land. */}
      <circle cx={MERGE_X} cy={MID_Y} r={16} fill="url(#pfCoreGlow)" />
      <circle
        cx={MERGE_X}
        cy={MID_Y}
        r={5}
        fill={colors.ionBright}
        filter="url(#pfGlow)"
      />
      <path d={ribbon(MERGE_X, MID_Y, 10, ALERT_X - 18, MID_Y, 22)} fill="url(#pfIntake)" />
      <FlowStat
        x={ALERT_X}
        y={MID_Y}
        value={relevant.toLocaleString()}
        label={
          <>
            <tspan x={ALERT_X} dy="0">
              CHECKED
            </tspan>
            <tspan x={ALERT_X} dy="13">
              FOR RELEVANCE
            </tspan>
          </>
        }
        color={colors.text1}
        anchor="middle"
      />

      {/* ── the cascade core ───────────────────────────────────────────────── */}
      <g>
        <circle cx={CORE_X} cy={MID_Y} r={CORE_R * 1.5} fill="url(#pfCoreGlow)" />
        <OrbitalCore bands={bands} deepAnalysis={deepAnalysis} />
        <text
          x={CORE_X}
          y={MID_Y + CORE_R + 34}
          textAnchor="middle"
          fill={colors.text3}
          fontSize={10}
          fontFamily={fonts.mono}
          letterSpacing="0.14em"
        >
          SENT TO DEEP ANALYSIS
        </text>
        <text
          x={CORE_X}
          y={MID_Y - CORE_R - 22}
          textAnchor="middle"
          fill={colors.verified}
          fontSize={11}
          fontFamily={fonts.mono}
          letterSpacing="0.1em"
        >
          {groundingRate}% GROUNDED
        </text>
      </g>

      {/* ── incidents node ─────────────────────────────────────────────────── */}
      <FlowStat
        x={INC_X}
        y={MID_Y}
        value={String(incidents)}
        label="INCIDENTS"
        color={colors.text1}
        anchor="middle"
        big
      />

      {/* ── split into confirmed / needs review ────────────────────────────── */}
      <path
        d={ribbon(INC_X + 52, MID_Y - 14, 26, BRANCH_X, BRANCH_HI_Y, wConfirmed)}
        fill="url(#pfConfirmed)"
      />
      <path
        d={ribbon(INC_X + 52, MID_Y + 14, 22, BRANCH_X, BRANCH_LO_Y, wReview)}
        fill="url(#pfReview)"
      />

      <BranchNode
        x={BRANCH_X}
        y={BRANCH_HI_Y}
        value={String(confirmed)}
        label="CONFIRMED"
        color={colors.verified}
        labelAbove
      />
      <BranchNode
        x={BRANCH_X}
        y={BRANCH_LO_Y}
        value={String(needsReview)}
        label="NOT CONFIRMED"
        color={severityColor.medium}
      />

      {/* ── outcomes ───────────────────────────────────────────────────────── */}
      {/* A branch with nothing in it stays as a faint thread rather than a fat
          ribbon promising volume that isn't there. */}
      <path
        d={ribbon(
          BRANCH_X + 30,
          BRANCH_HI_Y - wResolved / 2 - 1,
          wResolved,
          OUT_X,
          RES_Y,
          wResolved,
        )}
        fill="url(#pfResolved)"
        fillOpacity={resolved > 0 ? 1 : 0.22}
      />
      <path
        d={ribbon(BRANCH_X + 30, BRANCH_HI_Y + wOpen / 2 + 1, wOpen, OUT_X, OPEN_Y, wOpen)}
        fill="url(#pfOpen)"
        fillOpacity={open > 0 ? 1 : 0.22}
      />
      {/* Not-confirmed is where the flow stops: a short stub that fades out,
          rather than a ribbon implying it feeds a downstream state. */}
      <path
        d={ribbon(BRANCH_X + 17, BRANCH_LO_Y, wReview, BRANCH_X + 96, BRANCH_LO_Y, wReview * 0.8)}
        fill="url(#pfTerminal)"
      />

      <FlowStat
        x={NUM_X}
        y={RES_Y}
        value={String(resolved)}
        label="RESOLVED"
        color={resolved > 0 ? colors.verified : colors.text3}
        anchor="start"
      />
      <FlowStat
        x={NUM_X}
        y={OPEN_Y}
        value={String(open)}
        label="STILL OPEN"
        color={open > 0 ? severityColor.critical : colors.text3}
        anchor="start"
      />

      {/* severity chips, clear of the ribbon and centred on the open branch */}
      <g>
        {(() => {
          const shown = bands.filter((b) => b.count > 0);
          const top = OPEN_Y - (shown.length * 24) / 2 + 2;
          return shown.map((b, i) => (
            <g key={b.band} transform={`translate(${CHIP_X}, ${top + i * 24})`}>
              <rect
                width={19}
                height={19}
                rx={4}
                fill={severityColor[b.band]}
                fillOpacity={0.16}
                stroke={severityColor[b.band]}
                strokeOpacity={0.55}
              />
              <text
                x={9.5}
                y={13.5}
                textAnchor="middle"
                fill={severityColor[b.band]}
                fontSize={10.5}
                fontFamily={fonts.mono}
                fontWeight={600}
              >
                {b.band[0]!.toUpperCase()}
              </text>
              <text x={26} y={13.5} fill={colors.text2} fontSize={11} fontFamily={fonts.mono}>
                {b.count}
              </text>
            </g>
          ));
        })()}
      </g>
    </Box>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────────── */

function FlowStat({
  x,
  y,
  value,
  label,
  color,
  anchor,
  big,
}: {
  x: number;
  y: number;
  value: string;
  label: React.ReactNode;
  color: string;
  anchor: "start" | "middle" | "end";
  big?: boolean;
}) {
  return (
    <g>
      <text
        x={x}
        y={y - 4}
        textAnchor={anchor}
        fill={color}
        fontSize={big ? 38 : 27}
        fontFamily={fonts.mono}
        fontWeight={600}
        letterSpacing="-0.02em"
      >
        {value}
      </text>
      <text
        x={x}
        y={y + 16}
        textAnchor={anchor}
        fill={colors.text3}
        fontSize={10}
        fontFamily={fonts.mono}
        letterSpacing="0.14em"
      >
        {label}
      </text>
    </g>
  );
}

function BranchNode({
  x,
  y,
  value,
  label,
  color,
  labelAbove,
}: {
  x: number;
  y: number;
  value: string;
  label: string;
  color: string;
  /** Put the caption on the outside of the split so it never sits on a ribbon. */
  labelAbove?: boolean;
}) {
  return (
    <g>
      <circle cx={x} cy={y} r={17} fill={colors.hull} stroke={color} strokeWidth={1.6} />
      <circle cx={x} cy={y} r={17} fill="none" stroke={color} strokeOpacity={0.3} strokeWidth={7} />
      <text
        x={x}
        y={y + 5}
        textAnchor="middle"
        fill={color}
        fontSize={13}
        fontFamily={fonts.mono}
        fontWeight={600}
      >
        {value}
      </text>
      <text
        x={x}
        y={labelAbove ? y - 32 : y + 44}
        textAnchor="middle"
        fill={colors.text3}
        fontSize={10}
        fontFamily={fonts.mono}
        letterSpacing="0.14em"
      >
        {label}
      </text>
    </g>
  );
}

/**
 * The centre "engine". Concentric dotted rings whose colour mix reflects the
 * open severity split, plus two arcs that sweep slowly. Every position is
 * derived from index maths so server and client render identically.
 */
function OrbitalCore({
  bands,
  deepAnalysis,
}: {
  bands: { band: SeverityBand; count: number }[];
  deepAnalysis: number;
}) {
  const rings = [0.42, 0.58, 0.74, 0.9];
  const present = bands.filter((b) => b.count > 0);
  const totalBand = present.reduce((s, b) => s + b.count, 0) || 1;

  const dots: { x: number; y: number; r: number; fill: string; o: number }[] = [];
  rings.forEach((rf, ri) => {
    const radius = CORE_R * rf;
    const count = 18 + ri * 8;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + ri * 0.22;
      // Colour a deterministic slice of the ring by severity share so the core
      // actually encodes the open mix instead of being decoration.
      const frac = i / count;
      let acc = 0;
      let fill: string = colors.ion;
      for (const b of present) {
        acc += b.count / totalBand;
        if (frac <= acc) {
          fill = severityColor[b.band];
          break;
        }
      }
      const inner = ri < 2;
      dots.push({
        x: CORE_X + Math.cos(a) * radius,
        y: MID_Y + Math.sin(a) * radius,
        r: inner ? 2.1 : 1.7,
        fill: inner ? fill : colors.ion,
        o: inner ? 0.85 : 0.3,
      });
    }
  });

  return (
    <g>
      <circle
        cx={CORE_X}
        cy={MID_Y}
        r={CORE_R}
        fill="none"
        stroke={colors.ion}
        strokeOpacity={0.18}
        strokeWidth={1}
      />
      <circle
        cx={CORE_X}
        cy={MID_Y}
        r={CORE_R * 1.16}
        fill="none"
        stroke={colors.ion}
        strokeOpacity={0.08}
        strokeWidth={1}
        strokeDasharray="2 7"
      />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} fill={d.fill} fillOpacity={d.o} />
      ))}
      {/* sweeping arcs */}
      <g className="pf-spin" style={{ transformOrigin: `${CORE_X}px ${MID_Y}px` }}>
        <path
          d={describeArc(CORE_X, MID_Y, CORE_R * 1.05, -34, 62)}
          fill="none"
          stroke={colors.ion}
          strokeWidth={2.2}
          strokeLinecap="round"
          filter="url(#pfGlow)"
        />
        <path
          d={describeArc(CORE_X, MID_Y, CORE_R * 1.05, 150, 212)}
          fill="none"
          stroke={colors.ion}
          strokeOpacity={0.5}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </g>
      <text
        x={CORE_X}
        y={MID_Y + 5}
        textAnchor="middle"
        fill={colors.text1}
        fontSize={15}
        fontFamily={fonts.mono}
        fontWeight={600}
      >
        {deepAnalysis.toLocaleString()}
      </text>
    </g>
  );
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function describeArc(cx: number, cy: number, r: number, from: number, to: number) {
  const s = polar(cx, cy, r, to);
  const e = polar(cx, cy, r, from);
  const large = to - from <= 180 ? 0 : 1;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y}`;
}

export default PostureFlow;

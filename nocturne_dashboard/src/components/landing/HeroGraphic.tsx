import { Box } from "@mui/material";
import { colors, fonts } from "@/theme/tokens";
import { type GraphKind, graphColor } from "./graph-palette";

/**
 * The L3 knowledge graph schema, drawn in the console's own palette.
 *
 * There is already a rendered copy of this diagram in the repository assets — but it comes
 * out of mermaid on pale yellow, which would be the single brightest object on
 * a blue-black page. Redrawing it as inline SVG costs about a hundred lines and
 * buys correct colour, crisp text at any density, and no image request.
 *
 * All six edge types are present because the claim the page makes is that only
 * one of them decides ownership. `ALLEGEDLY_AFFECTS` is therefore the only edge
 * drawn solid in `ion`; the rest are dashed hairlines. That is the diagram's
 * whole argument, and it should be legible before anything is read.
 */

const NODE_H = 30;

type NodeSpec = {
  id: string;
  x: number;
  y: number;
  w: number;
  label: string;
  kind: GraphKind;
};

/**
 * Every label here names its own type, so the colour is reinforcement rather
 * than the only cue — this diagram needs no legend box the way the worked
 * example does.
 */
const NODES: NodeSpec[] = [
  { id: "actor", x: 246, y: 16, w: 150, label: "SELLER / ACTOR", kind: "actor" },
  { id: "claim", x: 104, y: 138, w: 132, label: "LEAK CLAIM", kind: "claim" },
  { id: "target", x: 10, y: 268, w: 156, label: "ODIDO", kind: "org" },
  { id: "domain", x: 28, y: 356, w: 120, label: "odido.nl", kind: "domain" },
  { id: "market", x: 268, y: 268, w: 148, label: "MARKETPLACE", kind: "market" },
  { id: "asset", x: 276, y: 154, w: 140, label: "DATA ASSET", kind: "asset" },
];

export function HeroGraphic() {
  return (
    <Box
      aria-label="Knowledge graph schema: a leak claim connects an actor to a monitored organization"
      role="img"
      component="svg"
      viewBox="0 0 432 404"
      sx={{
        width: "100%",
        height: "auto",
        maxWidth: 600,
        display: "block",
        overflow: "visible",

        /* Motion, declared once here rather than per element.
         *
         * The dashed edges run their dashes toward their arrowheads, which
         * reads as material moving through the graph. The solid ion edge is
         * not dashed and must not be — it is the one line that has to look
         * continuous — so it breathes on opacity instead, and the target node
         * pulses with it so the pair reads as one event.
         *
         * Anyone who has asked their system to stop animating gets the diagram
         * at rest, which is the same diagram. */
        "& .flow": {
          strokeDasharray: "3 3",
          animation: "nocturneFlow 1.1s linear infinite",
        },
        "& .pulse-edge": { animation: "nocturneEdgePulse 3.2s ease-in-out infinite" },
        "& .pulse-node": { animation: "nocturneNodePulse 3.2s ease-in-out infinite" },
        "@keyframes nocturneFlow": {
          from: { strokeDashoffset: 12 },
          to: { strokeDashoffset: 0 },
        },
        "@keyframes nocturneEdgePulse": {
          "0%, 100%": { opacity: 0.62 },
          "50%": { opacity: 1 },
        },
        "@keyframes nocturneNodePulse": {
          "0%, 100%": { opacity: 0.82 },
          "50%": { opacity: 1 },
        },
        "@media (prefers-reduced-motion: reduce)": {
          "& *": { animation: "none !important" },
        },
      }}
    >
      <defs>
        <marker
          id="nocturne-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 Z" fill={colors.text3} />
        </marker>
        <marker
          id="nocturne-arrow-ion"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="5.5"
          markerHeight="5.5"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L8,4 L0,8 Z" fill={colors.ion} />
        </marker>
        <filter id="nocturne-node-glow" x="-40%" y="-80%" width="180%" height="260%">
          <feGaussianBlur stdDeviation="7" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* ── edges ───────────────────────────────────────────────────────────
        * Drawn before the nodes so the boxes sit on top of the line ends and
        * nothing has to be trimmed to length by hand. */}

      {/* MADE_CLAIM — actor down into the claim */}
      <path
        d="M300,46 C240,80 214,96 190,138"
        fill="none"
        stroke={colors.text3}
        strokeWidth="1.4"
        markerEnd="url(#nocturne-arrow)"
      />
      <EdgeLabel x={252} y={100} text="MADE_CLAIM" />

      {/* ALLEGEDLY_AFFECTS — the one edge that decides ownership */}
      <path
        d="M150,168 C132,210 116,232 96,268"
        fill="none"
        stroke={colors.ion}
        strokeWidth="2.4"
        className="pulse-edge"
        markerEnd="url(#nocturne-arrow-ion)"
      />
      {/* Sits clear of the line rather than on it: this is the one edge the
        * diagram is arguing about, and punching a plate through it would break
        * the only stroke that has to read as continuous. */}
      <EdgeLabel x={112} y={222} text="ALLEGEDLY_AFFECTS" tone={colors.ion} anchor="end" />

      {/* MENTIONS — claim out to the data asset */}
      <path
        d="M236,158 L276,166"
        fill="none"
        stroke={colors.text3}
        strokeWidth="1.1"
        className="flow"
        markerEnd="url(#nocturne-arrow)"
        opacity="0.8"
      />
      <EdgeLabel x={268} y={144} text="MENTIONS" />

      {/* LISTED_ON — claim down to the marketplace */}
      <path
        d="M204,168 C240,206 288,236 320,268"
        fill="none"
        stroke={colors.text3}
        strokeWidth="1.1"
        className="flow"
        markerEnd="url(#nocturne-arrow)"
        opacity="0.8"
      />
      <EdgeLabel x={228} y={214} text="LISTED_ON" anchor="start" />

      {/* OPERATES_ON — actor's own presence, independent of any claim */}
      <path
        d="M392,46 C418,120 410,208 372,268"
        fill="none"
        stroke={colors.text3}
        strokeWidth="1.1"
        className="flow"
        markerEnd="url(#nocturne-arrow)"
        opacity="0.8"
      />
      {/* Kept above DATA ASSET rather than beside it. Nodes paint after labels
        * so that boxes cover line ends cleanly, which means any label sharing a
        * node's box is simply invisible — this one was. */}
      <EdgeLabel x={430} y={112} text="OPERATES_ON" anchor="end" />

      {/* HAS_DOMAIN — the resolution that makes the target match verifiable */}
      <path
        d="M88,298 L88,356"
        fill="none"
        stroke={colors.text3}
        strokeWidth="1.1"
        markerEnd="url(#nocturne-arrow)"
        opacity="0.85"
      />
      <EdgeLabel x={96} y={332} text="HAS_DOMAIN" anchor="start" />

      {/* ── nodes ─────────────────────────────────────────────────────────── */}
      {NODES.map((node) => (
        <Node key={node.id} {...node} />
      ))}
    </Box>
  );
}

function Node({ x, y, w, label, kind }: NodeSpec) {
  const isTarget = kind === "org";
  const hue = graphColor[kind];
  // Pills sit over crossing edges, so their fill has to stay near-opaque; the
  // hue is carried by the border and a thin tint rather than a flat colour.
  const fill = isTarget ? "rgba(76,141,255,0.16)" : "rgba(12,20,36,0.94)";
  const text = colors.text1;

  return (
    <g
      filter={isTarget ? "url(#nocturne-node-glow)" : undefined}
      className={isTarget ? "pulse-node" : undefined}
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={NODE_H}
        rx="7"
        fill={fill}
        stroke={hue}
        strokeWidth={isTarget ? 1.8 : 1.3}
      />
      <text
        x={x + w / 2}
        y={y + NODE_H / 2 + 3.6}
        textAnchor="middle"
        fill={text}
        style={{
          fontFamily: fonts.mono,
          fontSize: 10.5,
          letterSpacing: "0.09em",
          fontWeight: isTarget ? 600 : 400,
        }}
      >
        {label}
      </text>
    </g>
  );
}

/**
 * Edge labels sit on top of the very lines they name, so each gets a plate in
 * the page colour punched out behind it. Without one, `MADE_CLAIM` reads as
 * struck through and `MENTIONS` disappears into the node beside it.
 *
 * The plate is sized from the character count rather than measured: this
 * renders on the server, where there is no text metrics API, and monospace is
 * the one case where counting characters is exact rather than a guess.
 */
const LABEL_ADVANCE = 5.85; // 8.5px JetBrains Mono + 0.1em tracking
const LABEL_PAD = 4;

function EdgeLabel({
  x,
  y,
  text,
  tone = colors.text3,
  anchor = "middle",
}: {
  x: number;
  y: number;
  text: string;
  tone?: string;
  anchor?: "start" | "middle" | "end";
}) {
  const width = text.length * LABEL_ADVANCE + LABEL_PAD * 2;
  const left =
    anchor === "start" ? x - LABEL_PAD : anchor === "end" ? x - width + LABEL_PAD : x - width / 2;

  return (
    <g>
      <rect
        x={left}
        y={y - 8}
        width={width}
        height={12}
        rx="3"
        fill={colors.abyss}
        opacity="0.92"
      />
      <text
        x={x}
        y={y}
        textAnchor={anchor}
        fill={tone}
        style={{ fontFamily: fonts.mono, fontSize: 8.5, letterSpacing: "0.1em" }}
      >
        {text}
      </text>
    </g>
  );
}

export default HeroGraphic;

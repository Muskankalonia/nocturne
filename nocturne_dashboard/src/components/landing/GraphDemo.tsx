import { Box, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { colors, fonts, layout, shadows } from "@/theme/tokens";
import { GRAPH_LEGEND, type GraphKind, graphColor } from "./graph-palette";

/**
 * A landing-page example of the knowledge graph, at the size the argument needs.
 *
 * The hero diagram shows the *schema* — six edge types, one organization. This
 * shows what the schema is for: a field of claims where most never reach you,
 * and the two that do are the only ones drawn in `ion`. `claim-c` and `claim-d`
 * exist precisely because they have no `ALLEGEDLY_AFFECTS` edge; deleting them
 * would make the picture prettier and remove the point.
 *
 * Still a server component. Node positions are authored by hand and edges are
 * trimmed to the circle boundaries at render time, so there is no layout
 * simulation, no canvas, and no client bundle — the whole thing is markup.
 *
 * The claim labels are real: "21M records" and "15M Salesforce" are the two
 * highest-scoring grounded claims on the Odido incidents, taken from
 * VW_INCIDENT_CLAIMS rather than invented to look plausible.
 *
 * The actor handles and marketplaces are still synthetic, and that is a
 * deliberate asymmetry. The crawl does name a real group, but attribution is
 * the part of a claim that the pipeline does not verify — corroborating that a
 * claim was seen widely is not the same as establishing who made it — so the
 * one thing this page does not do is repeat an attribution to a named group on
 * a public URL. The graph's argument is about which edge resolves, and it needs
 * an actor node, not that actor's name.
 */

interface DemoNode {
  id: string;
  x: number;
  y: number;
  r: number;
  label: string;
  kind: GraphKind;
  /** Dim nodes are the ones the cascade did not connect to the target. */
  dim?: boolean;
}

const NODES: DemoNode[] = [
  { id: "org", x: 280, y: 220, r: 32, label: "ODIDO", kind: "org" },
  { id: "domain", x: 132, y: 302, r: 14, label: "odido.nl", kind: "domain" },

  { id: "claim-a", x: 480, y: 130, r: 19, label: "21M records", kind: "claim" },
  { id: "claim-b", x: 486, y: 316, r: 19, label: "15M Salesforce", kind: "claim" },
  { id: "claim-c", x: 706, y: 222, r: 15, label: "unresolved", kind: "claim", dim: true },
  // Tucked out past actor-2 rather than under it: at its old position its label
  // ran into "actor · 3d91", and its edge to the forum passed straight through
  // the actor's circle.
  { id: "claim-d", x: 800, y: 408, r: 15, label: "another company", kind: "claim", dim: true },

  { id: "actor-1", x: 692, y: 68, r: 23, label: "actor · a7f2", kind: "actor" },
  { id: "actor-2", x: 704, y: 374, r: 23, label: "actor · 3d91", kind: "actor" },

  { id: "market-1", x: 884, y: 148, r: 18, label: "marketplace", kind: "market" },
  { id: "market-2", x: 888, y: 300, r: 18, label: "forum", kind: "market" },

  { id: "asset-a", x: 398, y: 42, r: 12, label: "passwords", kind: "asset" },
  { id: "asset-b", x: 566, y: 224, r: 12, label: "PII", kind: "asset" },
];

interface DemoEdge {
  from: string;
  to: string;
  /** Accepted edges are the resolution path — the only ones drawn in ion. */
  accepted?: boolean;
  flow?: boolean;
  dim?: boolean;
}

const EDGES: DemoEdge[] = [
  // The two paths that reach the monitored organization.
  { from: "claim-a", to: "org", accepted: true },
  { from: "claim-b", to: "org", accepted: true },
  { from: "org", to: "domain" },

  { from: "actor-1", to: "claim-a" },
  { from: "actor-2", to: "claim-b" },

  { from: "claim-a", to: "asset-a", flow: true },
  { from: "claim-a", to: "asset-b", flow: true },
  { from: "claim-b", to: "asset-b", flow: true },
  { from: "claim-a", to: "market-1", flow: true },
  { from: "claim-b", to: "market-2", flow: true },
  { from: "actor-1", to: "market-1", flow: true, dim: true },
  { from: "actor-2", to: "market-2", flow: true, dim: true },

  // Everything the cascade collected that never resolved to the target. These
  // reach actors and marketplaces and stop there.
  { from: "actor-1", to: "claim-c", dim: true },
  { from: "claim-c", to: "market-1", dim: true, flow: true },
  { from: "actor-2", to: "claim-d", dim: true },
  { from: "claim-d", to: "market-2", dim: true, flow: true },
];

const BY_ID = new Map(NODES.map((node) => [node.id, node]));

/** Shortens a segment to the two circle boundaries, leaving room for the head. */
function segment(from: DemoNode, to: DemoNode) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  return {
    x1: from.x + ux * (from.r + 3),
    y1: from.y + uy * (from.r + 3),
    x2: to.x - ux * (to.r + 7),
    y2: to.y - uy * (to.r + 7),
  };
}

/**
 * Node fills are the type hue at low alpha over the panel, so the circle reads
 * as tinted rather than as a solid blob of colour; the ring carries the hue at
 * full strength. Keeping fills weak is what stops five hues at this density
 * from turning into confetti.
 */
const fillFor = (kind: GraphKind) => alpha(graphColor[kind], kind === "org" ? 0.26 : 0.16);

export function GraphDemo() {
  return (
    <Box
      sx={{
        position: "relative",
        borderRadius: `${layout.radius}px`,
        border: `1px solid ${colors.edge}`,
        backgroundImage: `linear-gradient(180deg, ${alpha(colors.hull, 0.6)} 0%, ${alpha(colors.abyss, 0.5)} 100%)`,
        boxShadow: shadows.panel,
        overflow: "hidden",
      }}
    >
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ sm: "center" }}
        gap={1.5}
        sx={{ px: 2.4, py: 1.5, borderBottom: `1px solid ${colors.edge}` }}
      >
        <Typography
          sx={{
            fontFamily: fonts.mono,
            fontSize: 10.5,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: colors.text3,
          }}
        >
          Worked example · one organization, one crawl window
        </Typography>
        {/* The key names what is actually distinct. An earlier version keyed on
          * "dashed = unresolved", which was wrong: most dashed edges here are
          * ordinary MENTIONS and LISTED_ON edges hanging off accepted claims.
          * What marks the rejected material is the dimmed, dashed *node*. */}
        <Stack direction="row" gap={2.4} sx={{ ml: { sm: "auto" }, flexWrap: "wrap" }}>
          <Key swatch="edge" tone={colors.ion} label="ALLEGEDLY_AFFECTS · accepted" />
          <Key swatch="node" tone={colors.text3} label="Never resolved to you" />
        </Stack>
      </Stack>

      {/* Scrolls rather than shrinks. Scaled to a 350px phone the whole graph
        * fits, but its 10px labels land at about 3.5px and the picture becomes
        * decoration. A floor of 720px keeps them readable and lets the panel
        * pan instead — the page itself still never scrolls sideways. */}
      <Box sx={{ overflowX: "auto", overflowY: "hidden" }}>
      <Box
        component="svg"
        role="img"
        aria-label="Knowledge graph: twelve entities from one crawl window, of which two claims resolve to the monitored organization"
        viewBox="0 0 980 470"
        sx={{
          width: "100%",
          minWidth: 720,
          height: "auto",
          display: "block",
          p: { xs: 1, md: 2 },

          /* Dashes run toward their arrowheads so the graph reads as moving
           * material. The accepted edges are solid and stay solid — they are
           * the claim the picture makes — so they breathe on opacity instead. */
          "& .flow": { strokeDasharray: "4 4", animation: "graphFlow 1.4s linear infinite" },
          "& .accepted": { animation: "graphPulse 3.4s ease-in-out infinite" },
          "& .target": { animation: "graphPulse 3.4s ease-in-out infinite" },
          "& .spark": {
            offsetRotate: "0deg",
            animation: "graphSpark 4.2s cubic-bezier(0.4, 0, 0.5, 1) infinite",
          },
          "@keyframes graphFlow": {
            from: { strokeDashoffset: 16 },
            to: { strokeDashoffset: 0 },
          },
          "@keyframes graphPulse": {
            "0%, 100%": { opacity: 0.66 },
            "50%": { opacity: 1 },
          },
          /* Travels actor → claim → organization, then holds off-screen for the
           * rest of the cycle so the eye gets a rest between runs. */
          "@keyframes graphSpark": {
            "0%": { offsetDistance: "0%", opacity: 0 },
            "8%": { opacity: 1 },
            "52%": { offsetDistance: "100%", opacity: 1 },
            "60%, 100%": { offsetDistance: "100%", opacity: 0 },
          },

          /* Pointing at a node brings it forward. Cheap, and it makes the panel
           * feel like an instrument rather than a picture of one. */
          "& .node": { cursor: "default" },
          "& .node circle": { transition: "filter 160ms ease" },
          "& .node:hover circle": { filter: `drop-shadow(0 0 10px ${alpha(colors.ion, 0.9)})` },
          "& .node:hover text": { fill: colors.text1 },

          "@media (prefers-reduced-motion: reduce)": {
            "& *": { animation: "none !important" },
            "& .spark": { display: "none" },
          },
        }}
      >
        <defs>
          <marker
            id="graph-head"
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
            id="graph-head-ion"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="5.5"
            markerHeight="5.5"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L8,4 L0,8 Z" fill={colors.ion} />
          </marker>
          <filter id="graph-glow" x="-70%" y="-70%" width="240%" height="240%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {EDGES.map((edge) => {
          const from = BY_ID.get(edge.from);
          const to = BY_ID.get(edge.to);
          if (!from || !to) return null;
          const { x1, y1, x2, y2 } = segment(from, to);
          const classes = [edge.flow ? "flow" : "", edge.accepted ? "accepted" : ""]
            .filter(Boolean)
            .join(" ");

          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              className={classes || undefined}
              stroke={edge.accepted ? colors.ion : colors.text3}
              strokeWidth={edge.accepted ? 2.4 : 1.1}
              opacity={edge.accepted ? 1 : edge.dim ? 0.34 : 0.62}
              markerEnd={edge.accepted ? "url(#graph-head-ion)" : "url(#graph-head)"}
            />
          );
        })}

        {/* The resolution path, walked. Two runs offset in time so the panel is
          * never entirely still and never busy. */}
        <Spark path="M692,68 L480,130 L280,220" />
        <Spark path="M704,374 L486,316 L280,220" delay="2.1s" />

        {NODES.map((node) => (
          <Node key={node.id} node={node} />
        ))}
      </Box>
      </Box>

      {/* Five hues means a legend is mandatory, not optional — identity must
        * never rest on colour alone. It sits under the graph rather than in the
        * header so the header keeps carrying the two semantic keys, which are
        * about edges and state rather than entity type. */}
      <Stack
        direction="row"
        gap={{ xs: 1.6, sm: 2.6 }}
        sx={{
          px: 2.4,
          py: 1.5,
          borderTop: `1px solid ${colors.edge}`,
          flexWrap: "wrap",
        }}
      >
        {GRAPH_LEGEND.map((entry) => (
          <Stack key={entry.kind} direction="row" alignItems="center" gap={0.8}>
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                border: `1.4px solid ${graphColor[entry.kind]}`,
                backgroundColor: alpha(graphColor[entry.kind], 0.22),
                flexShrink: 0,
              }}
            />
            <Typography sx={{ fontSize: 11.5, color: colors.text3 }}>{entry.label}</Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

function Node({ node }: { node: DemoNode }) {
  const isOrg = node.kind === "org";
  const hue = graphColor[node.kind];
  // Labels stay in text tokens. The ring beside them carries identity — a label
  // painted in its series colour is how a chart ends up unreadable.
  const labelTone = isOrg ? colors.text1 : node.dim ? colors.text3 : colors.text2;

  return (
    <g className="node" opacity={node.dim ? 0.5 : 1}>
      <g
        className={isOrg ? "target" : undefined}
        filter={isOrg ? "url(#graph-glow)" : undefined}
      >
        <circle
          cx={node.x}
          cy={node.y}
          r={node.r}
          fill={fillFor(node.kind)}
          stroke={hue}
          strokeWidth={isOrg ? 2 : 1.4}
          strokeDasharray={node.dim ? "3 3" : undefined}
        />
      </g>
      <text
        x={node.x}
        y={node.y + node.r + 15}
        textAnchor="middle"
        fill={labelTone}
        style={{
          fontFamily: fonts.mono,
          fontSize: isOrg ? 12 : 10,
          letterSpacing: "0.08em",
          fontWeight: isOrg ? 600 : 400,
        }}
      >
        {node.label}
      </text>
    </g>
  );
}

function Spark({ path, delay }: { path: string; delay?: string }) {
  return (
    <circle
      className="spark"
      r="4.5"
      fill={colors.ion}
      filter="url(#graph-glow)"
      style={{ offsetPath: `path("${path}")`, animationDelay: delay }}
    />
  );
}

function Key({
  swatch,
  tone,
  label,
}: {
  swatch: "edge" | "node";
  tone: string;
  label: string;
}) {
  return (
    <Stack direction="row" alignItems="center" gap={0.9}>
      {swatch === "edge" ? (
        <Box sx={{ width: 18, height: 0, borderTop: `2px solid ${tone}` }} />
      ) : (
        <Box
          sx={{
            width: 11,
            height: 11,
            borderRadius: "50%",
            border: `1px dashed ${tone}`,
            opacity: 0.6,
          }}
        />
      )}
      <Typography sx={{ fontSize: 11.5, color: colors.text3 }}>{label}</Typography>
    </Stack>
  );
}

export default GraphDemo;

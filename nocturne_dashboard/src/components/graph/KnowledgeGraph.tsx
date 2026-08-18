"use client";

import { useEffect, useRef } from "react";
import { Box } from "@mui/material";
import { colors, fonts, severityColor } from "@/theme/tokens";
import type { GraphEdge, GraphNode, GraphPayload } from "@/types";

const nodeColor: Record<string, string> = {
  claim: severityColor.high,
  organization: severityColor.critical,
  domain: colors.verified,
  actor_alias: colors.ion,
  marketplace: "#7AA4FF",
  contact_channel: "#7AA4FF",
  data_asset: severityColor.high,
  product: colors.informational,
  location: colors.informational,
};

export type GraphLayout = "force" | "spine";

export interface KnowledgeGraphProps {
  payload: GraphPayload;
  onSelectNode?: (node: GraphNode | null) => void;
  onSelectEdge?: (edge: GraphEdge | null) => void;
  /**
   * Optional secondary action for pages that want a direct graph-to-filter
   * gesture. Normal click still drives the inspector; double-click can activate
   * a node/edge without changing the default graph browsing behavior.
   */
  onActivateNode?: (node: GraphNode) => void;
  onActivateEdge?: (edge: GraphEdge) => void;
  /** A number is pixels; a string lets the caller flex it, e.g. "100%". */
  height?: number | string;
  /**
   * `spine` ranks the graph left to right along the pipeline's own direction —
   * actor, claim, then the assets it touches. `force` is the physics layout.
   */
  layout?: GraphLayout;
  /**
   * ISO cutoff for the discovery replay. Elements first seen after this instant
   * render as ghosts rather than being removed: dropping them would re-run the
   * layout on every step and the replay would read as chaos instead of
   * sequence. `null` shows everything at full strength.
   */
  discoveredBefore?: string | null;
}

type Phase = "discovered" | "arriving" | "unknown";

/** Keep the force canvas readable; the inspector owns the complete text. */
function compactNodeLabel(value: string, maxLength = 38): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Where an element sits relative to the replay cutoff. `arriving` is whatever
 * appeared at exactly this stop — the thing the current step is about.
 */
function phaseOf(firstSeen: string, cutoff: string | null | undefined): Phase {
  if (!cutoff) return "discovered";
  if (firstSeen === cutoff) return "arriving";
  return firstSeen < cutoff ? "discovered" : "unknown";
}

/**
 * G6 throws "Node already exists" on a duplicate id and the whole canvas fails
 * to mount — one repeated key takes the entire graph down rather than degrading
 * it. The warehouse view has produced such a duplicate, so dedupe here as well:
 * a graph that drops one redundant node is strictly better than a blank panel.
 * Edges are filtered to surviving endpoints for the same reason.
 */
function dedupeGraph(payload: GraphPayload): GraphPayload {
  const seenNodes = new Set<string>();
  const nodes = payload.nodes.filter((n) => {
    if (seenNodes.has(n.nodeKey)) return false;
    seenNodes.add(n.nodeKey);
    return true;
  });

  const seenEdges = new Set<string>();
  const edges = payload.edges.filter((e) => {
    if (seenEdges.has(e.graphEdgeKey)) return false;
    if (!seenNodes.has(e.sourceKey) || !seenNodes.has(e.targetKey)) return false;
    seenEdges.add(e.graphEdgeKey);
    return true;
  });

  return { ...payload, nodes, edges };
}

function nodeStyle(node: GraphNode, phase: Phase) {
  const base = nodeColor[node.nodeType] ?? colors.informational;
  const size = node.isMonitoredOrg
    ? 46
    : node.nodeType === "actor_alias"
      ? 42
      : node.nodeType === "claim"
        ? 36
        : 30;

  if (phase === "unknown") {
    return {
      size,
      fill: "transparent",
      stroke: colors.edgeHi,
      lineWidth: 1,
      lineDash: [2, 3],
      opacity: 0.45,
      cursor: "default" as const,
      labelText: "",
      shadowColor: base,
      shadowBlur: 0,
    };
  }

  const prominent = node.isMonitoredOrg || node.nodeType === "actor_alias";
  return {
    size,
    fill: `${base}33`,
    stroke: base,
    lineWidth: phase === "arriving" ? 2.4 : prominent ? 2 : 1.4,
    lineDash: 0,
    opacity: 1,
    cursor: "pointer" as const,
    labelText: compactNodeLabel(node.displayName, node.nodeType === "claim" ? 22 : 32),
    labelFill: phase === "arriving" ? colors.text1 : colors.text2,
    labelFontSize: 11,
    labelFontFamily: fonts.mono,
    labelPlacement: "bottom" as const,
    labelOffsetY: 6,
    shadowColor: base,
    shadowBlur: phase === "arriving" ? 18 : 0,
  };
}

function edgeStyle(edge: GraphEdge, phase: Phase, layout: GraphLayout) {
  const emphasis = edge.edgeType === "ALLEGEDLY_AFFECTS" || edge.edgeType === "MADE_CLAIM";
  const stroke =
    edge.edgeType === "ALLEGEDLY_AFFECTS"
      ? severityColor.critical
      : edge.edgeType === "MADE_CLAIM"
        ? colors.ion
        : "rgba(122,164,255,0.4)";

  if (phase === "unknown") {
    return {
      stroke: colors.edgeHi,
      lineWidth: 1,
      lineDash: [2, 6],
      opacity: 0.3,
      cursor: "default" as const,
      labelText: "",
      endArrow: false,
      shadowColor: colors.ion,
      shadowBlur: 0,
    };
  }

  // On the spine, thickness carries corroboration — the widest band is the
  // relationship seen on the most mirrors. The force layout keeps the flatter
  // emphasis rule so it stays readable when nodes overlap.
  const width = layout === "spine"
    ? 1 + Math.min(edge.sightingCount, 4) * 0.9
    : emphasis ? 1.8 : 1.2;

  return {
    stroke: phase === "arriving" ? colors.ionBright : stroke,
    lineWidth: phase === "arriving" ? width + 1.4 : width,
    lineDash: emphasis ? 0 : [3, 4],
    opacity: 1,
    cursor: "pointer" as const,
    // On the spine the supporting edges are already legible from the node types
    // they connect, so their labels are pure clutter along a diagonal. Keep the
    // label where the relationship is the point: who claimed it, what it hit.
    labelText: layout === "spine" && !emphasis ? "" : edge.edgeType,
    labelFill: colors.text3,
    labelFontSize: 8.5,
    labelFontFamily: fonts.mono,
    endArrow: true,
    shadowColor: colors.ion,
    shadowBlur: phase === "arriving" ? 14 : 0,
  };
}

/**
 * AntV G6 v5, scoped to one promoted component (30-150 nodes) with
 * expand-on-demand rather than rendering the whole warehouse.
 *
 * Lifecycle note: the G6 import is async, so a StrictMode double-invoke (or any
 * fast unmount) can tear the effect down *before* the instance exists. Without
 * the guards below the cleanup has nothing to destroy and every mount leaves an
 * orphaned canvas stacked in the container — clicks then land on a canvas whose
 * handlers are wired to a dead React closure, and the inspector never opens.
 */
export function KnowledgeGraph({
  payload,
  onSelectNode,
  onSelectEdge,
  onActivateNode,
  onActivateEdge,
  height = 520,
  layout = "force",
  discoveredBefore = null,
}: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);

  // Hold the cutoff in a ref so building the graph does not depend on it. If it
  // did, every scrubber step would destroy and rebuild the instance, re-running
  // the layout and throwing away the viewer's pan and zoom.
  const cutoffRef = useRef<string | null>(discoveredBefore);
  cutoffRef.current = discoveredBefore;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let instance: any = null;

    (async () => {
      const { Graph } = await import("@antv/g6");
      if (cancelled || !containerRef.current) return;

      // Remove anything an aborted previous mount left behind.
      containerRef.current.replaceChildren();

      const cutoff = cutoffRef.current;
      const safe = dedupeGraph(payload);

      instance = new Graph({
        container: containerRef.current,
        // Not `autoFit: "view"`: that scales the drawing to fill the canvas,
        // which on a sparse graph magnifies a 36px node into a 150px blob and
        // stacks the labels. Fit manually below and never zoom past 1:1, so
        // nodes keep the size they were designed at and only shrink when the
        // component genuinely does not fit.
        autoFit: undefined,
        // The container is now a flex child that changes size with the viewport.
        autoResize: true,
        data: {
          nodes: safe.nodes.map((n) => ({
            id: n.nodeKey,
            data: { ...n },
            style: nodeStyle(n, phaseOf(n.firstSeen, cutoff)),
          })),
          edges: safe.edges.map((e) => ({
            id: e.graphEdgeKey,
            source: e.sourceKey,
            target: e.targetKey,
            data: { ...e },
            style: edgeStyle(e, phaseOf(e.firstSeen, cutoff), layout),
          })),
        },
        layout:
          layout === "spine"
            ? // Wide rank separation on purpose: the panel is far wider than it
              // is tall, and a tight dagre graph fits to height and leaves half
              // the canvas empty.
              { type: "antv-dagre", rankdir: "LR", nodesep: 36, ranksep: 220 }
            : {
                // d3-force rather than G6's "force": its parameters are the
                // d3 ones and actually take effect at this scale. The actors
                // view is the dense case — ~19 nodes, most of them claims
                // carrying a sentence — so charge and link distance are set far
                // beyond the defaults to stop the labels overlapping.
                type: "d3-force",
                link: { distance: 220, strength: 0.4 },
                manyBody: { strength: -1400 },
                collide: { radius: 90, strength: 1 },
                center: { strength: 0.06 },
              },
        behaviors: ["zoom-canvas", "drag-canvas", "drag-element", "click-select", "hover-activate"],
      });

      // `target` is the G6 Element and `target.id` is the node/edge id — verified
      // against @antv/g6 5.1.1 IElementEvent, which normalizes away the raw shape.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.on("node:click", (evt: any) => {
        const id = evt?.target?.id;
        const node = payload.nodes.find((n) => n.nodeKey === id) ?? null;
        // An undiscovered ghost is not a thing the analyst knows about yet.
        if (node && phaseOf(node.firstSeen, cutoffRef.current) === "unknown") return;
        onSelectNode?.(node);
        onSelectEdge?.(null);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.on("edge:click", (evt: any) => {
        const id = evt?.target?.id;
        const edge = payload.edges.find((e) => e.graphEdgeKey === id) ?? null;
        if (edge && phaseOf(edge.firstSeen, cutoffRef.current) === "unknown") return;
        onSelectEdge?.(edge);
        onSelectNode?.(null);
      });
      // Keep single-click for inspection. Double-click is the optional direct
      // action hook used by higher-level pages for "filter Command Center".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.on("node:dblclick", (evt: any) => {
        const id = evt?.target?.id;
        const node = payload.nodes.find((n) => n.nodeKey === id) ?? null;
        if (!node || phaseOf(node.firstSeen, cutoffRef.current) === "unknown") return;
        onActivateNode?.(node);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.on("edge:dblclick", (evt: any) => {
        const id = evt?.target?.id;
        const edge = payload.edges.find((e) => e.graphEdgeKey === id) ?? null;
        if (!edge || phaseOf(edge.firstSeen, cutoffRef.current) === "unknown") return;
        onActivateEdge?.(edge);
      });
      // Only clear on a genuine empty-canvas click. Element clicks do not reach
      // here in G6 v5, but the guard keeps that an explicit contract.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.on("canvas:click", (evt: any) => {
        if (evt?.targetType && evt.targetType !== "canvas") return;
        onSelectNode?.(null);
        onSelectEdge?.(null);
      });

      await instance.render();

      try {
        await instance.fitView();
        if (instance.getZoom() > 1) await instance.zoomTo(1);
      } catch {
        /* fitView is best-effort; a rendered graph at default zoom still works */
      }

      // The effect may have been torn down while render() was in flight.
      if (cancelled) {
        try {
          instance.destroy();
        } catch {
          /* already gone */
        }
        instance = null;
        return;
      }
      graphRef.current = instance;
    })();

    return () => {
      cancelled = true;
      if (instance) {
        try {
          instance.destroy();
        } catch {
          /* already gone */
        }
        instance = null;
      }
      // Belt and braces: drop any canvas the async path may have attached.
      container.replaceChildren();
      graphRef.current = null;
    };
  }, [payload, layout, onSelectNode, onSelectEdge, onActivateNode, onActivateEdge]);

  // Restyle in place as the cutoff moves. `draw()` repaints without re-running
  // the layout, so coordinates stay put and the replay reads as a sequence.
  useEffect(() => {
    const instance = graphRef.current;
    if (!instance) return;
    let cancelled = false;

    (async () => {
      try {
        instance.updateNodeData(
          payload.nodes.map((n) => ({
            id: n.nodeKey,
            style: nodeStyle(n, phaseOf(n.firstSeen, discoveredBefore)),
          })),
        );
        instance.updateEdgeData(
          payload.edges.map((e) => ({
            id: e.graphEdgeKey,
            style: edgeStyle(e, phaseOf(e.firstSeen, discoveredBefore), layout),
          })),
        );
        if (!cancelled) await instance.draw();
      } catch {
        // A draw racing an unmount is not worth surfacing to the analyst.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [discoveredBefore, layout, payload]);

  return (
    <Box
      ref={containerRef}
      sx={{
        width: "100%",
        height,
        minWidth: 0,
        // A percentage height only resolves if this element is also allowed to
        // consume the flex line it sits on.
        ...(height === "100%" ? { flex: 1, minHeight: 0 } : null),
      }}
    />
  );
}

export default KnowledgeGraph;

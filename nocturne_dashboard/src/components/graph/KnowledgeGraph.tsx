"use client";

import { useEffect, useRef } from "react";
import { Box } from "@mui/material";
import { colors, fonts, severityColor } from "@/theme/tokens";
import type { GraphEdge, GraphNode, GraphPayload } from "@/types";

const nodeColor: Record<string, string> = {
  organization: severityColor.critical,
  domain: colors.verified,
  actor_alias: colors.ion,
  marketplace: "#7AA4FF",
  contact_channel: "#7AA4FF",
  data_asset: severityColor.high,
  product: colors.informational,
  location: colors.informational,
};

export interface KnowledgeGraphProps {
  payload: GraphPayload;
  onSelectNode?: (node: GraphNode | null) => void;
  onSelectEdge?: (edge: GraphEdge | null) => void;
  height?: number;
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
  height = 520,
}: KnowledgeGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);

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

      instance = new Graph({
        container: containerRef.current,
        autoFit: "view",
        data: {
          nodes: payload.nodes.map((n) => ({
            id: n.nodeKey,
            data: { ...n },
            style: {
              size: n.isMonitoredOrg ? 46 : n.nodeType === "actor_alias" ? 42 : 30,
              fill: `${nodeColor[n.nodeType] ?? colors.informational}33`,
              stroke: nodeColor[n.nodeType] ?? colors.informational,
              lineWidth: n.isMonitoredOrg || n.nodeType === "actor_alias" ? 2 : 1.4,
              cursor: "pointer",
              labelText: n.displayName,
              labelFill: colors.text1,
              labelFontSize: 11,
              labelFontFamily: fonts.mono,
              labelPlacement: "bottom",
              labelOffsetY: 6,
            },
          })),
          edges: payload.edges.map((e) => ({
            id: e.graphEdgeKey,
            source: e.sourceKey,
            target: e.targetKey,
            data: { ...e },
            style: {
              stroke:
                e.edgeType === "ALLEGEDLY_AFFECTS"
                  ? severityColor.critical
                  : e.edgeType === "MADE_CLAIM"
                    ? colors.ion
                    : "rgba(122,164,255,0.4)",
              lineWidth:
                e.edgeType === "ALLEGEDLY_AFFECTS" || e.edgeType === "MADE_CLAIM" ? 1.8 : 1.2,
              lineDash:
                e.edgeType === "ALLEGEDLY_AFFECTS" || e.edgeType === "MADE_CLAIM" ? 0 : [3, 4],
              cursor: "pointer",
              labelText: e.edgeType,
              labelFill: colors.text3,
              labelFontSize: 8.5,
              labelFontFamily: fonts.mono,
              endArrow: true,
            },
          })),
        },
        layout: { type: "force", preventOverlap: true, nodeSize: 60, linkDistance: 150 },
        behaviors: ["zoom-canvas", "drag-canvas", "drag-element", "click-select", "hover-activate"],
      });

      // `target` is the G6 Element and `target.id` is the node/edge id — verified
      // against @antv/g6 5.1.1 IElementEvent, which normalizes away the raw shape.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.on("node:click", (evt: any) => {
        const id = evt?.target?.id;
        onSelectNode?.(payload.nodes.find((n) => n.nodeKey === id) ?? null);
        onSelectEdge?.(null);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      instance.on("edge:click", (evt: any) => {
        const id = evt?.target?.id;
        onSelectEdge?.(payload.edges.find((e) => e.graphEdgeKey === id) ?? null);
        onSelectNode?.(null);
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
  }, [payload, onSelectNode, onSelectEdge]);

  return <Box ref={containerRef} sx={{ width: "100%", height, minWidth: 0 }} />;
}

export default KnowledgeGraph;

import type { GraphPayload } from "@/types";

/**
 * Timeline helpers for the discovery replay.
 *
 * The replay is driven by edges, not nodes. A relationship is the unit of
 * discovery — "we learned NightFox listed this on darkbay" — whereas an
 * isolated node carries no claim about the incident. Nodes therefore light up
 * when their first edge arrives.
 */

/** Distinct edge FIRST_SEEN values, oldest first. These are the replay stops. */
export function timelineStops(payload: GraphPayload): string[] {
  return [...new Set(payload.edges.map((edge) => edge.firstSeen).filter(Boolean))].sort();
}

/**
 * Rewrite each node's `firstSeen` to the earliest edge that touches it.
 *
 * Without this a node whose own FIRST_SEEN is later than a relationship it
 * participates in would render as an undiscovered ghost with a live edge
 * running into it. Isolated nodes keep their own timestamp.
 */
export function withDerivedNodeDiscovery(payload: GraphPayload): GraphPayload {
  const earliest = new Map<string, string>();
  for (const edge of payload.edges) {
    if (!edge.firstSeen) continue;
    for (const key of [edge.sourceKey, edge.targetKey]) {
      const current = earliest.get(key);
      if (current === undefined || edge.firstSeen < current) earliest.set(key, edge.firstSeen);
    }
  }

  return {
    ...payload,
    nodes: payload.nodes.map((node) => {
      const derived = earliest.get(node.nodeKey);
      return derived ? { ...node, firstSeen: derived } : node;
    }),
  };
}

/** How many edges have been discovered at or before `cutoff`. */
export function revealedEdgeCount(payload: GraphPayload, cutoff: string | null): number {
  if (!cutoff) return payload.edges.length;
  return payload.edges.filter((edge) => edge.firstSeen <= cutoff).length;
}

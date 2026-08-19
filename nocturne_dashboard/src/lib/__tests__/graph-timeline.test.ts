import { describe, expect, it } from "vitest";

import {
  revealedEdgeCount,
  timelineStops,
  withDerivedNodeDiscovery,
} from "@/lib/graph-timeline";
import type { GraphPayload } from "@/types";

function payload(
  nodes: Array<{ nodeKey: string; firstSeen: string }>,
  edges: Array<{ sourceKey: string; targetKey: string; firstSeen: string }>,
): GraphPayload {
  return {
    nodes: nodes.map((node) => ({ ...node, displayName: node.nodeKey })),
    edges: edges.map((edge, index) => ({ ...edge, graphEdgeKey: `e${index}` })),
    scope: { kind: "org", orgId: "acme_corp" },
    rootKey: null,
  } as unknown as GraphPayload;
}

describe("timelineStops", () => {
  it("returns distinct edge timestamps oldest first", () => {
    const stops = timelineStops(
      payload([], [
        { sourceKey: "a", targetKey: "b", firstSeen: "2026-08-03T00:00:00Z" },
        { sourceKey: "b", targetKey: "c", firstSeen: "2026-08-01T00:00:00Z" },
        { sourceKey: "a", targetKey: "c", firstSeen: "2026-08-03T00:00:00Z" },
      ]),
    );
    expect(stops).toEqual(["2026-08-01T00:00:00Z", "2026-08-03T00:00:00Z"]);
  });

  it("drops edges with no timestamp", () => {
    const stops = timelineStops(
      payload([], [{ sourceKey: "a", targetKey: "b", firstSeen: "" }]),
    );
    expect(stops).toEqual([]);
  });

  it("is empty for a graph with no edges", () => {
    expect(timelineStops(payload([{ nodeKey: "a", firstSeen: "2026-08-01T00:00:00Z" }], []))).toEqual([]);
  });
});

describe("withDerivedNodeDiscovery", () => {
  it("pulls a node back to its earliest touching edge", () => {
    // Otherwise a node whose own FIRST_SEEN is later than a relationship it
    // participates in renders as an undiscovered ghost with a live edge
    // running into it.
    const result = withDerivedNodeDiscovery(
      payload(
        [{ nodeKey: "actor", firstSeen: "2026-08-10T00:00:00Z" }],
        [
          { sourceKey: "actor", targetKey: "claim", firstSeen: "2026-08-05T00:00:00Z" },
          { sourceKey: "actor", targetKey: "venue", firstSeen: "2026-08-02T00:00:00Z" },
        ],
      ),
    );
    expect(result.nodes[0].firstSeen).toBe("2026-08-02T00:00:00Z");
  });

  it("leaves an isolated node on its own timestamp", () => {
    const result = withDerivedNodeDiscovery(
      payload([{ nodeKey: "orphan", firstSeen: "2026-08-10T00:00:00Z" }], []),
    );
    expect(result.nodes[0].firstSeen).toBe("2026-08-10T00:00:00Z");
  });

  it("ignores edges carrying no timestamp", () => {
    const result = withDerivedNodeDiscovery(
      payload(
        [{ nodeKey: "actor", firstSeen: "2026-08-10T00:00:00Z" }],
        [{ sourceKey: "actor", targetKey: "claim", firstSeen: "" }],
      ),
    );
    expect(result.nodes[0].firstSeen).toBe("2026-08-10T00:00:00Z");
  });

  it("does not mutate the payload it was given", () => {
    const original = payload(
      [{ nodeKey: "actor", firstSeen: "2026-08-10T00:00:00Z" }],
      [{ sourceKey: "actor", targetKey: "claim", firstSeen: "2026-08-05T00:00:00Z" }],
    );
    withDerivedNodeDiscovery(original);
    expect(original.nodes[0].firstSeen).toBe("2026-08-10T00:00:00Z");
  });
});

describe("revealedEdgeCount", () => {
  const graph = payload([], [
    { sourceKey: "a", targetKey: "b", firstSeen: "2026-08-01T00:00:00Z" },
    { sourceKey: "b", targetKey: "c", firstSeen: "2026-08-05T00:00:00Z" },
    { sourceKey: "c", targetKey: "d", firstSeen: "2026-08-09T00:00:00Z" },
  ]);

  it("reveals everything when the replay is not scrubbed", () => {
    expect(revealedEdgeCount(graph, null)).toBe(3);
  });

  it("counts edges at or before the cutoff", () => {
    expect(revealedEdgeCount(graph, "2026-08-05T00:00:00Z")).toBe(2);
  });

  it("reveals nothing before the first edge", () => {
    expect(revealedEdgeCount(graph, "2026-07-01T00:00:00Z")).toBe(0);
  });
});

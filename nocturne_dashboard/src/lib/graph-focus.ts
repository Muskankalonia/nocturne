/**
 * Graph focus: turning a click on the canvas into a filter over incidents.
 *
 * The graph and the Command Center are drawn from different views — one from
 * the promoted node/edge tables, the other from VW_INCIDENTS — so a click has
 * to be translated before it can filter anything. There are two translations
 * available, and this module owns both because they must agree:
 *
 *   1. Local, instant. Walk the graph payload the browser already holds out to
 *      the actor aliases connected to the selection, then match incidents by
 *      ACTOR_NODE_KEY (or by actor name, which is what the demo tenant and any
 *      re-keyed fixture have in common). Costs nothing and lands in the same
 *      frame as the click.
 *
 *   2. Exact, one round trip. VW_INCIDENT_GRAPH_NODES carries INCIDENT_KEY
 *      beside NODE_KEY, so the server can answer "which incidents contain this
 *      node" precisely — including incidents that were never attributed to an
 *      actor, which the walk above cannot reach.
 *
 * The context applies (1) immediately and upgrades to (2) when it arrives, so
 * the page never waits on the network to respond to a click and never settles
 * on the approximation when the exact answer is available.
 *
 * Pure and dependency-free: the API route, the context and the canvas all read
 * the same key rules, and none of them may disagree about what a click means.
 */

import type { EdgeType, EntityType, GraphEdge, GraphNode, GraphPayload } from "@/types";

/** The URL parameter that makes a focused Command Center a shareable link. */
export const FOCUS_QUERY_PARAM = "focus";

/**
 * The Actor Network rolls every claim an actor made into one synthetic node so
 * the canvas stays readable. That node exists only in the query that builds
 * that view — the warehouse has never heard of it — so it has to be unwrapped
 * back to the actor before any key is sent anywhere.
 */
export const ACTOR_CLAIM_BUNDLE_PREFIX = "actor_claim_bundle:";

export type GraphFocusOrigin = "node" | "edge";

export interface GraphFocus {
  /** Canonical node key: bundle wrappers removed, safe to send to the API. */
  nodeKey: string;
  label: string;
  /** Null only for a focus restored from a link, until the API names it. */
  nodeType: EntityType | "claim" | null;
  origin: GraphFocusOrigin;
  /** Set when the focus came from an edge — shown in the banner as context. */
  edgeType?: EdgeType;
}

/** How the incident set behind a focus was arrived at. */
export type GraphFocusPrecision = "exact" | "attributed" | "empty";

/** Node keys the warehouse can actually be asked about. */
export function canonicalNodeKey(nodeKey: string): string {
  return nodeKey.startsWith(ACTOR_CLAIM_BUNDLE_PREFIX)
    ? nodeKey.slice(ACTOR_CLAIM_BUNDLE_PREFIX.length)
    : nodeKey;
}

/**
 * Node keys are SHA2 hex in the warehouse and readable slugs in the demo
 * tenant, so this cannot be tightened to a hash. It exists to bound the cache
 * key space and reject anything that is obviously not a key — the query itself
 * is parameterized, so this is not the injection defence.
 *
 * Spaces are allowed because the demo tenant produces them: its fixtures are
 * rewritten to scrub the organization they were authored from, and that
 * rewrite runs over node keys too, turning `n-domain-odido` into
 * `n-domain-Demo Organization`. Rejecting that shape made every click on the
 * demo tenant fall back to approximate matching.
 */
export const GRAPH_NODE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _:.-]{0,159}$/;

/** A short, canvas-free label. Claim statements are sentences, not names. */
function focusLabel(node: GraphNode): string {
  const text = (node.displayName ?? "").replace(/\s+/g, " ").trim();
  if (!text) return node.nodeKey.slice(0, 12);
  return text.length <= 64 ? text : `${text.slice(0, 63).trimEnd()}…`;
}

export function focusFromNode(node: GraphNode): GraphFocus {
  return {
    nodeKey: canonicalNodeKey(node.nodeKey),
    label: focusLabel(node),
    nodeType: node.nodeType,
    origin: "node",
  };
}

/**
 * An edge's focus is the actor at one of its ends when there is one, and its
 * source otherwise.
 *
 * The judges' phrasing — "click actor nodes or claim edges" — is the reason:
 * on `MADE_CLAIM` the analyst is pointing at the actor, and on a claim's
 * `ALLEGEDLY_AFFECTS` they are pointing at the claim, which is the source. So
 * preferring an actor end and falling back to the source lands on the thing
 * being pointed at in both cases.
 */
export function focusFromEdge(
  edge: GraphEdge,
  nodes: readonly GraphNode[],
): GraphFocus | null {
  const byKey = new Map(nodes.map((node) => [node.nodeKey, node]));
  const source = byKey.get(edge.sourceKey) ?? null;
  const target = byKey.get(edge.targetKey) ?? null;

  const preferred =
    (source?.nodeType === "actor_alias" && source)
    || (target?.nodeType === "actor_alias" && target)
    || source
    || target;
  if (!preferred) return null;

  return { ...focusFromNode(preferred), origin: "edge", edgeType: edge.edgeType };
}

/**
 * Every element within one hop of the focus, for dimming the rest of the canvas.
 *
 * One hop rather than a full component walk: two hops from an actor in these
 * graphs is most of the graph, so it would dim nothing and read as a bug.
 * Bundle nodes count as their actor so selecting either lights up both.
 */
export function focusNeighbourhood(
  payload: GraphPayload | null,
  focusNodeKey: string | null,
): { nodes: Set<string>; edges: Set<string> } | null {
  if (!focusNodeKey || !payload) return null;

  const nodes = new Set<string>();
  const edges = new Set<string>();
  const matches = (key: string) => canonicalNodeKey(key) === focusNodeKey;

  for (const node of payload.nodes) {
    if (matches(node.nodeKey)) nodes.add(node.nodeKey);
  }
  for (const edge of payload.edges) {
    if (!matches(edge.sourceKey) && !matches(edge.targetKey)) continue;
    edges.add(edge.graphEdgeKey);
    nodes.add(edge.sourceKey);
    nodes.add(edge.targetKey);
  }

  return nodes.size > 0 ? { nodes, edges } : null;
}

/**
 * The actor aliases reachable from the focus, as both keys and lowercased
 * names.
 *
 * Names are carried alongside keys because the two sides of this join are not
 * guaranteed to be keyed identically — VW_INCIDENTS resolves ACTOR_NODE_KEY
 * through DT_L3_ACTOR_CREDIBILITY while the canvas draws DIM_GRAPH_NODE, and
 * the demo tenant's fixtures were authored with neither. Matching on either
 * one keeps the click meaningful in all three cases.
 */
export function reachableActors(
  focus: GraphFocus | null,
  payload: GraphPayload | null,
): { keys: Set<string>; names: Set<string> } {
  const keys = new Set<string>();
  const names = new Set<string>();
  if (!focus || !payload) return { keys, names };

  // An actor and its claim bundle share a canonical key, so the actor has to
  // win the index — otherwise looking up that key returns the bundle, whose
  // type is "claim", and the walk below decides there is no actor there.
  const byKey = new Map<string, GraphNode>();
  for (const node of payload.nodes) {
    const key = canonicalNodeKey(node.nodeKey);
    const existing = byKey.get(key);
    if (!existing || (existing.nodeType !== "actor_alias" && node.nodeType === "actor_alias")) {
      byKey.set(key, node);
    }
  }

  const claim = (key: string) => {
    const node = byKey.get(key);
    if (!node || node.nodeType !== "actor_alias") return;
    keys.add(canonicalNodeKey(node.nodeKey));
    const name = node.displayName?.trim().toLowerCase();
    if (name) names.add(name);
  };

  // Clicked the actor itself: that is the answer, and widening from here would
  // sweep in every actor sharing a marketplace with them.
  if (byKey.get(focus.nodeKey)?.nodeType === "actor_alias") {
    claim(focus.nodeKey);
    return { keys, names };
  }

  const adjacency = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    const bucket = adjacency.get(from) ?? new Set<string>();
    bucket.add(to);
    adjacency.set(from, bucket);
  };
  for (const edge of payload.edges) {
    const source = canonicalNodeKey(edge.sourceKey);
    const target = canonicalNodeKey(edge.targetKey);
    link(source, target);
    link(target, source);
  }

  // Two hops, because that is the shape of this graph: an actor reaches a
  // domain or a data asset *through* the claim that named it. One hop finds
  // actors only from claims, which is exactly the case where the analyst did
  // not need help — they were already looking at the claim.
  const seen = new Set<string>([focus.nodeKey]);
  let frontier = [focus.nodeKey];
  for (let depth = 0; depth < 2; depth += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const neighbour of adjacency.get(key) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        claim(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
  }

  return { keys, names };
}

/** Incidents attributed to any of the given actors. Order is not disturbed. */
export function incidentsForActors<
  T extends { incidentKey: string; actorNodeKey: string | null; actorName: string | null },
>(incidents: readonly T[], actors: { keys: Set<string>; names: Set<string> }): string[] {
  if (actors.keys.size === 0 && actors.names.size === 0) return [];
  return incidents
    .filter((incident) => {
      if (incident.actorNodeKey && actors.keys.has(incident.actorNodeKey)) return true;
      const name = incident.actorName?.trim().toLowerCase();
      return Boolean(name && actors.names.has(name));
    })
    .map((incident) => incident.incidentKey);
}

/**
 * The incident keys a click can be answered with before the network replies —
 * or nothing, when no local answer is trustworthy enough to show.
 *
 * Only an actor selection qualifies. "Incidents attributed to this actor" is
 * the exact relation the Command Center's own Actor column displays, so for an
 * actor node the instant answer and the warehouse's answer agree and the page
 * can filter in the same frame as the click.
 *
 * For anything else the local answer is reached by walking out to whatever
 * actors touch the entity, which is a different and much broader question:
 * measured against a live tenant, clicking one domain attributed 54 incidents
 * where the incident graph contains 21. Filtering to the wrong number and
 * correcting it two seconds later is worse than briefly saying so, which is
 * what returning nothing here makes the banner do.
 */
export function instantIncidentKeys<
  T extends { incidentKey: string; actorNodeKey: string | null; actorName: string | null },
>(
  focus: GraphFocus | null,
  payload: GraphPayload | null,
  incidents: readonly T[],
): string[] {
  if (!focus || focus.nodeType !== "actor_alias") return [];
  return incidentsForActors(incidents, reachableActors(focus, payload));
}

/** Response shape of `/api/graph-focus`. */
export interface GraphFocusResolution {
  nodeKey: string;
  displayName: string | null;
  nodeType: string | null;
  incidentKeys: string[];
  fetchedAt: string;
}

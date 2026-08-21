"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Box,
  Button,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Panel } from "@/components/ui/Panel";
import { EvidenceQuote } from "@/components/ui/EvidenceQuote";
import { DataGapNote, PageHeader, Tag } from "@/components/ui/Primitives";
import { DiscoveryScrubber } from "@/components/graph/DiscoveryScrubber";
import { CanvasSkeleton } from "@/components/ui/Skeletons";
import { GraphSummaryPanel } from "@/components/graph/GraphSummaryPanel";
import type { GraphLayout } from "@/components/graph/KnowledgeGraph";
import {
  revealedEdgeCount,
  timelineStops,
  withDerivedNodeDiscovery,
} from "@/lib/graph-timeline";
import { colors, fonts, layout as layoutTokens, severityColor } from "@/theme/tokens";
import type { GraphEdge, GraphNode } from "@/types";
import type {
  KnowledgeGraphResponse,
  KnowledgeGraphView,
} from "@/types/dashboard";

// G6 reads `window` at module scope, so it cannot be server-rendered.
const KnowledgeGraph = dynamic(() => import("@/components/graph/KnowledgeGraph"), {
  ssr: false,
  // G6 and its layout engine are a large chunk. Hold the canvas's footprint so
  // the panel does not resize when the graph mounts.
  loading: () => <CanvasSkeleton height="100%" />,
});

const typeColor: Record<string, string> = {
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

function defaultLayoutForView(view: KnowledgeGraphView): GraphLayout {
  return view === "actors" ? "spine" : "force";
}

const configuredRefreshMs = Number(
  process.env.NEXT_PUBLIC_DASHBOARD_REFRESH_MS ?? "300000",
);
const refreshIntervalMs =
  Number.isFinite(configuredRefreshMs) && configuredRefreshMs >= 30_000
    ? configuredRefreshMs
    : 300_000;

export default function GraphPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { session, isLoading: isAuthLoading, isFleetScope } = useAuth();
  const view: KnowledgeGraphView = searchParams.get("view") === "actors"
    ? "actors"
    : "incident";
  const requestedIncidentKey = searchParams.get("incidentKey");

  const [data, setData] = useState<KnowledgeGraphResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [node, setNode] = useState<GraphNode | null>(null);
  const [edge, setEdge] = useState<GraphEdge | null>(null);

  const [layout, setLayout] = useState<GraphLayout>(() => defaultLayoutForView(view));
  const [stopIndex, setStopIndex] = useState(Number.MAX_SAFE_INTEGER);

  const load = useCallback(async (signal?: AbortSignal, background = false) => {
    if (!session || session.scope.kind !== "org") return;
    if (background) setIsRefreshing(true);

    const query = new URLSearchParams({ view });
    if (session.user.role === "SUPER_ADMIN") {
      query.set("orgId", session.scope.orgId);
    }
    if (view === "incident" && requestedIncidentKey) {
      query.set("incidentKey", requestedIncidentKey);
    }

    try {
      const response = await fetch(`/api/knowledge-graph?${query.toString()}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const body = (await response.json()) as
        | KnowledgeGraphResponse
        | { error?: string };
      if (!response.ok || !("nodes" in body) || !("edges" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Unable to load live knowledge-graph data.",
        );
      }
      if (
        body.scope.kind !== "org"
        || body.scope.orgId !== session.scope.orgId
      ) {
        throw new Error("The graph response did not match the selected organization.");
      }
      setData(body);
      setError(null);
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load live knowledge-graph data.",
      );
    } finally {
      if (background) setIsRefreshing(false);
    }
  }, [requestedIncidentKey, session, view]);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!session || session.scope.kind !== "org") {
      setData(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setData(null);
    setError(null);
    setIsLoading(true);
    void load(controller.signal).finally(() => {
      if (!controller.signal.aborted) setIsLoading(false);
    });

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void load(controller.signal, true);
      }
    };
    const interval = window.setInterval(refreshWhenVisible, refreshIntervalMs);
    window.addEventListener("focus", refreshWhenVisible);

    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [isAuthLoading, load, session]);

  // Incident mode defaults to force exploration; actor mode defaults to the
  // spine because it is an aggregate relationship map.
  useEffect(() => {
    setLayout(defaultLayoutForView(view));
  }, [view]);

  useEffect(() => {
    setNode(null);
    setEdge(null);
  }, [data]);

  const payload = useMemo(
    () => data ? withDerivedNodeDiscovery(data) : null,
    [data],
  );

  const stops = useMemo(() => payload ? timelineStops(payload) : [], [payload]);
  const autoPlayKey = data
    ? [
        data.scope.kind === "org" ? data.scope.orgId : "fleet",
        view,
        layout,
        requestedIncidentKey ?? "all",
        data.fetchedAt,
        payload?.nodes.length ?? 0,
        payload?.edges.length ?? 0,
      ].join(":")
    : null;

  // Start at the first real discovery whenever a new graph arrives. The
  // scrubber receives `autoPlayKey` below and replays forward from here; manual
  // dragging still takes over afterward.
  useEffect(() => {
    setStopIndex(0);
  }, [autoPlayKey]);

  const cutoff = stops.length > 1 ? (stops[Math.min(stopIndex, stops.length - 1)] ?? null) : null;
  const revealed = payload ? revealedEdgeCount(payload, cutoff) : 0;

  const handleNode = useCallback((n: GraphNode | null) => setNode(n), []);
  const handleEdge = useCallback((e: GraphEdge | null) => setEdge(e), []);
  const handleLayoutChange = useCallback((next: GraphLayout | null) => {
    if (!next || next === layout) return;
    setNode(null);
    setEdge(null);
    setStopIndex(0);
    setLayout(next);
  }, [layout]);

  // Clear an inspector selection that the replay has rewound past.
  useEffect(() => {
    if (!cutoff) return;
    if (edge && edge.firstSeen > cutoff) setEdge(null);
    if (node && node.firstSeen > cutoff) setNode(null);
  }, [cutoff, edge, node]);

  const typeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of payload?.nodes ?? []) {
      map.set(n.nodeType, (map.get(n.nodeType) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [payload]);

  const title = view === "actors" ? "Actor Network" : "Knowledge Graph";
  const subtitle = view === "actors"
    ? "Actor-centric aggregate: who made claims, where they listed them, and which monitored assets they target."
    : requestedIncidentKey
      ? "One promoted incident component. Click a node for resolution details or an edge for its grounded evidence."
      : "Organization-wide incident graph: claim-level evidence components across every confirmed target incident.";
  const headerRight = (
    <Stack direction="row" gap={1} alignItems="center">
      {data && (
        <Typography sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.text3 }}>
          LIVE SNOWFLAKE · {new Date(data.fetchedAt).toLocaleString()}
        </Typography>
      )}
      <Button
        size="small"
        variant="outlined"
        startIcon={<RefreshCw size={13} />}
        disabled={!session || isFleetScope || isLoading || isRefreshing}
        onClick={() => void load(undefined, true)}
      >
        {isRefreshing ? "Refreshing" : "Refresh"}
      </Button>
    </Stack>
  );

  if (isAuthLoading || isLoading) {
    return (
      <Stack gap={2} sx={{ height: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)` }}>
        <PageHeader title={title} subtitle={subtitle} right={headerRight} />
        <Panel padded={false} sx={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <CanvasSkeleton height="100%" />
        </Panel>
      </Stack>
    );
  }

  if (!payload || !data) {
    return (
      <Stack gap={2} sx={{ height: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)` }}>
        <PageHeader title={title} subtitle={subtitle} right={headerRight} />
        <Panel sx={{ flex: 1 }}>
          <Stack gap={1.2} alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
            <Typography sx={{ color: colors.text1, fontSize: 14 }}>
              {isFleetScope
                ? "Select one organization to open its isolated knowledge graph."
                : "Knowledge graph unavailable"}
            </Typography>
            {!isFleetScope && (
              <Typography sx={{ color: colors.critical, fontSize: 12 }}>
                {error ?? "No promoted incident graph exists for this organization yet."}
              </Typography>
            )}
          </Stack>
        </Panel>
      </Stack>
    );
  }

  if (payload.nodes.length === 0) {
    return (
      <Stack gap={2} sx={{ height: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)` }}>
        <PageHeader title={title} subtitle={subtitle} right={headerRight} />
        <Panel sx={{ flex: 1 }}>
          <Stack gap={1.2} alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
            <Typography sx={{ color: colors.text1, fontSize: 14 }}>
              No promoted graph relationships are available yet.
            </Typography>
            <Typography sx={{ color: colors.text3, fontSize: 12 }}>
              The graph appears after L2 ownership is confirmed and its grounded component reaches L3.
            </Typography>
          </Stack>
        </Panel>
      </Stack>
    );
  }

  return (
    // The shell contributes a 52px header and 16px of vertical main padding
    // top and bottom. Claim what is left so the panel reaches the fold instead
    // of stopping at a fixed 520px and leaving dead space beneath it.
    <Stack gap={2} sx={{ height: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)` }}>
      <PageHeader
        title={title}
        subtitle={subtitle}
        right={headerRight}
      />

      <Panel
        padded={false}
        sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <Stack
          direction="row"
          gap={1}
          flexWrap="wrap"
          alignItems="center"
          sx={{ px: 2, py: 1.5, borderBottom: `1px solid ${colors.edge}`, flexShrink: 0 }}
        >
          {typeCounts.map(([type, count]) => (
            <Stack key={type} direction="row" alignItems="center" gap={0.7}>
              <Box
                sx={{
                  width: 9,
                  height: 9,
                  borderRadius: "2px",
                  backgroundColor: typeColor[type] ?? colors.informational,
                }}
              />
              <Typography sx={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.text2 }}>
                {type} {count}
              </Typography>
            </Stack>
          ))}
          {data.rootIncident && (
            <Button
              size="small"
              variant="text"
              endIcon={<ExternalLink size={12} />}
              onClick={() => router.push(
                `/leaks/${encodeURIComponent(data.rootIncident!.incidentKey)}`,
              )}
              sx={{ ml: 1, maxWidth: 360 }}
            >
              <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {data.rootIncident.title}
              </Box>
            </Button>
          )}
          {error && (
            <Typography sx={{ fontFamily: fonts.mono, fontSize: 9.5, color: colors.medium }}>
              Refresh failed · showing last successful result
            </Typography>
          )}
          <Stack direction="row" gap={1.5} alignItems="center" sx={{ ml: "auto" }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={layout}
              onChange={(_, next: GraphLayout | null) => handleLayoutChange(next)}
              aria-label="Graph layout"
              sx={{
                "& .MuiToggleButton-root": {
                  fontFamily: fonts.mono,
                  fontSize: 9.5,
                  letterSpacing: "0.1em",
                  py: 0.4,
                  px: 1.2,
                  color: colors.text3,
                  borderColor: colors.edge,
                  "&.Mui-selected": {
                    color: colors.ionBright,
                    backgroundColor: "rgba(76,141,255,0.14)",
                    "&:hover": { backgroundColor: "rgba(76,141,255,0.20)" },
                  },
                },
              }}
            >
              <ToggleButton value="force">FORCE</ToggleButton>
              <ToggleButton value="spine">SPINE</ToggleButton>
            </ToggleButtonGroup>
            <Typography sx={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.text3 }}>
              {data.incidentCount} {data.incidentCount === 1 ? "INCIDENT" : "INCIDENTS"} ·{" "}
              {payload.nodes.length} NODES · {payload.edges.length} EDGES
            </Typography>
          </Stack>
        </Stack>

        <Stack direction={{ xs: "column", lg: "row" }} sx={{ flex: 1, minHeight: 0 }}>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
              borderRight: { lg: `1px solid ${colors.edge}` },
            }}
          >
            <KnowledgeGraph
              payload={payload}
              onSelectNode={handleNode}
              onSelectEdge={handleEdge}
              layout={layout}
              discoveredBefore={cutoff}
              height="100%"
            />
            <DiscoveryScrubber
              timestamps={stops}
              stopIndex={stopIndex}
              onStopIndexChange={setStopIndex}
              autoPlayKey={autoPlayKey}
              revealedLabel={`${revealed} of ${payload.edges.length} relationships`}
            />
          </Box>

          <Box
            sx={{
              width: { xs: "100%", lg: 320 },
              flexShrink: 0,
              p: 2,
              minHeight: 0,
              overflowY: "auto",
            }}
          >
            {!node && !edge && (
              <Stack gap={1.5}>
                {data.scope.kind === "org" && (
                  <GraphSummaryPanel
                    orgId={data.scope.orgId}
                    view={view}
                    incidentKey={data.rootIncident?.incidentKey ?? null}
                    graphSignature={`${view}:${data.rootIncident?.incidentKey ?? "-"}:${payload.nodes.length}:${payload.edges.length}`}
                  />
                )}
                <Typography variant="overline">Inspector</Typography>
                <Typography sx={{ fontSize: 12, color: colors.text3, lineHeight: 1.7 }}>
                  Click a node to see how it resolved, or an edge to read the verbatim quote that
                  produced it.
                </Typography>
                <Box sx={{ mt: 1 }}>
                  <Typography variant="overline" sx={{ display: "block", mb: 1 }}>
                    Interactions
                  </Typography>
                  <Stack gap={0.7}>
                    {[
                      "Scroll to zoom, drag to pan",
                      "Drag a node to rearrange",
                      "Click a node → resolution detail",
                      "Click an edge → evidence quote",
                      "Spine ribbon thickness → corroboration",
                      "Play the timeline → discovery order",
                    ].map((t) => (
                      <Typography key={t} sx={{ fontSize: 11.5, color: colors.text2 }}>
                        · {t}
                      </Typography>
                    ))}
                  </Stack>
                </Box>
              </Stack>
            )}

            {edge && (
              <Stack gap={1.6}>
                <Typography variant="overline">Selected edge</Typography>
                <Stack direction="row" gap={0.8} alignItems="center" flexWrap="wrap">
                  <Tag tone="ion">{edge.sourceType}</Tag>
                  <Box sx={{ color: severityColor.critical }}>→</Box>
                  <Tag tone="critical">{edge.edgeType}</Tag>
                  <Box sx={{ color: severityColor.critical }}>→</Box>
                  <Tag>{edge.targetType}</Tag>
                </Stack>

                <Box>
                  <Typography variant="overline" sx={{ display: "block", mb: 1 }}>
                    Evidence that created it
                  </Typography>
                  <EvidenceQuote
                    highlight={edge.sampleEvidenceText}
                    start={edge.evidenceStart}
                    end={edge.evidenceEnd}
                    level={edge.groundingLevel}
                  />
                </Box>

                <Stack gap={0.8}>
                  <Kv k="Grounding" v={edge.groundingLevel} color={colors.verified} />
                  <Kv k="Mentions" v={String(edge.mentionCount)} />
                  <Kv k="Sightings" v={String(edge.sightingCount)} />
                  <Kv k="Independent" v={String(edge.docCount)} />
                  <Kv k="First seen" v={new Date(edge.firstSeen).toLocaleString()} />
                  <Kv k="Last seen" v={new Date(edge.lastSeen).toLocaleString()} />
                </Stack>
              </Stack>
            )}

            {node && (
              <Stack gap={1.6}>
                <Typography variant="overline">Selected node</Typography>
                <Box>
                  <Typography sx={{ fontSize: 15, fontWeight: 600 }}>
                    {node.nodeType === "claim" ? "Grounded leak claim" : node.displayName}
                  </Typography>
                  <Stack direction="row" gap={0.6} sx={{ mt: 0.8 }} flexWrap="wrap">
                    <Tag tone={node.isMonitoredOrg ? "critical" : "neutral"}>{node.nodeType}</Tag>
                    {node.isMonitoredOrg && <Tag tone="critical">monitored</Tag>}
                  </Stack>
                </Box>

                {node.description
                  && (node.nodeType === "claim" || node.description !== node.displayName) && (
                    <Box>
                      <Typography variant="overline" sx={{ display: "block", mb: 0.8 }}>
                        Description
                      </Typography>
                      <Typography
                        sx={{
                          fontSize: 12,
                          color: colors.text2,
                          lineHeight: 1.7,
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {node.description}
                      </Typography>
                    </Box>
                  )}

                <Stack gap={0.8}>
                  {node.entityMatchMethod && (
                    <Kv
                      k="Resolved by"
                      v={node.entityMatchMethod}
                      color={node.entityMatchStatus === "confirmed" ? colors.verified : colors.medium}
                    />
                  )}
                  {node.entityMatchConfidence !== undefined && (
                    <Kv k="Confidence" v={String(node.entityMatchConfidence)} />
                  )}
                  <Kv k="Mentions" v={String(node.mentionCount)} />
                  <Kv k="Sightings" v={String(node.sightingCount)} />
                  <Kv k="Independent" v={String(node.docCount)} />
                  <Kv k="Reposts" v={String(node.mirrorSightingCount)} />
                  <Kv k="First seen" v={new Date(node.firstSeen).toLocaleString()} />
                  <Kv k="Last seen" v={new Date(node.lastSeen).toLocaleString()} />
                </Stack>

                {node.nodeType === "product" && (
                  <DataGapNote>
                    A product match is <b>context only</b> — it can never confirm ownership on its
                    own. That rule is what stops an unrelated mention becoming an incident.
                  </DataGapNote>
                )}

                {isFleetScope && node.nodeType === "actor_alias" && (
                  <DataGapNote>
                    This node is scoped to one tenant. Correlating it across tenants needs{" "}
                    <Box component="code" sx={{ fontFamily: fonts.mono }}>
                      GLOBAL_NODE_KEY
                    </Box>
                    .
                  </DataGapNote>
                )}
              </Stack>
            )}
          </Box>
        </Stack>
      </Panel>
    </Stack>
  );
}

function Kv({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <Stack direction="row" gap={1.2} alignItems="baseline">
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 9.5,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: colors.text3,
          width: 96,
          flexShrink: 0,
        }}
      >
        {k}
      </Typography>
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 11.5, color: color ?? colors.text1 }}>
        {v}
      </Typography>
    </Stack>
  );
}

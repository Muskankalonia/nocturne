"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  Box,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { graphForOrg, incidentGraph } from "@/mocks/graph";
import { Panel } from "@/components/ui/Panel";
import { EvidenceQuote } from "@/components/ui/EvidenceQuote";
import { DataGapNote, PageHeader, Tag } from "@/components/ui/Primitives";
import { DiscoveryScrubber } from "@/components/graph/DiscoveryScrubber";
import { CanvasSkeleton } from "@/components/ui/Skeletons";
import type { GraphLayout } from "@/components/graph/KnowledgeGraph";
import {
  revealedEdgeCount,
  timelineStops,
  withDerivedNodeDiscovery,
} from "@/lib/graph-timeline";
import { colors, fonts, layout as layoutTokens, severityColor } from "@/theme/tokens";
import type { GraphEdge, GraphNode } from "@/types";

// G6 reads `window` at module scope, so it cannot be server-rendered.
const KnowledgeGraph = dynamic(() => import("@/components/graph/KnowledgeGraph"), {
  ssr: false,
  // G6 and its layout engine are a large chunk. Hold the canvas's footprint so
  // the panel does not resize when the graph mounts.
  loading: () => <CanvasSkeleton height="100%" />,
});

const typeColor: Record<string, string> = {
  organization: severityColor.critical,
  domain: colors.verified,
  actor_alias: colors.ion,
  marketplace: "#7AA4FF",
  contact_channel: "#7AA4FF",
  data_asset: severityColor.high,
  product: colors.informational,
  location: colors.informational,
};

export default function GraphPage() {
  const { session, isFleetScope } = useAuth();
  const [node, setNode] = useState<GraphNode | null>(null);
  const [edge, setEdge] = useState<GraphEdge | null>(null);

  const [layout, setLayout] = useState<GraphLayout>("spine");
  const [stopIndex, setStopIndex] = useState(0);

  const payload = useMemo(() => {
    const base = !session
      ? incidentGraph
      : (() => {
          const orgId = scopeOrgId(session.scope);
          return orgId ? graphForOrg(orgId) : incidentGraph;
        })();
    return withDerivedNodeDiscovery(base);
  }, [session]);

  const stops = useMemo(() => timelineStops(payload), [payload]);

  // Land on the fully-assembled graph. Switching tenant changes the stop count,
  // so re-pin to the end rather than leaving the handle at a stale index.
  useEffect(() => {
    setStopIndex(Math.max(stops.length - 1, 0));
  }, [stops]);

  const cutoff = stops.length > 1 ? (stops[Math.min(stopIndex, stops.length - 1)] ?? null) : null;
  const revealed = revealedEdgeCount(payload, cutoff);

  const handleNode = useCallback((n: GraphNode | null) => setNode(n), []);
  const handleEdge = useCallback((e: GraphEdge | null) => setEdge(e), []);

  // Clear an inspector selection that the replay has rewound past.
  useEffect(() => {
    if (!cutoff) return;
    if (edge && edge.firstSeen > cutoff) setEdge(null);
    if (node && node.firstSeen > cutoff) setNode(null);
  }, [cutoff, edge, node]);

  const typeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of payload.nodes) map.set(n.nodeType, (map.get(n.nodeType) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [payload]);

  return (
    // The shell contributes a 52px header and 16px of vertical main padding
    // top and bottom. Claim what is left so the panel reaches the fold instead
    // of stopping at a fixed 520px and leaving dead space beneath it.
    <Stack gap={2} sx={{ height: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)` }}>
      <PageHeader
        title="Knowledge Graph"
        subtitle="Actor → claim → organization, ranked left to right. Click any edge to see the sentence that created it, or replay the timeline to watch the incident assemble."
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
          <Stack direction="row" gap={1.5} alignItems="center" sx={{ ml: "auto" }}>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={layout}
              onChange={(_, next: GraphLayout | null) => next && setLayout(next)}
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
              <ToggleButton value="spine">SPINE</ToggleButton>
              <ToggleButton value="force">FORCE</ToggleButton>
            </ToggleButtonGroup>
            <Typography sx={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.text3 }}>
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
                  <Kv k="Sightings" v={String(edge.sightingCount)} />
                  <Kv k="Independent" v={String(edge.docCount)} />
                </Stack>
              </Stack>
            )}

            {node && (
              <Stack gap={1.6}>
                <Typography variant="overline">Selected node</Typography>
                <Box>
                  <Typography sx={{ fontSize: 15, fontWeight: 600 }}>{node.displayName}</Typography>
                  <Stack direction="row" gap={0.6} sx={{ mt: 0.8 }} flexWrap="wrap">
                    <Tag tone={node.isMonitoredOrg ? "critical" : "neutral"}>{node.nodeType}</Tag>
                    {node.isMonitoredOrg && <Tag tone="critical">monitored</Tag>}
                  </Stack>
                </Box>

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
                  <Kv k="Independent" v={String(node.docCount)} />
                  <Kv k="Reposts" v={String(node.mirrorSightingCount)} />
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

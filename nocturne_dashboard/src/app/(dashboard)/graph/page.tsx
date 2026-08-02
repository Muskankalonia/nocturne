"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Box, CircularProgress, Stack, Typography } from "@mui/material";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { graphForOrg, incidentGraph } from "@/mocks/graph";
import { Panel } from "@/components/ui/Panel";
import { EvidenceQuote } from "@/components/ui/EvidenceQuote";
import { DataGapNote, PageHeader, Tag } from "@/components/ui/Primitives";
import { colors, fonts, severityColor } from "@/theme/tokens";
import type { GraphEdge, GraphNode } from "@/types";

// G6 reads `window` at module scope, so it cannot be server-rendered.
const KnowledgeGraph = dynamic(() => import("@/components/graph/KnowledgeGraph"), {
  ssr: false,
  loading: () => (
    <Stack alignItems="center" justifyContent="center" sx={{ height: 520 }}>
      <CircularProgress size={24} sx={{ color: colors.ion }} />
    </Stack>
  ),
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

  const payload = useMemo(() => {
    if (!session) return incidentGraph;
    const orgId = scopeOrgId(session.scope);
    return orgId ? graphForOrg(orgId) : incidentGraph;
  }, [session]);

  const handleNode = useCallback((n: GraphNode | null) => setNode(n), []);
  const handleEdge = useCallback((e: GraphEdge | null) => setEdge(e), []);

  const typeCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of payload.nodes) map.set(n.nodeType, (map.get(n.nodeType) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [payload]);

  return (
    <Stack gap={2}>
      <PageHeader
        title="Knowledge Graph"
        subtitle="Actor → claim → organization. Click any edge to see the sentence that created it."
      />

      <Panel padded={false}>
        <Stack
          direction="row"
          gap={1}
          flexWrap="wrap"
          alignItems="center"
          sx={{ px: 2, py: 1.5, borderBottom: `1px solid ${colors.edge}` }}
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
          <Typography
            sx={{ ml: "auto", fontFamily: fonts.mono, fontSize: 10.5, color: colors.text3 }}
          >
            {payload.nodes.length} NODES · {payload.edges.length} EDGES
          </Typography>
        </Stack>

        <Stack direction={{ xs: "column", lg: "row" }}>
          <Box sx={{ flex: 1, minWidth: 0, borderRight: { lg: `1px solid ${colors.edge}` } }}>
            <KnowledgeGraph
              payload={payload}
              onSelectNode={handleNode}
              onSelectEdge={handleEdge}
            />
          </Box>

          <Box sx={{ width: { xs: "100%", lg: 300 }, flexShrink: 0, p: 2 }}>
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

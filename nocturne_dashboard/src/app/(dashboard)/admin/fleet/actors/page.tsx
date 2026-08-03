"use client";

import { Box, Stack, Typography, alpha } from "@mui/material";
import { crossTenantActors } from "@/mocks/actors";
import { findOrganization } from "@/mocks/organizations";
import { Panel } from "@/components/ui/Panel";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { DataGapNote, PageHeader, StatCard, StatGrid, Tag } from "@/components/ui/Primitives";
import { bandForScore, colors, fonts, severityColor } from "@/theme/tokens";
import { formatDate } from "@/lib/format";
import AdminOnly from "@/components/layout/AdminOnly";

/** Hex node, matching the operations-console language used across the product. */
function Hex({
  x,
  y,
  r,
  fill,
  stroke,
  width = 1.8,
}: {
  x: number;
  y: number;
  r: number;
  fill: string;
  stroke: string;
  width?: number;
}) {
  const pts = [
    [0, -r],
    [r * 0.866, -r / 2],
    [r * 0.866, r / 2],
    [0, r],
    [-r * 0.866, r / 2],
    [-r * 0.866, -r / 2],
  ]
    .map((p) => p.join(","))
    .join(" ");
  return (
    <polygon points={pts} transform={`translate(${x},${y})`} fill={fill} stroke={stroke} strokeWidth={width} />
  );
}

export default function CrossTenantActorsPage() {
  const top = crossTenantActors[0]!;
  const orgPositions = [
    { x: 470, y: 105, color: severityColor.critical },
    { x: 495, y: 245, color: severityColor.critical },
    { x: 470, y: 375, color: severityColor.high },
  ];

  return (
    <AdminOnly>
      <Stack gap={2}>
        <PageHeader
          title="Cross-Tenant Actors"
          subtitle="One actor, several customers — a shape no single-tenant view can produce."
        />

        <DataGapNote>
          <b>This page needs one pipeline change.</b> Every{" "}
          <Box component="code" sx={{ fontFamily: fonts.mono }}>NODE_KEY</Box> currently includes{" "}
          <Box component="code" sx={{ fontFamily: fonts.mono }}>ORG_ID</Box>, so the same actor seen
          for two tenants produces two unjoinable keys. Adding{" "}
          <Box component="code" sx={{ fontFamily: fonts.mono }}>GLOBAL_NODE_KEY</Box> alongside it
          keeps tenant isolation intact and makes the correlation below live. The figures here are
          illustrative until then — see <b>docs/global-node-key.md</b>.
        </DataGapNote>

        <StatGrid columns={3}>
          <StatCard
            label="Actors spanning tenants"
            value={String(crossTenantActors.length)}
            accent={severityColor.critical}
            valueColor={severityColor.critical}
          />
          <StatCard
            label="Most tenants hit by one actor"
            value={String(top.affectedOrgIds.length)}
            sub={top.actorName}
            accent={severityColor.high}
          />
          <StatCard
            label="Confirmed claims by shared actors"
            value={String(crossTenantActors.reduce((s, a) => s + a.corroboratedClaims, 0))}
            accent={colors.verified}
            valueColor={colors.verified}
          />
        </StatGrid>

        <Panel padded={false}>
          <Stack direction={{ xs: "column", lg: "row" }}>
            {/* The diagram is a fixed 640×470 viewBox. Stretching its box to
                fill the row only letterboxed it — the drawing scaled to the
                440px height and sat in the middle of a ~1300px column with dead
                space either side. Cap the column near the diagram's natural
                width and let the actor list take the rest. */}
            <Box
              sx={{
                flex: { lg: "0 1 660px" },
                minWidth: 0,
                borderRight: { lg: `1px solid ${colors.edge}` },
                p: 1,
              }}
            >
              <Box
                component="svg"
                viewBox="0 0 640 470"
                role="img"
                aria-label={`${top.actorName} connected to ${top.affectedOrgIds.length} customer organizations`}
                sx={{
                  width: "100%",
                  maxWidth: 640,
                  aspectRatio: "640 / 470",
                  height: "auto",
                  mx: "auto",
                  display: "block",
                }}
              >
                <g fill="none">
                  {orgPositions.map((p, i) => (
                    <path
                      key={i}
                      d={`M300 235 L${p.x} ${p.y}`}
                      stroke={p.color}
                      strokeWidth={i === 2 ? 1.8 : 2}
                    />
                  ))}
                  <path d="M300 235 L130 130" stroke="rgba(122,164,255,0.4)" strokeWidth={1.2} strokeDasharray="3 4" />
                  <path d="M300 235 L120 320" stroke="rgba(122,164,255,0.4)" strokeWidth={1.2} strokeDasharray="3 4" />
                  <path d="M300 235 L180 410" stroke="rgba(122,164,255,0.4)" strokeWidth={1.2} strokeDasharray="3 4" />
                </g>

                <g fontFamily={fonts.mono} fontSize={8.5}>
                  <text x="352" y="163" fill={severityColor.critical}>AFFECTS · 4 claims</text>
                  <text x="368" y="232" fill={severityColor.critical}>AFFECTS · 6 claims</text>
                  <text x="352" y="322" fill={severityColor.high}>AFFECTS · 2 claims</text>
                  <text x="150" y="180" fill={colors.text3}>LISTED_ON</text>
                  <text x="150" y="290" fill={colors.text3}>LISTED_ON</text>
                  <text x="200" y="345" fill={colors.text3}>CONTACTED_VIA</text>
                </g>

                {/* actor */}
                <Hex x={300} y={235} r={45} fill={alpha(colors.ion, 0.12)} stroke={colors.ion} width={1.6} />
                <Hex x={300} y={235} r={32} fill={alpha(colors.ion, 0.26)} stroke={colors.ion} width={2} />
                <circle cx={300} cy={230} r={5.5} fill="none" stroke="#8FF3FF" strokeWidth={1.8} />
                <path d="M291 246c0-5.5 4-9 9-9s9 3.5 9 9" fill="none" stroke="#8FF3FF" strokeWidth={1.8} />
                <text x={300} y={301} textAnchor="middle" fill={colors.text1} fontFamily={fonts.mono} fontSize={14} fontWeight={600}>
                  {top.actorName}
                </text>
                <text x={300} y={317} textAnchor="middle" fill={severityColor.critical} fontFamily={fonts.mono} fontSize={9}>
                  {top.affectedOrgIds.length} TENANTS · CRED {top.maxCredibility}
                </text>

                {/* organizations */}
                {top.affectedOrgIds.map((orgId, i) => {
                  const pos = orgPositions[i]!;
                  const org = findOrganization(orgId);
                  return (
                    <g key={orgId}>
                      <Hex x={pos.x} y={pos.y} r={26} fill={alpha(pos.color, 0.2)} stroke={pos.color} />
                      <path
                        d={`M${pos.x} ${pos.y - 10} l-8 4.5v6.5c0 4.5 3.5 7.5 8 8.5 4.5-1 8-4 8-8.5v-6.5z`}
                        fill="none"
                        stroke="#FFC2CD"
                        strokeWidth={1.5}
                      />
                      <text
                        x={pos.x}
                        y={pos.y + 46}
                        textAnchor="middle"
                        fill={colors.text1}
                        fontFamily={fonts.mono}
                        fontSize={11}
                        fontWeight={600}
                      >
                        {org?.canonicalName ?? orgId}
                      </text>
                    </g>
                  );
                })}

                {/* venues */}
                {[
                  { x: 130, y: 130, label: "darkbay-market" },
                  { x: 120, y: 320, label: "ghostforum-7x" },
                  { x: 180, y: 410, label: "tox:8f2c…" },
                ].map((v) => (
                  <g key={v.label}>
                    <Hex x={v.x} y={v.y} r={15} fill="rgba(122,164,255,0.10)" stroke="rgba(122,164,255,0.42)" width={1.3} />
                    <text x={v.x} y={v.y + 31} textAnchor="middle" fill={colors.text2} fontFamily={fonts.mono} fontSize={9.5}>
                      {v.label}
                    </text>
                  </g>
                ))}
              </Box>
            </Box>

            <Box sx={{ flex: { lg: "1 1 480px" }, minWidth: 0, width: { xs: "100%", lg: "auto" }, p: 2 }}>
              <Typography variant="overline" sx={{ display: "block", mb: 1.4 }}>
                Actors spanning tenants
              </Typography>
              {/* On a wide fleet console the list gets a lot of room, so let the
                  cards flow into columns rather than stretching one card to a
                  line length nobody can scan. */}
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(272px, 1fr))",
                  gap: 1,
                  alignItems: "start",
                }}
              >
                {crossTenantActors.map((a, i) => {
                  const band = bandForScore(a.maxCredibility);
                  return (
                    <Box
                      key={a.actorName}
                      sx={{
                        p: 1.4,
                        borderRadius: "8px",
                        border: `1px solid ${i === 0 ? alpha(severityColor.critical, 0.28) : colors.edge}`,
                        backgroundColor: i === 0 ? alpha(severityColor.critical, 0.09) : "transparent",
                      }}
                    >
                      <Stack direction="row" alignItems="center" gap={1}>
                        <Typography sx={{ fontFamily: fonts.mono, fontSize: 12.5, color: colors.ion }}>
                          {a.actorName}
                        </Typography>
                        <Box sx={{ ml: "auto" }}>
                          <SeverityChip band={band} score={a.affectedOrgIds.length} />
                        </Box>
                      </Stack>
                      <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 1 }}>
                        {a.affectedOrgIds.map((id) => (
                          <Tag key={id} tone="critical">
                            {findOrganization(id)?.canonicalName ?? id}
                          </Tag>
                        ))}
                      </Stack>
                      <Typography sx={{ mt: 1, fontSize: 10.5, color: colors.text2 }}>
                        {a.totalClaims} claims · {a.corroboratedClaims} confirmed ·{" "}
                        {a.marketplaceCount} markets
                      </Typography>
                      <Typography sx={{ fontSize: 10, color: colors.text3, fontFamily: fonts.mono }}>
                        {formatDate(a.firstSeen)} → {formatDate(a.lastSeen)}
                      </Typography>
                    </Box>
                  );
                })}
              </Box>

              <Box sx={{ mt: 2 }}>
                <Box
                  sx={{
                    px: 1.5,
                    py: 1.2,
                    border: `1px dashed ${alpha(severityColor.critical, 0.32)}`,
                    borderRadius: "8px",
                    backgroundColor: alpha(severityColor.critical, 0.05),
                    fontSize: 11.5,
                    color: colors.text2,
                    lineHeight: 1.65,
                  }}
                >
                  <b style={{ color: severityColor.critical }}>{top.actorName}</b> has confirmed
                  claims against {top.affectedOrgIds.length} tenants within 30 days. Escalation
                  candidate — notify all affected customers of a shared adversary.
                </Box>
              </Box>
            </Box>
          </Stack>
        </Panel>
      </Stack>
    </AdminOnly>
  );
}

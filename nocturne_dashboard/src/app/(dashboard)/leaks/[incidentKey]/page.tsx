"use client";

import { use } from "react";
import { useRouter } from "next/navigation";
import { Box, Button, Divider, Stack, Typography, alpha } from "@mui/material";
import { ArrowLeft } from "lucide-react";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { groundedClaims, incidents, indicatorSummaries, insights } from "@/mocks/incidents";
import { Panel } from "@/components/ui/Panel";
import { SeverityChip } from "@/components/ui/SeverityChip";
import { ScoreRadar } from "@/components/ui/ScoreRadar";
import { EvidenceQuote } from "@/components/ui/EvidenceQuote";
import { PageHeader, Tag } from "@/components/ui/Primitives";
import { colors, fonts, severityColor } from "@/theme/tokens";
import {
  formatCount,
  formatDateTime,
  hostOf,
  leakTypeLabel,
  routeLabel,
  scoreReasonLabel,
  shortHash,
} from "@/lib/format";
import type { BreachRecord } from "@/types";

export default function IncidentDetailPage({
  params,
}: {
  params: Promise<{ incidentKey: string }>;
}) {
  const { incidentKey } = use(params);
  const router = useRouter();
  const { session } = useAuth();

  const incident = incidents.find((i) => i.incidentKey === incidentKey);

  // Tenant isolation, enforced again at render. In the live build the API
  // returns 403 for this case; the UI must not depend on that being the only check.
  const allowedOrg = session ? scopeOrgId(session.scope) : null;
  const permitted = incident && (allowedOrg === null || incident.orgId === allowedOrg);

  if (!incident || !permitted) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Incident not available"
          subtitle="It may have been removed, or it belongs to another organization."
        />
        <Button
          variant="outlined"
          startIcon={<ArrowLeft size={14} />}
          onClick={() => router.push("/leaks")}
          sx={{ alignSelf: "flex-start", borderColor: colors.edgeHi, color: colors.ion }}
        >
          Back to Breach Monitor
        </Button>
      </Stack>
    );
  }

  const insight = insights.find((i) => i.incidentKey === incidentKey);
  const claims = groundedClaims.filter((c) => c.incidentKey === incidentKey);
  const indicators = indicatorSummaries[incidentKey] ?? [];

  // A page the pipeline declined to confirm. This is the most instructive view
  // in the product — it shows the gate working, so it gets a real explanation
  // rather than a detail page full of dashes.
  if (incident.route !== "target_confirmed") {
    return (
      <UnconfirmedIncident incident={incident} onBack={() => router.push("/leaks")} />
    );
  }

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap">
        <Button
          size="small"
          startIcon={<ArrowLeft size={14} />}
          onClick={() => router.push("/leaks")}
          sx={{ color: colors.text2 }}
        >
          Breach Monitor
        </Button>
        <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text3 }}>
          {shortHash(incident.incidentKey, 10, 8)}
        </Typography>
        <Box sx={{ ml: "auto" }}>
          <SeverityChip band={incident.triagePriorityBand} score={incident.triagePriorityScore} />
        </Box>
      </Stack>

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" } }}>
        {/* narrative */}
        <Panel title="AI incident narrative" meta={`CACHED · ${insight?.modelName ?? "—"}`}>
          <Typography sx={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.35, mb: 1.2 }}>
            {insight?.headline ?? incident.topTitle}
          </Typography>
          <Typography sx={{ fontSize: 12.5, lineHeight: 1.75, color: colors.text2 }}>
            {insight?.whatHappened ?? insight?.executiveSummary ?? "No narrative generated yet."}
          </Typography>

          {insight?.businessImpact && (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 2.2, mb: 0.8 }}>
                Business impact
              </Typography>
              <Typography sx={{ fontSize: 12.5, lineHeight: 1.75, color: colors.text2 }}>
                {insight.businessImpact}
              </Typography>
            </>
          )}

          {insight?.recommendedActions?.length ? (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 2.2, mb: 0.8 }}>
                Recommended actions
              </Typography>
              <Stack component="ol" gap={0.9} sx={{ m: 0, pl: 2.4 }}>
                {insight.recommendedActions.map((a) => (
                  <Typography
                    component="li"
                    key={a}
                    sx={{ fontSize: 12.5, color: colors.text2, lineHeight: 1.6 }}
                  >
                    {a}
                  </Typography>
                ))}
              </Stack>
            </>
          ) : null}

          <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 2.2 }}>
            {incident.scoreReasons.map((r) => (
              <Tag
                key={r}
                tone={
                  r === "grounded_target_ownership_confirmed"
                    ? "ok"
                    : r === "strong_exposed_material_present"
                      ? "high"
                      : r === "claim_disputed"
                        ? "critical"
                        : "medium"
                }
              >
                {scoreReasonLabel[r] ?? r}
              </Tag>
            ))}
          </Stack>
        </Panel>

        {/* score decomposition */}
        <Panel title="Score decomposition" meta="8 COMPONENTS">
          <ScoreRadar vector={incident.scoreVector} />
          <Divider sx={{ my: 1.5, borderColor: colors.edge }} />
          <Stack direction="row" justifyContent="space-around">
            <ScoreStat label="Impact" value={incident.impactSeverityScore} color={severityColor.critical} />
            <ScoreStat label="Confidence" value={incident.evidenceConfidenceScore} color={colors.verified} />
            <ScoreStat label="Triage" value={incident.triagePriorityScore} color={severityColor.critical} />
          </Stack>
          <Typography sx={{ mt: 1.5, fontSize: 10.5, color: colors.text3, lineHeight: 1.55 }}>
            Impact and confidence are never multiplied — they answer different questions. Neither is
            a probability.
          </Typography>
        </Panel>
      </Box>

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" } }}>
        {/* evidence */}
        <Panel title="Grounded claim · verbatim evidence" meta={claims.length ? "VERIFIED" : "—"}>
          {claims.length === 0 && (
            <Typography sx={{ fontSize: 12, color: colors.text3 }}>
              No grounded claim was promoted for this incident.
            </Typography>
          )}
          {claims.map((claim) => (
            <Box key={claim.claimKey} sx={{ mb: 2 }}>
              <Typography sx={{ fontSize: 12.5, color: colors.text2, mb: 1.4, lineHeight: 1.7 }}>
                {claim.statement}
              </Typography>
              <EvidenceQuote
                before="…archive index continues. "
                highlight={claim.evidenceText}
                after=". Contact via the channel below for escrow…"
                start={claim.evidenceStart}
                end={claim.evidenceEnd}
                windowId={claim.selectedWindowId}
                level={claim.groundingLevel}
              />
              <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1.5 }}>
                <Tag tone="ok">
                  {claim.claimStatusExtracted === "self_evidenced"
                    ? "Sample attached"
                    : claim.claimStatusExtracted}
                </Tag>
                <Tag>records claimed {formatCount(claim.quantityClaimed)}</Tag>
                <Tag tone="ok">ownership → exact domain match</Tag>
              </Stack>
            </Box>
          ))}
        </Panel>

        {/* provenance */}
        <Panel title="Provenance">
          <Stack gap={1}>
            <Kv k="Organization" v={incident.organizationName} />
            <Kv k="Status" v={routeLabel[incident.route]} color={colors.verified} />
            <Kv k="Incident key" v={shortHash(incident.incidentKey)} />
            <Kv k="Content hash" v={shortHash(incident.contentSha256)} />
            <Kv k="Source" v={incident.source} color={colors.ion} />
            <Kv k="Host" v={hostOf(incident.topUrl)} />
            <Kv k="First seen" v={formatDateTime(incident.firstSeen)} />
            <Kv k="Sightings" v={`${incident.sightingCount} (${incident.mirrorSightingCount} reposts)`} />
            <Kv k="Independent sources" v={String(incident.corroborationCount)} />
            <Kv k="Actor" v={incident.actorName ?? "unattributed"} color={incident.actorName ? colors.ion : undefined} />
          </Stack>

          <Typography variant="overline" sx={{ display: "block", mt: 2.4, mb: 1 }}>
            Sensitive signals found on page
          </Typography>
          <Stack direction="row" gap={0.6} flexWrap="wrap">
            {indicators.length === 0 && (
              <Typography sx={{ fontSize: 11, color: colors.text3 }}>none detected</Typography>
            )}
            {indicators.map((ind) => (
              <Tag
                key={ind.type}
                tone={ind.strength === "strong" ? "critical" : ind.strength === "medium" ? "medium" : "neutral"}
              >
                {ind.type} {ind.count}
              </Tag>
            ))}
          </Stack>
          <Typography sx={{ mt: 1.2, fontSize: 10.5, color: colors.text3, lineHeight: 1.55 }}>
            Counts only. Exact matched values are never sent to the browser or written to logs.
          </Typography>

          {insight?.caveats?.length ? (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 2.4, mb: 1 }}>
                Caveats
              </Typography>
              <Stack component="ul" gap={0.7} sx={{ m: 0, pl: 2.2 }}>
                {insight.caveats.map((c) => (
                  <Typography
                    component="li"
                    key={c}
                    sx={{ fontSize: 11.5, color: colors.text3, lineHeight: 1.55 }}
                  >
                    {c}
                  </Typography>
                ))}
              </Stack>
            </>
          ) : null}
        </Panel>
      </Box>

      <Panel title="Exposed data classes">
        <Stack direction="row" gap={1} flexWrap="wrap">
          {incident.leakTypes.map((t) => (
            <Box
              key={t}
              sx={{
                px: 1.6,
                py: 1.1,
                borderRadius: "8px",
                border: `1px solid ${alpha(
                  t === "credential" || t === "financial" ? severityColor.critical : colors.edgeHi,
                  0.4,
                )}`,
                backgroundColor: alpha(
                  t === "credential" || t === "financial" ? severityColor.critical : colors.ion,
                  0.06,
                ),
                fontSize: 12.5,
              }}
            >
              {leakTypeLabel[t]}
            </Box>
          ))}
        </Stack>
      </Panel>
    </Stack>
  );
}

/** Explains, in plain language, why a page never became a confirmed incident. */
function UnconfirmedIncident({
  incident,
  onBack,
}: {
  incident: BreachRecord;
  onBack: () => void;
}) {
  const explanation: Record<string, { title: string; body: string; next: string }> = {
    ambiguous: {
      title: "Your organization was named, but ownership was never proven",
      body:
        "The page mentions your organization or a product, and the model extracted claims from it — but no grounded claim connected to your organization by an accepted ownership relationship. A name appearing on a page is not evidence that the leaked data is yours.",
      next: "Add a missing domain or alias in Monitored Assets if this really is you, then the page is re-matched for free.",
    },
    other_organization_confirmed: {
      title: "This leak belongs to a different organization",
      body:
        "A grounded ownership relationship was accepted, but it points at a different company. The page is kept because it is useful context — the same actor leaking someone else's data is how you see them before they reach you.",
      next: "No action needed. It is excluded from your severity scores and alerts.",
    },
    not_relevant: {
      title: "No connection to your organization was found",
      body: "Neither a deterministic anchor nor a grounded entity tied this page to you.",
      next: "No action needed.",
    },
    extraction_error: {
      title: "Evidence extraction failed for this page",
      body:
        "The extraction step returned an error or an unusable response, so no claims could be verified. Errors are stored rather than retried automatically, so nothing is silently reprocessed.",
      next: "Re-run extraction for this page from the pipeline tools if it looks important.",
    },
  };

  const info = explanation[incident.route] ?? explanation.ambiguous!;

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap">
        <Button size="small" startIcon={<ArrowLeft size={14} />} onClick={onBack} sx={{ color: colors.text2 }}>
          Breach Monitor
        </Button>
        <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text3 }}>
          {shortHash(incident.incidentKey, 10, 8)}
        </Typography>
        <Box sx={{ ml: "auto" }}>
          <Tag tone={incident.route === "other_organization_confirmed" ? "neutral" : "medium"}>
            {routeLabel[incident.route]}
          </Tag>
        </Box>
      </Stack>

      <Panel title="Why this is not a confirmed incident" meta={incident.route}>
        <Typography sx={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.35, mb: 1.2 }}>
          {info.title}
        </Typography>
        <Typography sx={{ fontSize: 12.5, lineHeight: 1.75, color: colors.text2 }}>
          {info.body}
        </Typography>
        <Box
          sx={{
            mt: 2,
            px: 1.6,
            py: 1.2,
            borderRadius: "8px",
            border: `1px dashed ${alpha(colors.ion, 0.35)}`,
            backgroundColor: alpha(colors.ion, 0.05),
            fontSize: 12,
            color: colors.text2,
            lineHeight: 1.65,
          }}
        >
          <b style={{ color: colors.text1 }}>What to do:</b> {info.next}
        </Box>
      </Panel>

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" } }}>
        <Panel title="Routing decision">
          <Stack gap={1}>
            <Kv k="Page title" v={incident.topTitle} />
            <Kv k="Host" v={hostOf(incident.topUrl)} />
            <Kv k="Relevance verdict" v={incident.relationshipLabel} />
            <Kv k="Routing outcome" v={incident.route} color={colors.medium} />
            <Kv k="Reason code" v={incident.routingReason} />
            <Kv k="First seen" v={formatDateTime(incident.firstSeen)} />
          </Stack>
        </Panel>

        <Panel title="What is deliberately absent">
          <Stack gap={1.2}>
            {[
              ["Severity scores", "Only a confirmed target incident is scored."],
              ["Leak types", "Data classification runs after ownership is proven."],
              ["Graph promotion", "Nothing from this page enters the knowledge graph."],
              ["Alerts", "This page can never raise a target alert."],
            ].map(([k, v]) => (
              <Stack key={k} direction="row" gap={1.2} alignItems="flex-start">
                <Box sx={{ color: colors.text3, fontFamily: fonts.mono, fontSize: 12, mt: 0.1 }}>—</Box>
                <Box>
                  <Typography sx={{ fontSize: 12.5, color: colors.text1 }}>{k}</Typography>
                  <Typography sx={{ fontSize: 11.5, color: colors.text3, lineHeight: 1.55 }}>{v}</Typography>
                </Box>
              </Stack>
            ))}
          </Stack>
        </Panel>
      </Box>
    </Stack>
  );
}

function ScoreStat({ label, value, color }: { label: string; value: number | null; color: string }) {
  return (
    <Box sx={{ textAlign: "center" }}>
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 10,
          letterSpacing: "0.13em",
          textTransform: "uppercase",
          color: colors.text3,
        }}
      >
        {label}
      </Typography>
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 21, fontWeight: 600, color }}>
        {value ?? "—"}
      </Typography>
    </Box>
  );
}

function Kv({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <Stack direction="row" gap={1.4} alignItems="baseline">
      <Typography
        sx={{
          fontFamily: fonts.mono,
          fontSize: 10,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: colors.text3,
          width: 132,
          flexShrink: 0,
        }}
      >
        {k}
      </Typography>
      <Typography
        sx={{ fontFamily: fonts.mono, fontSize: 11.5, color: color ?? colors.text1, wordBreak: "break-all" }}
      >
        {v}
      </Typography>
    </Stack>
  );
}

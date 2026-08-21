"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Box, Button, Divider, Stack, Typography, alpha } from "@mui/material";
import { ArrowLeft, Network } from "lucide-react";
import { scopeOrgId, useAuth } from "@/contexts/AuthContext";
import { IncidentActionBar } from "@/components/triage/IncidentActionBar";
import { ReviewCapturePanel } from "@/components/triage/ReviewCapturePanel";
import { Panel } from "@/components/ui/Panel";
import {
  CanvasSkeleton,
  TableSkeleton,
  TextBlockSkeleton,
} from "@/components/ui/Skeletons";
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
import type { IncidentDetailResponse } from "@/types/dashboard";

export default function IncidentDetailPage({
  params,
}: {
  params: Promise<{ incidentKey: string }>;
}) {
  const { incidentKey } = use(params);
  const router = useRouter();
  const { session } = useAuth();
  const [detail, setDetail] = useState<IncidentDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) {
      setDetail(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setDetail(null);
    setError(null);
    setIsLoading(true);

    void fetch(`/api/incidents/${encodeURIComponent(incidentKey)}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as
          | IncidentDetailResponse
          | { error?: string };
        if (!response.ok || !("incident" in body)) {
          throw new Error(
            "error" in body && body.error
              ? body.error
              : "Unable to load live incident data.",
          );
        }
        setDetail(body);
      })
      .catch((loadError: unknown) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load live incident data.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [incidentKey, session]);

  // The API enforces tenancy. Retain a render-time check so a stale response is
  // never shown while the user switches organization scope in the dashboard.
  const allowedOrg = session ? scopeOrgId(session.scope) : null;
  const permittedDetail = detail && (
    allowedOrg === null || detail.incident.orgId === allowedOrg
  ) ? detail : null;

  if (isLoading) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Loading incident"
          subtitle="Retrieving cached insight and grounded evidence from Snowflake."
        />
        <Panel title="AI incident narrative">
          <TextBlockSkeleton lines={5} />
        </Panel>
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" } }}>
          <Panel title="Score decomposition" meta="8 COMPONENTS">
            <CanvasSkeleton height={230} />
          </Panel>
          <Panel title="Grounded claim · verbatim evidence">
            <TextBlockSkeleton lines={4} />
          </Panel>
        </Box>
        <Panel title="Provenance">
          <TableSkeleton rows={4} columns={4} />
        </Panel>
      </Stack>
    );
  }

  if (!permittedDetail) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Incident not available"
          subtitle={error ?? "It may have been removed, or it belongs to another organization."}
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

  const { incident, claims, indicatorCounts: indicators } = permittedDetail;
  const insight = incident.insight;

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
        <Button
          size="small"
          variant="outlined"
          startIcon={<Network size={14} />}
          onClick={() => router.push(`/graph?incidentKey=${encodeURIComponent(incident.incidentKey)}`)}
          sx={{ borderColor: colors.edgeHi, color: colors.ion }}
        >
          Open graph
        </Button>
        <Box sx={{ ml: "auto" }}>
          <SeverityChip band={incident.triagePriorityBand} score={incident.triagePriorityScore} />
        </Box>
      </Stack>

      {/* The response surface. Placed above the evidence rather than below it:
          an analyst arriving from an alert has already decided to act, and
          making them scroll past the whole dossier to find the button is how a
          "read-only list" stays read-only in practice. */}
      <Panel title="Triage & response">
        <IncidentActionBar
          incidentKey={incident.incidentKey}
          orgId={incident.orgId}
        />
      </Panel>

      {/* Evidence capture for *any* incident, not only the ones the cascade
          could not decide.
          
          A confirmed incident is the case where seeing the page matters most:
          it is what an analyst attaches to a regulator notification or a Jira
          ticket, and a listing can be pulled hours after the alert fires. The
          capture is keyed by incident key, which VW_BREACH_MONITOR and
          VW_INCIDENTS agree on, so the same worker and the same storage serve
          both surfaces. */}
      {isCapturable(incident.topUrl) ? (
        <Panel title="Source page capture">
          <ReviewCapturePanel
            orgId={incident.orgId}
            monitorKey={incident.incidentKey}
            url={incident.topUrl}
            decision={null}
            canDecide={false}
            showVerdictControls={false}
          />
        </Panel>
      ) : (
        <Panel title="Source page capture">
          <Typography sx={{ fontSize: 12, color: colors.text3, lineHeight: 1.7 }}>
            This incident came from a manual paste-dump upload, so there is no
            live page to capture. The uploaded file is the evidence.
          </Typography>
        </Panel>
      )}

      <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", lg: "1.55fr 1fr" } }}>
        {/* narrative */}
        <Panel
          title="AI incident narrative"
          meta={`${insight.status.toUpperCase()} · ${insight.modelName ?? "—"}`}
        >
          <Typography sx={{ fontSize: 15.5, fontWeight: 600, lineHeight: 1.35, mb: 1.2 }}>
            {insight.headline ?? incident.topTitle}
          </Typography>
          <Typography sx={{ fontSize: 12.5, lineHeight: 1.75, color: colors.text2 }}>
            {insight.executiveSummary ?? "No narrative generated yet."}
          </Typography>

          {insight.whatHappened && (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 2.2, mb: 0.8 }}>
                What happened
              </Typography>
              <Typography sx={{ fontSize: 12.5, lineHeight: 1.75, color: colors.text2 }}>
                {insight.whatHappened}
              </Typography>
            </>
          )}

          {insight.businessImpact && (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 2.2, mb: 0.8 }}>
                Business impact
              </Typography>
              <Typography sx={{ fontSize: 12.5, lineHeight: 1.75, color: colors.text2 }}>
                {insight.businessImpact}
              </Typography>
            </>
          )}

          {insight.recommendedActions.length ? (
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

          {insight.confidenceAssessment && (
            <>
              <Typography variant="overline" sx={{ display: "block", mt: 2.2, mb: 0.8 }}>
                Confidence assessment
              </Typography>
              <Typography sx={{ fontSize: 12.5, lineHeight: 1.75, color: colors.text2 }}>
                {insight.confidenceAssessment}
              </Typography>
            </>
          )}

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

        {/* score decomposition
          *
          * The radar now scales with the column instead of sitting at a fixed
          * 210px, which roughly doubles it. It is not stretched to match the AI
          * insight panel beside it: a radar is square, so filling a tall narrow
          * column would either distort the plot or letterbox it behind ~290px
          * of dead space. `alignSelf: start` ends the panel under its own
          * content, which puts the slack in the grid where it reads as layout
          * rather than inside a half-empty box. */}
        {/* Right column: the radar plus the leak classes. The narrative beside
          * it runs much taller, and a lone square radar left most of this
          * column blank — stacking the two panels here fills it with something
          * an analyst actually reads next, instead of stretching one panel. */}
        <Stack gap={2} sx={{ alignSelf: "start" }}>
        <Panel title="Score decomposition" meta="8 COMPONENTS">
          <ScoreRadar vector={incident.scoreVector} height="auto" />
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

        <Panel title="Exposed data classes">
          <Stack direction="row" gap={1} flexWrap="wrap">
            {incident.leakTypes.map((t) => {
              const critical = isDirectlyAbusable(t);
              return (
                <Box
                  key={t}
                  sx={{
                    px: 1.6,
                    py: 1.1,
                    borderRadius: "8px",
                    border: `1px solid ${alpha(
                      critical ? severityColor.critical : colors.edgeHi,
                      0.4,
                    )}`,
                    backgroundColor: alpha(
                      critical ? severityColor.critical : colors.ion,
                      0.06,
                    ),
                    fontSize: 12.5,
                  }}
                >
                  {leakTypeLabel[t]}
                </Box>
              );
            })}
          </Stack>

          {/* The red outline was carrying meaning with nothing to decode it.
            * Colour alone never states a fact in this console — it is always
            * paired with a label, so the key says what the ring means and is
            * driven by the same predicate as the chips above. */}
          <Stack
            direction="row"
            gap={2}
            flexWrap="wrap"
            alignItems="center"
            sx={{ mt: 1.8, pt: 1.4, borderTop: `1px solid ${colors.edge}` }}
          >
            <LegendKey
              color={severityColor.critical}
              label="Critical — directly abusable"
              detail="credentials, financial data"
            />
            <LegendKey
              color={colors.ion}
              label="Sensitive — not directly abusable"
              detail="everything else"
            />
          </Stack>
        </Panel>
        </Stack>
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
                highlight={claim.maskedEvidenceText}
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
                <Tag tone="ok">grounding → {claim.groundingLevel}</Tag>
                <Tag>corroboration {claim.corroborationCount}</Tag>
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
            <Kv k="Last seen" v={formatDateTime(incident.lastSeen)} />
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
                key={ind.indicatorType}
                tone={indicatorTone(ind.indicatorType)}
              >
                {humanize(ind.indicatorType)} {ind.indicatorCount}
              </Tag>
            ))}
          </Stack>
          <Typography sx={{ mt: 1.2, fontSize: 10.5, color: colors.text3, lineHeight: 1.55 }}>
            Counts only. Exact matched values are never sent to the browser or written to logs.
          </Typography>

          {insight.caveats.length ? (
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
    </Stack>
  );
}

/**
 * Leak classes an attacker can act on without any further work — the ones that
 * turn a disclosure into an intrusion. Everything else is sensitive but needs a
 * second step. Single source for both the chip styling and its legend.
 */
const DIRECTLY_ABUSABLE: ReadonlySet<string> = new Set(["credential", "financial"]);

/**
 * Whether a headless browser could open this incident's source.
 *
 * Mirrors the server's rule in triage-actions.ts. Duplicated deliberately: the
 * server's copy is the one that holds, and this one exists only so the console
 * explains the absence instead of rendering a button that always fails.
 */
function isCapturable(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isDirectlyAbusable(leakType: string): boolean {
  return DIRECTLY_ABUSABLE.has(leakType);
}

function LegendKey({
  color,
  label,
  detail,
}: {
  color: string;
  label: string;
  detail: string;
}) {
  return (
    <Stack direction="row" alignItems="center" gap={0.8}>
      <Box
        sx={{
          width: 20,
          height: 12,
          borderRadius: "4px",
          flexShrink: 0,
          border: `1px solid ${alpha(color, 0.4)}`,
          backgroundColor: alpha(color, 0.06),
        }}
      />
      <Typography sx={{ fontSize: 11, color: colors.text2 }}>
        {label}
        <Box component="span" sx={{ color: colors.text3 }}> · {detail}</Box>
      </Typography>
    </Stack>
  );
}

const strongIndicatorTypes = new Set([
  "validated_credit_card",
  "private_key_marker",
  "github_token",
  "aws_secret_access_key",
  "password_assignment",
]);

const mediumIndicatorTypes = new Set([
  "ssn",
  "bitcoin_wallet",
  "ethereum_wallet",
  "monero_wallet",
  "cve",
  "md5_hash",
  "sha1_hash",
  "sha256_hash",
  "jwt",
  "aws_access_key_id",
  "token_assignment",
]);

function indicatorTone(type: string): "critical" | "medium" | "neutral" {
  if (strongIndicatorTypes.has(type)) return "critical";
  if (mediumIndicatorTypes.has(type)) return "medium";
  return "neutral";
}

function humanize(value: string): string {
  return value.replaceAll("_", " ");
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

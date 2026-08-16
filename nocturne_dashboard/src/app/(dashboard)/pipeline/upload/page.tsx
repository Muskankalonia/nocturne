"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Stack,
  TextField,
  Typography,
  alpha,
} from "@mui/material";
import {
  CheckCircle2,
  Circle,
  FileText,
  Loader2,
  Network,
  RefreshCw,
  UploadCloud,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Panel } from "@/components/ui/Panel";
import {
  PageHeader,
  StatCard,
  StatGrid,
  Tag,
} from "@/components/ui/Primitives";
import { SeverityChip } from "@/components/ui/SeverityChip";
import {
  formatCount,
  hostOf,
  leakTypeLabel,
  relativeTime,
  routeLabel,
  routeTone,
} from "@/lib/format";
import { colors, fonts, layout as layoutTokens, severityColor } from "@/theme/tokens";
import type {
  ManualUploadCreateResponse,
  ManualUploadPipelineStage,
  ManualUploadStatus,
  ManualUploadStatusResponse,
} from "@/types/dashboard";

const FAST_POLL_MS = 2500;
const RAW_INGEST_POLL_MS = 5000;

type UploadLogLine = {
  tone: "ok" | "ion" | "medium" | "critical" | "neutral";
  message: string;
};

function stageTone(stage: ManualUploadPipelineStage): "ok" | "ion" | "medium" | "critical" | "neutral" {
  if (stage.state === "complete") return "ok";
  if (stage.state === "running") return "ion";
  if (stage.state === "stopped") return "medium";
  if (stage.state === "error") return "critical";
  return "neutral";
}

function isTerminal(status: ManualUploadStatusResponse | null): boolean {
  if (!status) return false;
  const current = status.status;
  if (!current) return false;
  if (current.detailAvailable) return true;
  if (current.incidentKey && current.insightAiStatus !== "success") return false;
  if (current.l4Complete) return true;
  if (current.relationshipAiStatus === "error") return true;
  if (current.pipelineState.startsWith("stopped_after_")) return true;
  if (current.l2Route && current.l2Route !== "target_confirmed") return true;
  return false;
}

function isStoppedBeforeIncident(upload: ManualUploadStatus): boolean {
  return upload.pipelineState.startsWith("stopped_after_")
    || Boolean(upload.l2Route && upload.l2Route !== "target_confirmed");
}

function uploadRowTone(upload: ManualUploadStatus): "ok" | "ion" | "medium" | "critical" | "neutral" {
  if (upload.detailAvailable || upload.incidentKey) return "ok";
  if (upload.relationshipAiStatus === "error" || upload.l2ExtractionStatus === "error") return "critical";
  if (isStoppedBeforeIncident(upload)) return "medium";
  if (upload.rawLoaded || upload.l0Complete || upload.l1Complete) return "ion";
  return "neutral";
}

function buildStageLogs(
  selected: ManualUploadStatusResponse | null,
  error: string | null,
  isUploading: boolean,
  stage: ManualUploadPipelineStage | null,
): UploadLogLine[] {
  const lines: UploadLogLine[] = [];

  if (error) lines.push({ tone: "critical", message: error });

  if (!stage) {
    lines.push({
      tone: "neutral",
      message: "No pipeline stage selected yet.",
    });
    return lines;
  }

  if (!selected) {
    lines.push({
      tone: "neutral",
      message: "No upload selected yet. Choose a text file and start a one-shot leak scan.",
    });
    return lines;
  }

  const status = selected.status;

  switch (stage.id) {
    case "upload":
      lines.push({
        tone: isUploading ? "ion" : "ok",
        message: isUploading
          ? "Uploading the paste dump to GCS and preparing the schema-v2 JSONL.gz page."
          : `Upload accepted. Tracking upload_id=${selected.uploadId}.`,
      });
      lines.push({
        tone: "neutral",
        message: "This is an isolated manual_upload run for the selected organization only.",
      });
      break;
    case "raw_ingest":
      if (!status) {
        lines.push({
          tone: "ion",
          message:
            "Waiting for raw ingest. The GCS object exists, but this upload has not appeared in Snowflake CRAWL_PAGES yet.",
        });
        lines.push({
          tone: "medium",
          message:
            "If this stays here, check CRAWL_INGEST_TASK/COPY history and the GCS path. Downstream AI triggers matter only after raw ingest completes.",
        });
      } else {
        lines.push({
          tone: "ok",
          message: `Raw page loaded for ${status.orgId}; schema_version=2 manual upload record is visible in Snowflake.`,
        });
        if (status.sourceFile) {
          lines.push({ tone: "neutral", message: `Loaded from ${status.sourceFile}.` });
        }
      }
      break;
    case "l0_signals":
      if (status?.l0Complete) {
        lines.push({
          tone: "ok",
          message: `Regex scan complete: evidence_score=${status.evidenceScore}, strong=${status.strongIndicatorCount}, medium=${status.mediumIndicatorCount}, weak=${status.weakIndicatorCount}.`,
        });
        if (status.indicatorSummary) lines.push({ tone: "neutral", message: status.indicatorSummary });
      } else {
        lines.push({
          tone: status?.rawLoaded ? "ion" : "neutral",
          message: status?.rawLoaded
            ? "Waiting for L0 dynamic table refresh to detect regex indicators."
            : "Waiting for raw ingest before L0 can run.",
        });
      }
      break;
    case "l1_relevance":
      if (status?.relationshipAiStatus) {
        lines.push({
          tone: status.relationshipAiStatus === "error" ? "critical" : "ok",
          message: `Relationship classifier finished: status=${status.relationshipAiStatus}${
            status.relationshipLabel ? `, label=${status.relationshipLabel}` : ""
          }.`,
        });
        lines.push({
          tone: "neutral",
          message: `target_match_score=${status.targetMatchScore ?? "—"}, anchor=${
            status.targetAnchorType ?? "none"
          }.`,
        });
      } else {
        lines.push({
          tone: status?.l0Complete ? "ion" : "neutral",
          message: status?.l0Complete
            ? "Waiting for stream-triggered relationship AI task."
            : "Waiting for L0 signals before L1 can classify relevance.",
        });
      }
      break;
    case "l2_evidence":
      if (status?.l2ExtractionStatus) {
        lines.push({
          tone: status.l2ExtractionStatus === "error" ? "critical" : "ok",
          message: `Extraction finished: status=${status.l2ExtractionStatus}, route=${
            status.l2Route ?? "pending"
          }.`,
        });
        lines.push({
          tone: status.l2Route === "target_confirmed" ? "ok" : "medium",
          message: `accepted_claims=${status.acceptedClaimCount}/${status.claimCount}, accepted_entities=${status.acceptedEntityCount}/${status.entityCount}, accepted_edges=${status.acceptedRelationshipCount}/${status.relationshipCount}.`,
        });
        if (status.routingReason) lines.push({ tone: "neutral", message: status.routingReason });
      } else {
        lines.push({
          tone: status?.l2Eligible ? "ion" : status?.relationshipLabel ? "medium" : "neutral",
          message: status?.l2Eligible
            ? "L1 passed the L2 gate; waiting for evidence extraction to start."
            : status?.relationshipLabel
              ? `Skipped because L1 label=${status.relationshipLabel} is not eligible for L2 evidence extraction.`
              : "Waiting for L1 classification before L2 can run.",
        });
      }
      break;
    case "l3_graph":
      if (status?.l2Route === "target_confirmed") {
        lines.push({
          tone: "ok",
          message: `Graph promotion ready: target ownership grounded=${status.targetLeakRelationGrounded ? "true" : "false"}.`,
        });
        lines.push({
          tone: "neutral",
          message: `Accepted graph material: ${status.acceptedClaimCount} claims, ${status.acceptedEntityCount} entities, ${status.acceptedRelationshipCount} relationships.`,
        });
      } else {
        lines.push({
          tone: status?.l2Route ? "medium" : "neutral",
          message: status?.l2Route
            ? `Not promoted to target graph because route=${status.l2Route}.`
            : "Waiting for L2 target ownership confirmation before graph promotion.",
        });
      }
      break;
    case "l4_insight":
      if (status?.detailAvailable || status?.incidentKey) {
        lines.push({
          tone: "ok",
          message: `Incident ready: ${status.incidentKey}. AI summary and graph can be opened from this page.`,
        });
        lines.push({
          tone: "neutral",
          message: `impact=${status.impactSeverityScore ?? "—"}, confidence=${
            status.evidenceConfidenceScore ?? "—"
          }, triage=${status.triagePriorityScore ?? "—"}.`,
        });
      } else if (status?.l2Route === "target_confirmed") {
        lines.push({
          tone: "ion",
          message: "Waiting for leak-type classification, severity scoring, and incident insight generation.",
        });
      } else {
        lines.push({
          tone: "neutral",
          message: "L4 runs only after L2 confirms a target-owned leak.",
        });
      }
      break;
  }

  if (stage.detail && !lines.some((line) => line.message === stage.detail)) {
    lines.push({
      tone: stage.state === "complete" ? "ok" : stage.state === "stopped" ? "medium" : "neutral",
      message: stage.detail,
    });
  }

  return lines;
}

function stageIcon(stage: ManualUploadPipelineStage) {
  if (stage.state === "complete") return <CheckCircle2 size={16} />;
  if (stage.state === "running") return <Loader2 size={16} className="spin" />;
  return <Circle size={16} />;
}

function ProgressRail({
  stages,
  selectedStageId,
  onSelectStage,
}: {
  stages: ManualUploadPipelineStage[];
  selectedStageId: ManualUploadPipelineStage["id"];
  onSelectStage: (stageId: ManualUploadPipelineStage["id"]) => void;
}) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "1fr", md: `repeat(${stages.length}, 1fr)` },
        gap: 1,
      }}
    >
      {stages.map((stage, index) => {
        const tone = stageTone(stage);
        const toneColor =
          tone === "ok"
            ? colors.verified
            : tone === "critical"
              ? severityColor.critical
              : tone === "medium"
                ? severityColor.medium
                : tone === "ion"
                  ? colors.ion
                  : colors.text3;
        const isSelected = selectedStageId === stage.id;
        return (
          <Box
            component="button"
            type="button"
            key={stage.id}
            onClick={() => onSelectStage(stage.id)}
            sx={{
              position: "relative",
              minHeight: 132,
              cursor: "pointer",
              textAlign: "left",
              border: `1px solid ${
                isSelected
                  ? alpha(toneColor, 0.9)
                  : tone === "neutral"
                    ? colors.edge
                    : alpha(toneColor, 0.45)
              }`,
              borderRadius: `${layoutTokens.radiusSm}px`,
              background:
                isSelected
                  ? `linear-gradient(180deg, ${alpha(toneColor, 0.18)}, ${alpha(toneColor, 0.05)})`
                  : tone === "neutral"
                  ? "rgba(255,255,255,0.015)"
                  : `linear-gradient(180deg, ${alpha(toneColor, 0.12)}, rgba(255,255,255,0.015))`,
              p: 1.4,
              overflow: "hidden",
              boxShadow: isSelected ? `0 0 0 1px ${alpha(toneColor, 0.28)} inset` : "none",
              color: colors.text1,
              "&:hover": {
                borderColor: alpha(toneColor, 0.8),
                backgroundColor: alpha(toneColor, 0.06),
              },
            }}
          >
            <Stack direction="row" alignItems="center" gap={0.8}>
              <Box sx={{ color: toneColor, display: "flex" }}>{stageIcon(stage)}</Box>
              <Typography sx={{ fontSize: 12, color: colors.text1, fontWeight: 700 }}>
                {stage.label}
              </Typography>
              <Tag
                tone={
                  tone === "ok"
                    ? "ok"
                    : tone === "critical"
                      ? "critical"
                      : tone === "medium"
                        ? "medium"
                        : tone === "ion"
                          ? "ion"
                          : "neutral"
                }
              >
                {stage.state}
              </Tag>
            </Stack>
            <Typography
              sx={{
                mt: 1,
                color: colors.text2,
                fontSize: 11.5,
                lineHeight: 1.5,
              }}
            >
              {stage.caption}
            </Typography>
            {stage.detail && (
              <Typography
                sx={{
                  mt: 1,
                  color: toneColor,
                  fontFamily: fonts.mono,
                  fontSize: 10.5,
                  lineHeight: 1.5,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                }}
              >
                {stage.detail}
              </Typography>
            )}
            <Typography
              sx={{
                position: "absolute",
                right: 10,
                bottom: 8,
                fontFamily: fonts.mono,
                fontSize: 9,
                color: alpha(colors.text3, 0.85),
              }}
            >
              {String(index + 1).padStart(2, "0")}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

function UploadLogs({
  stage,
  lines,
}: {
  stage: ManualUploadPipelineStage | null;
  lines: UploadLogLine[];
}) {
  return (
    <Panel
      title={stage ? `${stage.label} logs` : "Run logs"}
      meta={stage ? `${stage.state.toUpperCase()} · ${lines.length} EVENTS` : `${lines.length} EVENTS`}
    >
      <Stack gap={0.9}>
        {lines.map((line, index) => {
          const toneColor =
            line.tone === "ok"
              ? colors.verified
              : line.tone === "critical"
                ? severityColor.critical
                : line.tone === "medium"
                  ? severityColor.medium
                  : line.tone === "ion"
                    ? colors.ion
                    : colors.text3;
          return (
            <Stack
              key={`${index}-${line.message}`}
              direction="row"
              gap={1}
              alignItems="flex-start"
              sx={{
                borderLeft: `2px solid ${alpha(toneColor, 0.75)}`,
                pl: 1,
                py: 0.2,
              }}
            >
              <Typography
                sx={{
                  color: toneColor,
                  fontFamily: fonts.mono,
                  fontSize: 10,
                  minWidth: 30,
                }}
              >
                {String(index + 1).padStart(2, "0")}
              </Typography>
              <Typography sx={{ color: colors.text2, fontSize: 11.5, lineHeight: 1.55 }}>
                {line.message}
              </Typography>
            </Stack>
          );
        })}
      </Stack>
    </Panel>
  );
}

function UploadRow({
  upload,
  selected,
  onSelect,
}: {
  upload: ManualUploadStatus;
  selected: boolean;
  onSelect: () => void;
}) {
  const route = upload.l2Route;
  const tone = uploadRowTone(upload);
  return (
    <Box
      component="button"
      type="button"
      onClick={onSelect}
      sx={{
        width: "100%",
        cursor: "pointer",
        display: "grid",
        gridTemplateColumns: {
          xs: "1fr",
          md: "minmax(240px, 1.4fr) 140px 150px 120px 120px",
        },
        gap: 1.4,
        alignItems: "center",
        textAlign: "left",
        border: 0,
        borderTop: `1px solid ${colors.edge}`,
        background: selected
          ? `linear-gradient(90deg, ${alpha(colors.ion, 0.14)}, transparent 62%)`
          : "transparent",
        px: 1,
        py: 1.2,
        color: colors.text1,
        "&:hover": { backgroundColor: alpha(colors.ion, 0.06) },
      }}
    >
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: colors.text1 }}>
          {upload.title}
        </Typography>
        <Typography sx={{ fontFamily: fonts.mono, fontSize: 10.5, color: colors.text3 }}>
          {upload.uploadId}
        </Typography>
      </Box>
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>
        {upload.lastUpdatedAt
          ? relativeTime(upload.lastUpdatedAt)
          : upload.ingestedAt
            ? relativeTime(upload.ingestedAt)
            : "pending"}
      </Typography>
      <Tag tone={route ? routeTone[route] : tone}>
        {route ? routeLabel[route] : upload.pipelineState.replaceAll("_", " ")}
      </Tag>
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>
        {upload.impactSeverityScore ?? "—"}
      </Typography>
      <Typography sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text2 }}>
        {upload.evidenceConfidenceScore ?? "—"}
      </Typography>
    </Box>
  );
}

function manualResultSummary(status: ManualUploadStatus): string {
  if (status.executiveSummary) return status.executiveSummary;
  if (status.relationshipAiStatus === "error") {
    return "L1 relevance classification failed. The row is cached for audit and was not treated as not relevant.";
  }
  if (status.pipelineState === "stopped_after_l1") {
    if (status.relationshipLabel === "no_leak") {
      return "Stopped after L1: the classifier did not find a leak claim in this paste dump.";
    }
    if (status.relationshipLabel === "other_organization_leak") {
      return "Stopped after L1: the leak appears to affect another organization, not the selected tenant.";
    }
    if (status.relationshipLabel === "target_mentioned_no_leak") {
      return status.l2Eligible
        ? "L1 marked this as a suspicious target mention. L2 should verify whether the mention is actually connected to a leak."
        : "Stopped after L1: the selected organization was mentioned, but there was not enough suspicious leak evidence to run L2.";
    }
    return "Stopped after L1: this upload is not eligible for downstream evidence extraction.";
  }
  if (status.l2Route && status.l2Route !== "target_confirmed") {
    return status.routingReason
      ? `Stopped after L2: ${status.routingReason}.`
      : `Stopped after L2: route=${status.l2Route}.`;
  }
  if (status.l2Route === "target_confirmed" && !status.detailAvailable) {
    return "Target ownership is grounded. The pipeline is finishing graph promotion, leak-type classification, severity, or the AI incident brief.";
  }
  return "The pipeline is still working through this upload.";
}

function UploadResult({
  data,
  onOpenIncident,
  onOpenGraph,
}: {
  data: ManualUploadStatusResponse;
  onOpenIncident: (incidentKey: string) => void;
  onOpenGraph: (incidentKey: string) => void;
}) {
  const status = data.status;
  if (!status) {
    return (
      <Panel title="Selected upload">
        <Typography sx={{ color: colors.text2, fontSize: 12 }}>
          Waiting for Snowflake to ingest this manual paste dump.
        </Typography>
      </Panel>
    );
  }

  const leakTypes = status.leakTypeLabels;
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", xl: "1.2fr 0.8fr" }, gap: 2 }}>
      <Panel
        title="Result"
        meta={status.incidentKey ? "INCIDENT READY" : status.pipelineState.toUpperCase()}
      >
        <Stack gap={1.4}>
          <Stack direction="row" alignItems="flex-start" gap={1.5} flexWrap="wrap">
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography sx={{ color: colors.text1, fontSize: 16, fontWeight: 800 }}>
                {status.insightHeadline ?? status.title}
              </Typography>
              <Typography sx={{ mt: 0.5, color: colors.text3, fontFamily: fonts.mono, fontSize: 10.5 }}>
                {hostOf(status.url)} · {formatCount(status.contentLength)} bytes
              </Typography>
            </Box>
            {status.impactSeverityBand && (
              <SeverityChip
                band={status.impactSeverityBand}
                score={status.impactSeverityScore}
              />
            )}
          </Stack>

          <Typography sx={{ color: colors.text2, fontSize: 12.2, lineHeight: 1.65 }}>
            {manualResultSummary(status)}
          </Typography>

          <Stack direction="row" gap={0.8} flexWrap="wrap">
            {leakTypes.length > 0
              ? leakTypes.map((type) => (
                  <Tag key={type} tone={type === "credential" || type === "financial" ? "critical" : "ion"}>
                    {leakTypeLabel[type]}
                  </Tag>
                ))
              : <Tag>data types pending</Tag>}
            {status.relationshipLabel && <Tag tone="ion">{status.relationshipLabel}</Tag>}
            {status.l2Route && <Tag tone={routeTone[status.l2Route]}>{routeLabel[status.l2Route]}</Tag>}
          </Stack>

          {status.incidentKey && (
            <Stack direction="row" gap={1} flexWrap="wrap">
              <Button
                size="small"
                variant="contained"
                onClick={() => onOpenIncident(status.incidentKey!)}
              >
                Open AI summary
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<Network size={14} />}
                onClick={() => onOpenGraph(status.incidentKey!)}
              >
                Open graph
              </Button>
            </Stack>
          )}
        </Stack>
      </Panel>

      <Panel title="Scores and evidence">
        <Stack gap={1.2}>
          <ScoreLine label="Evidence score" value={status.evidenceScore} />
          <ScoreLine label="Target match" value={status.targetMatchScore} />
          <ScoreLine label="Impact" value={status.impactSeverityScore} />
          <ScoreLine label="Confidence" value={status.evidenceConfidenceScore} />
          <ScoreLine label="Triage" value={status.triagePriorityScore} />
          <Box sx={{ pt: 0.6, borderTop: `1px solid ${colors.edge}` }}>
            <Typography sx={{ color: colors.text2, fontSize: 11.5, lineHeight: 1.6 }}>
              Claims accepted:{" "}
              <b style={{ color: colors.text1 }}>{status.acceptedClaimCount}</b> /{" "}
              {status.claimCount}. Entities accepted:{" "}
              <b style={{ color: colors.text1 }}>{status.acceptedEntityCount}</b> /{" "}
              {status.entityCount}.
            </Typography>
            {status.indicatorSummary && (
              <Typography sx={{ mt: 0.7, fontFamily: fonts.mono, fontSize: 10.5, color: colors.text3 }}>
                {status.indicatorSummary}
              </Typography>
            )}
          </Box>
        </Stack>
      </Panel>
    </Box>
  );
}

function ScoreLine({ label, value }: { label: string; value: number | null }) {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" gap={2}>
        <Typography sx={{ color: colors.text2, fontSize: 11.5 }}>{label}</Typography>
        <Typography sx={{ fontFamily: fonts.mono, color: value === null ? colors.text3 : colors.text1, fontSize: 11.5 }}>
          {value ?? "—"}
        </Typography>
      </Stack>
      <LinearProgress
        variant="determinate"
        value={pct}
        sx={{
          mt: 0.6,
          height: 5,
          borderRadius: 4,
          backgroundColor: alpha(colors.text3, 0.16),
          "& .MuiLinearProgress-bar": {
            borderRadius: 4,
            backgroundColor:
              pct >= 80 ? severityColor.critical : pct >= 50 ? severityColor.high : colors.ion,
          },
        }}
      />
    </Box>
  );
}

export default function UploadPasteDumpPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const { session, isLoading: isAuthLoading } = useAuth();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploads, setUploads] = useState<ManualUploadStatus[]>([]);
  const [selectedUploadId, setSelectedUploadId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ManualUploadStatusResponse | null>(null);
  const [selectedStageId, setSelectedStageId] =
    useState<ManualUploadPipelineStage["id"]>("upload");
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const orgId = session?.scope.kind === "org" ? session.scope.orgId : null;
  const canUpload = Boolean(orgId && file && !isUploading);

  const orgQuery = useCallback(() => {
    const query = new URLSearchParams();
    if (session?.user.role === "SUPER_ADMIN" && orgId) query.set("orgId", orgId);
    return query;
  }, [orgId, session?.user.role]);

  const loadUploads = useCallback(async (signal?: AbortSignal) => {
    if (!orgId) return;
    const query = orgQuery();
    const url = query.size ? `/api/manual-uploads?${query.toString()}` : "/api/manual-uploads";
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    const body = (await response.json()) as
      | { uploads: ManualUploadStatus[] }
      | { error?: string };
    if (!response.ok || !("uploads" in body)) {
      throw new Error(
        "error" in body && body.error
          ? body.error
          : "Unable to load manual uploads.",
      );
    }
    setUploads(body.uploads);
    setSelectedUploadId((current) => current ?? body.uploads[0]?.uploadId ?? null);
  }, [orgId, orgQuery]);

  const loadSelected = useCallback(async (uploadId: string, signal?: AbortSignal) => {
    const query = orgQuery();
    const suffix = query.size ? `?${query.toString()}` : "";
    const response = await fetch(`/api/manual-uploads/${uploadId}${suffix}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    });
    const body = (await response.json()) as ManualUploadStatusResponse | { error?: string };
    if (!response.ok || !("stages" in body)) {
      throw new Error(
        "error" in body && body.error
          ? body.error
          : "Unable to load paste-dump status.",
      );
    }
    setSelected(body);
  }, [orgQuery]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!orgId) return;
    await loadUploads(signal);
    if (selectedUploadId) await loadSelected(selectedUploadId, signal);
  }, [loadSelected, loadUploads, orgId, selectedUploadId]);

  useEffect(() => {
    if (isAuthLoading) return;
    if (!orgId) {
      setUploads([]);
      setSelected(null);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    void refresh(controller.signal)
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Unable to load uploads.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [isAuthLoading, orgId, refresh]);

  useEffect(() => {
    if (!selectedUploadId) {
      setSelected(null);
      return;
    }
    const controller = new AbortController();
    void loadSelected(selectedUploadId, controller.signal).catch((loadError) => {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return;
      setError(loadError instanceof Error ? loadError.message : "Unable to load selected upload.");
    });
    return () => controller.abort();
  }, [loadSelected, selectedUploadId]);

  useEffect(() => {
    if (!selectedUploadId || isTerminal(selected)) return;
    const pollMs = selected?.status?.rawLoaded ? FAST_POLL_MS : RAW_INGEST_POLL_MS;
    const interval = window.setInterval(() => {
      void loadSelected(selectedUploadId).catch((pollError) => {
        setError(pollError instanceof Error ? pollError.message : "Unable to refresh upload status.");
      });
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [loadSelected, selected, selectedUploadId]);

  useEffect(() => {
    if (!isTerminal(selected)) return;
    void loadUploads().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Unable to refresh upload list.");
    });
  }, [loadUploads, selected]);

  const handleUpload = useCallback(async () => {
    if (!file || !orgId) return;
    setIsUploading(true);
    setError(null);
    setNotice(null);

    const form = new FormData();
    form.set("file", file);
    form.set("title", title.trim() || file.name.replace(/\.txt$/i, ""));
    form.set("orgId", orgId);

    try {
      const response = await fetch("/api/manual-uploads", {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      const body = (await response.json()) as ManualUploadCreateResponse | { error?: string };
      if (!response.ok || !("uploadId" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : "Unable to upload paste dump.",
        );
      }
      setSelectedUploadId(body.uploadId);
      setNotice(body.message);
      setFile(null);
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
      await refresh();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Unable to upload paste dump.");
    } finally {
      setIsUploading(false);
    }
  }, [file, orgId, refresh, title]);

  const stats = useMemo(() => {
    const completed = uploads.filter((upload) => upload.detailAvailable).length;
    const stopped = uploads.filter(isStoppedBeforeIncident).length;
    const active = uploads.filter(
      (upload) => !upload.detailAvailable && !isStoppedBeforeIncident(upload),
    ).length;
    return { completed, active, stopped };
  }, [uploads]);

  const selectedStage = useMemo(
    () => selected?.stages.find((stage) => stage.id === selectedStageId) ?? null,
    [selected, selectedStageId],
  );
  const logLines = useMemo(
    () => buildStageLogs(selected, error, isUploading, selectedStage),
    [error, isUploading, selected, selectedStage],
  );

  const headerRight = (
    <Button
      size="small"
      variant="outlined"
      startIcon={<RefreshCw size={13} />}
      disabled={!orgId || isLoading || isUploading}
      onClick={() => void refresh().catch((refreshError) =>
        setError(refreshError instanceof Error ? refreshError.message : "Refresh failed."),
      )}
    >
      Refresh
    </Button>
  );

  if (isAuthLoading || isLoading) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Upload Paste Dump"
          subtitle="Upload one raw paste and watch it move through the same L0–L4 pipeline."
          right={headerRight}
        />
        <Panel title="Loading">
          <LinearProgress />
        </Panel>
      </Stack>
    );
  }

  if (!orgId) {
    return (
      <Stack gap={2}>
        <PageHeader
          title="Upload Paste Dump"
          subtitle="Select one organization before running a manual leak scan."
        />
        <Panel>
          <Typography sx={{ color: colors.text2 }}>
            Manual uploads are organization-isolated. Choose one tenant from the top-right
            selector, then upload a paste dump for that tenant only.
          </Typography>
        </Panel>
      </Stack>
    );
  }

  return (
    <Stack
      gap={2}
      sx={{
        minHeight: `calc(100dvh - ${layoutTokens.headerHeight + (layoutTokens.gutter - 4) * 2}px)`,
      }}
    >
      <PageHeader
        title="Upload Paste Dump"
        subtitle="Feed a raw paste dump into one isolated organization run — no crawler and no scheduler required."
        right={headerRight}
      />

      {error && (
        <Alert severity="error" variant="outlined" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="info" variant="outlined" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <StatGrid>
        <StatCard
          label="Manual uploads"
          value={uploads.length.toLocaleString()}
          sub="recent runs for this organization"
          accent={colors.ion}
          valueColor={colors.ion}
        />
        <StatCard
          label="Incidents ready"
          value={stats.completed.toLocaleString()}
          sub="AI summary and graph available"
          accent={colors.verified}
          valueColor={colors.verified}
        />
        <StatCard
          label="Active scans"
          value={stats.active.toLocaleString()}
          sub="polling near real time"
          accent={severityColor.high}
        />
        <StatCard
          label="Stopped before incident"
          value={stats.stopped.toLocaleString()}
          sub="not confirmed for this org"
          accent={severityColor.medium}
        />
      </StatGrid>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", xl: "0.9fr 1.1fr" }, gap: 2 }}>
        <Panel title="Upload raw paste" meta="TXT · ONE-SHOT">
          <Stack gap={1.5}>
            <Typography sx={{ color: colors.text2, fontSize: 12.3, lineHeight: 1.65 }}>
              Upload a plain text paste dump. The console stores it as a single schema-v2
              JSONL.gz page with <Mono>source=manual_upload</Mono>, then submits one ingest
              task. The downstream AI stages run only if the page becomes eligible.
            </Typography>
            <TextField
              label="Display title"
              size="small"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Example: suspicious marketplace paste"
              fullWidth
            />
            <Button
              component="label"
              variant="outlined"
              startIcon={<FileText size={16} />}
              sx={{ justifyContent: "flex-start" }}
            >
              {file ? file.name : "Choose .txt file"}
              <input
                ref={fileRef}
                hidden
                type="file"
                accept=".txt,text/plain"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </Button>
            <Button
              variant="contained"
              startIcon={isUploading ? <Loader2 size={16} className="spin" /> : <UploadCloud size={16} />}
              disabled={!canUpload}
              onClick={() => void handleUpload()}
            >
              {isUploading ? "Uploading & starting scan" : "Upload & Run Leak Scan"}
            </Button>
            <Typography sx={{ color: colors.text3, fontSize: 11, lineHeight: 1.55 }}>
              This does not resume the five-minute crawler/ingest schedule. It only submits
              one manual ingest run for the selected organization.
            </Typography>
          </Stack>
        </Panel>

        <Panel title="Recent paste-dump runs" meta={`${uploads.length} RUNS`}>
          {uploads.length === 0 ? (
            <Typography sx={{ color: colors.text2, fontSize: 12 }}>
              No manual paste uploads yet for this organization.
            </Typography>
          ) : (
            <Box sx={{ maxHeight: 360, overflow: "auto" }}>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "1fr",
                    md: "minmax(240px, 1.4fr) 140px 150px 120px 120px",
                  },
                  gap: 1.4,
                  px: 1,
                  pb: 0.9,
                  color: colors.text3,
                  fontFamily: fonts.mono,
                  fontSize: 9.5,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                }}
              >
                <span>Upload</span>
                <span>Updated</span>
                <span>State</span>
                <span>Impact</span>
                <span>Confidence</span>
              </Box>
              {uploads.map((upload) => (
                <UploadRow
                  key={upload.uploadId}
                  upload={upload}
                  selected={upload.uploadId === selectedUploadId}
                  onSelect={() => setSelectedUploadId(upload.uploadId)}
                />
              ))}
            </Box>
          )}
        </Panel>
      </Box>

      <Panel title="Live pipeline flow" meta={selectedUploadId ?? "NO UPLOAD SELECTED"}>
        {selected ? (
          <ProgressRail
            stages={selected.stages}
            selectedStageId={selectedStageId}
            onSelectStage={setSelectedStageId}
          />
        ) : (
          <Typography sx={{ color: colors.text2, fontSize: 12 }}>
            Upload or select a paste dump to watch L0–L4 progress.
          </Typography>
        )}
      </Panel>

      <UploadLogs stage={selectedStage} lines={logLines} />

      {selected && (
        <UploadResult
          data={selected}
          onOpenIncident={(incidentKey) => router.push(`/leaks/${incidentKey}`)}
          onOpenGraph={(incidentKey) => router.push(`/graph?incidentKey=${incidentKey}`)}
        />
      )}

      <style jsx global>{`
        .spin {
          animation: nocturne-spin 1s linear infinite;
        }
        @keyframes nocturne-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </Stack>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Box component="span" sx={{ fontFamily: fonts.mono, color: colors.ion }}>
      {children}
    </Box>
  );
}

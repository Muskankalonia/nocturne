"use client";

import { useMemo } from "react";
import { Box, Button, Stack, Typography, alpha } from "@mui/material";
import { CalendarClock, FileDown, FileSpreadsheet, Mail } from "lucide-react";

import { ExportEvidenceButton } from "@/components/triage/ExportEvidenceButton";
import { Panel } from "@/components/ui/Panel";
import { PageHeader } from "@/components/ui/Primitives";
import { useAuth } from "@/contexts/AuthContext";
import { evidenceReportUrl, weeklyReportUrl } from "@/lib/triage-client";
import { colors, fonts, layout } from "@/theme/tokens";

/**
 * Reporting: evidence exports over a chosen window, and the weekly report.
 *
 * Every download here is a plain link. The routes answer with
 * Content-Disposition, so the browser saves the file directly rather than the
 * page buffering a PDF in memory to hand back to the same browser.
 */
export default function ReportsPage() {
  const { session } = useAuth();
  const orgId = session?.scope.kind === "org" ? session.scope.orgId : null;

  const weekLabel = useMemo(() => {
    // Mirrors resolveWeeklyPeriod on the server: the trailing seven days ending
    // at the most recent UTC midnight. Shown so the download is not a surprise.
    const now = new Date();
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const start = new Date(end.getTime() - 7 * 24 * 3_600_000);
    return `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`;
  }, []);

  return (
    <Stack gap={2}>
      <PageHeader
        title="Reports"
        subtitle="Evidence exports and the weekly summary, generated from Snowflake at the moment you ask for them."
        right={<ExportEvidenceButton orgId={orgId} />}
      />

      <Box
        sx={{
          display: "grid",
          gap: `${layout.gap}px`,
          gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" },
        }}
      >
        <Panel title="Evidence report — PDF">
          <Stack gap={1.4}>
            <Typography sx={{ fontSize: 12.5, color: colors.text2, lineHeight: 1.7 }}>
              A printable summary of the incidents raised in a window: severity
              distribution, the full incident table, and written detail on the
              highest-impact findings with their recommended actions.
            </Typography>
            <Stack direction="row" gap={1} flexWrap="wrap">
              {(["24h", "7d", "30d", "90d"] as const).map((window) => (
                <Button
                  key={window}
                  size="small"
                  variant="outlined"
                  component="a"
                  href={evidenceReportUrl(window, "pdf", orgId)}
                  startIcon={<FileDown size={13} />}
                  sx={{ borderColor: colors.edgeHi, color: colors.ion }}
                >
                  {windowLabel(window)}
                </Button>
              ))}
            </Stack>
          </Stack>
        </Panel>

        <Panel title="Evidence report — CSV">
          <Stack gap={1.4}>
            <Typography sx={{ fontSize: 12.5, color: colors.text2, lineHeight: 1.7 }}>
              One row per incident with every score, classification, actor
              attribution and workflow field, for analysis outside the console.
            </Typography>
            <Stack direction="row" gap={1} flexWrap="wrap">
              {(["24h", "7d", "30d", "90d"] as const).map((window) => (
                <Button
                  key={window}
                  size="small"
                  variant="outlined"
                  component="a"
                  href={evidenceReportUrl(window, "csv", orgId)}
                  startIcon={<FileSpreadsheet size={13} />}
                  sx={{ borderColor: colors.edgeHi, color: colors.ion }}
                >
                  {windowLabel(window)}
                </Button>
              ))}
            </Stack>
          </Stack>
        </Panel>
      </Box>

      <Panel title="Weekly report">
        <Stack gap={1.6}>
          <Stack direction="row" gap={1.2} alignItems="flex-start" flexWrap="wrap">
            <Box
              sx={{
                p: 1,
                borderRadius: `${layout.radiusSm}px`,
                backgroundColor: alpha(colors.ion, 0.1),
                border: `1px solid ${alpha(colors.ion, 0.28)}`,
                display: "flex",
              }}
            >
              <CalendarClock size={16} color={colors.ion} />
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                Week to date
              </Typography>
              <Typography
                sx={{ fontFamily: fonts.mono, fontSize: 11, color: colors.text3, mt: 0.3 }}
              >
                {weekLabel} · UTC
              </Typography>
              <Typography
                sx={{ fontSize: 12.5, color: colors.text2, mt: 1, lineHeight: 1.7 }}
              >
                The period snaps to a UTC midnight boundary, so downloading this
                report twice in the same day produces the same document — and it
                is the same document the scheduled email carries.
              </Typography>
            </Box>
            <Button
              size="small"
              variant="contained"
              component="a"
              href={weeklyReportUrl(orgId)}
              startIcon={<FileDown size={14} />}
            >
              Download weekly PDF
            </Button>
          </Stack>

          <Stack
            direction="row"
            gap={1.2}
            alignItems="flex-start"
            sx={{
              pt: 1.6,
              borderTop: `1px solid ${colors.edge}`,
            }}
          >
            <Mail size={15} color={colors.text3} style={{ marginTop: 2 }} />
            <Typography sx={{ fontSize: 12, color: colors.text3, lineHeight: 1.7 }}>
              The same report is emailed on a schedule to everyone who has the
              weekly digest switched on in{" "}
              <Box component="a" href="/settings" sx={{ color: colors.ion }}>
                Settings
              </Box>
              , with the PDF attached. Delivery is driven by a scheduled call to
              the console rather than by this page, so a missing email is a
              scheduler problem and not a reporting one.
            </Typography>
          </Stack>
        </Stack>
      </Panel>

      <Panel>
        <Typography sx={{ fontSize: 11.5, color: colors.text3, lineHeight: 1.7 }}>
          Reports carry classifications, scores, and the model&apos;s own summaries.
          They never carry a verbatim excerpt from a source page — the same
          boundary the alert email, the Jira ticket, and the Slack message hold.
          Supporting evidence stays in the console, where access is actually
          enforced. Record counts are the seller&apos;s claim, not a measured figure.
        </Typography>
      </Panel>
    </Stack>
  );
}

function windowLabel(window: "24h" | "7d" | "30d" | "90d"): string {
  return {
    "24h": "Last 24 hours",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
  }[window];
}

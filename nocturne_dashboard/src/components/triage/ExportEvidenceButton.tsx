"use client";

import { useState } from "react";
import { Button, ListItemText, Menu, MenuItem, Typography } from "@mui/material";
import { ChevronDown, FileDown } from "lucide-react";

import { evidenceReportUrl } from "@/lib/triage-client";
import { colors, fonts } from "@/theme/tokens";
import type { ReportFormat, ReportWindow } from "@/types/triage";

/**
 * "Export evidence report" — a PDF summary or a CSV of the incidents in a
 * timeframe.
 *
 * The download is an ordinary link navigation rather than a fetch. The route
 * answers with `Content-Disposition: attachment`, so the browser handles the
 * save — which means a large PDF is never buffered in the tab, and the user
 * gets the download UI they already know instead of a spinner in ours.
 */

const WINDOWS: Array<{ value: ReportWindow; label: string }> = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export interface ExportEvidenceButtonProps {
  /** null at fleet scope — the export then covers every permitted tenant. */
  orgId: string | null;
  label?: string;
}

export function ExportEvidenceButton({
  orgId,
  label = "Export evidence",
}: ExportEvidenceButtonProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const item = (window: ReportWindow, format: ReportFormat, text: string) => (
    <MenuItem
      key={`${window}-${format}`}
      component="a"
      href={evidenceReportUrl(window, format, orgId)}
      onClick={() => setAnchor(null)}
      sx={{ fontSize: 12.5, py: 0.7 }}
    >
      <ListItemText primaryTypographyProps={{ fontSize: 12.5 }}>{text}</ListItemText>
    </MenuItem>
  );

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<FileDown size={14} />}
        endIcon={<ChevronDown size={13} />}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ borderColor: colors.edgeHi, color: colors.ion }}
      >
        {label}
      </Button>
      <Menu
        anchorEl={anchor}
        open={anchor !== null}
        onClose={() => setAnchor(null)}
        slotProps={{ paper: { sx: { minWidth: 232 } } }}
      >
        <Typography
          sx={{
            px: 2,
            pt: 1,
            pb: 0.5,
            fontFamily: fonts.mono,
            fontSize: 9,
            letterSpacing: "0.12em",
            color: colors.text3,
          }}
        >
          PDF SUMMARY
        </Typography>
        {WINDOWS.map((entry) => item(entry.value, "pdf", entry.label))}
        <Typography
          sx={{
            px: 2,
            pt: 1.2,
            pb: 0.5,
            fontFamily: fonts.mono,
            fontSize: 9,
            letterSpacing: "0.12em",
            color: colors.text3,
            borderTop: `1px solid ${colors.edge}`,
          }}
        >
          CSV OF INCIDENTS
        </Typography>
        {WINDOWS.map((entry) => item(entry.value, "csv", entry.label))}
      </Menu>
    </>
  );
}

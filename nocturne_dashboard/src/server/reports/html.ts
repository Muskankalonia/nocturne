import { colors, severityColor } from "@/theme/tokens";
import type { SeverityBand } from "@/types";
import type { ReportPayload } from "@/types/triage";

/**
 * The printed evidence report and weekly summary.
 *
 * One template, two entry points. Rendering to HTML first and printing that to
 * PDF keeps the artifact looking like the console an executive already
 * recognizes, and means the same markup can be dropped into a digest email
 * without maintaining a second layout.
 *
 * The report carries classifications, scores, and the model's own summaries.
 * It does not carry verbatim leaked material — same boundary the email, the
 * Jira ticket and the Slack message hold, and for the same reason: a PDF gets
 * forwarded.
 */

const LEAK_TYPE_LABELS: Record<string, string> = {
  credential: "Credentials",
  corporate_data: "Corporate data",
  pii: "Personal data",
  financial: "Financial data",
  malware_exploit: "Malware / exploit",
};

function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function date(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 10);
}

function dateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

function bandColor(band: SeverityBand | null): string {
  return band ? severityColor[band] : colors.text3;
}

function statCard(label: string, value: string, accent: string = colors.ion): string {
  return `
    <div class="stat" style="border-top-color:${accent}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value" style="color:${accent}">${esc(value)}</div>
    </div>`;
}

function severityBar(payload: ReportPayload): string {
  const bands: SeverityBand[] = ["critical", "high", "medium", "low", "informational"];
  const total = payload.summary.totalIncidents || 1;
  return bands
    .map((band) => {
      const count = payload.summary.byBand[band];
      if (!count) return "";
      const pct = Math.round((count / total) * 100);
      return `
        <div class="band-row">
          <div class="band-name" style="color:${severityColor[band]}">${band}</div>
          <div class="band-track">
            <div class="band-fill" style="width:${pct}%;background:${severityColor[band]}"></div>
          </div>
          <div class="band-count">${count}</div>
        </div>`;
    })
    .join("");
}

function incidentRow(
  incident: ReportPayload["incidents"][number],
  index: number,
): string {
  const accent = bandColor(incident.impactSeverityBand);
  const classes = incident.leakTypes
    .map((type) => LEAK_TYPE_LABELS[type] ?? type.replace(/_/g, " "))
    .join(", ");
  const mitigated = incident.remediationStatus === "mitigated";

  return `
    <tr>
      <td class="idx">${index + 1}</td>
      <td>
        <div class="title">${esc(incident.insightHeadline ?? incident.title)}</div>
        <div class="sub">${esc(host(incident.url))} · ${esc(date(incident.firstSeen))}</div>
      </td>
      <td class="mono" style="color:${accent}">
        ${incident.impactSeverityScore ?? "—"}
        <span class="band">${esc(incident.impactSeverityBand ?? "")}</span>
      </td>
      <td class="mono verified">${incident.evidenceConfidenceScore ?? "—"}</td>
      <td class="mono">${incident.triagePriorityScore ?? "—"}</td>
      <td class="small">${esc(classes || "none extracted")}</td>
      <td class="mono">${
        incident.quantityClaimed === null
          ? "—"
          : incident.quantityClaimed.toLocaleString()
      }</td>
      <td class="mono">${esc(incident.actorName ?? "unattributed")}</td>
      <td class="small">
        <span class="pill ${mitigated ? "pill-ok" : "pill-open"}">
          ${esc(mitigated ? "Mitigated" : incident.remediationStatus.replace(/_/g, " "))}
        </span>
        ${incident.jiraIssueKey ? `<div class="sub mono">${esc(incident.jiraIssueKey)}</div>` : ""}
      </td>
    </tr>`;
}

/** The two or three worst incidents, written out rather than tabulated. */
function narrative(payload: ReportPayload): string {
  const featured = payload.incidents
    .filter((incident) => incident.executiveSummary || incident.businessImpact)
    .slice(0, 3);
  if (!featured.length) return "";

  return `
    <section class="section">
      <h2>Detail on the highest-impact incidents</h2>
      ${featured
        .map(
          (incident) => `
        <div class="detail" style="border-left-color:${bandColor(incident.impactSeverityBand)}">
          <div class="detail-head">
            <span class="detail-band" style="color:${bandColor(incident.impactSeverityBand)}">
              ${esc((incident.impactSeverityBand ?? "").toUpperCase())}
              ${incident.impactSeverityScore !== null ? `· ${incident.impactSeverityScore}` : ""}
            </span>
            <span class="detail-date">${esc(date(incident.firstSeen))}</span>
          </div>
          <h3>${esc(incident.insightHeadline ?? incident.title)}</h3>
          ${
            incident.executiveSummary
              ? `<p>${esc(incident.executiveSummary)}</p>`
              : ""
          }
          ${
            incident.businessImpact
              ? `<p class="muted"><strong>Business impact.</strong> ${esc(incident.businessImpact)}</p>`
              : ""
          }
          ${
            incident.recommendedActions.length
              ? `<ul>${incident.recommendedActions
                  .slice(0, 4)
                  .map((action) => `<li>${esc(action)}</li>`)
                  .join("")}</ul>`
              : ""
          }
          <div class="sub mono">${esc(incident.incidentKey.slice(0, 16))}… · ${esc(host(incident.url))}</div>
        </div>`,
        )
        .join("")}
    </section>`;
}

const STYLES = `
  @page { size: A4; margin: 14mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: ${colors.void};
    color: ${colors.text1};
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 10.5px;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .muted { color: ${colors.text2}; }
  .verified { color: ${colors.verified}; }
  header {
    border-bottom: 2px solid ${colors.ion};
    padding-bottom: 12px;
    margin-bottom: 18px;
  }
  .eyebrow {
    font-size: 9px; letter-spacing: 0.16em; text-transform: uppercase;
    color: ${colors.ion}; font-weight: 600;
  }
  h1 { margin: 6px 0 4px; font-size: 22px; line-height: 1.2; }
  h2 {
    font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase;
    color: ${colors.text2}; margin: 0 0 10px; font-weight: 600;
  }
  h3 { margin: 4px 0 6px; font-size: 13px; line-height: 1.35; }
  .meta { color: ${colors.text3}; font-size: 10px; }
  .section { margin-bottom: 20px; }
  .stats { display: flex; gap: 8px; margin-bottom: 18px; }
  .stat {
    flex: 1; background: ${colors.hull}; border: 1px solid ${colors.edge};
    border-top-width: 2px; border-radius: 6px; padding: 9px 10px;
  }
  .stat-label {
    font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase;
    color: ${colors.text3};
  }
  .stat-value { font-size: 19px; font-weight: 600; margin-top: 2px; }
  .band-row { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
  .band-name {
    width: 82px; font-size: 9px; letter-spacing: 0.08em; text-transform: uppercase;
  }
  .band-track {
    flex: 1; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.05);
    overflow: hidden;
  }
  .band-fill { height: 100%; border-radius: 3px; }
  .band-count {
    width: 26px; text-align: right; font-size: 10px; color: ${colors.text2};
    font-family: ui-monospace, monospace;
  }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 8px; letter-spacing: 0.1em; text-transform: uppercase;
    color: ${colors.text3}; font-weight: 500; padding: 6px 5px;
    border-bottom: 1px solid ${colors.edgeHi};
  }
  td {
    padding: 7px 5px; vertical-align: top;
    border-bottom: 1px solid ${colors.edge};
  }
  /* Repeat the header on every printed page; a table split across four pages
     with headings only on the first is unusable in a review meeting. */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .idx { color: ${colors.text3}; width: 18px; font-size: 9px; }
  .title { font-weight: 600; font-size: 10.5px; }
  .sub { color: ${colors.text3}; font-size: 8.5px; margin-top: 2px; }
  .small { font-size: 9px; color: ${colors.text2}; }
  .band { display: block; font-size: 7.5px; letter-spacing: 0.08em; text-transform: uppercase; }
  .pill {
    display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 8px;
    letter-spacing: 0.06em; text-transform: uppercase; border: 1px solid;
  }
  .pill-ok { color: ${colors.verified}; border-color: ${colors.verified}; }
  .pill-open { color: ${colors.critical}; border-color: ${colors.critical}; }
  .detail {
    border-left: 3px solid ${colors.ion}; background: ${colors.hull};
    padding: 10px 12px; margin-bottom: 10px; border-radius: 0 6px 6px 0;
    page-break-inside: avoid;
  }
  .detail-head { display: flex; justify-content: space-between; align-items: baseline; }
  .detail-band { font-size: 8.5px; letter-spacing: 0.12em; font-weight: 600; }
  .detail-date { font-size: 8.5px; color: ${colors.text3}; }
  .detail p { margin: 5px 0; }
  .detail ul { margin: 6px 0 4px; padding-left: 15px; color: ${colors.text2}; }
  .empty {
    padding: 26px; text-align: center; color: ${colors.text2};
    border: 1px dashed ${colors.edgeHi}; border-radius: 6px;
  }
  footer {
    margin-top: 20px; padding-top: 10px; border-top: 1px solid ${colors.edge};
    color: ${colors.text3}; font-size: 8.5px; line-height: 1.6;
  }
`;

export interface ReportRenderOptions {
  /** "Evidence report" or "Weekly report" — sets the cover heading. */
  kind: "evidence" | "weekly";
}

export function renderReportHtml(
  payload: ReportPayload,
  options: ReportRenderOptions,
): string {
  const { summary } = payload;
  const isWeekly = options.kind === "weekly";
  const title = isWeekly
    ? `Nocturne weekly report — ${payload.scopeLabel}`
    : `Nocturne evidence report — ${payload.scopeLabel}`;

  const body = summary.totalIncidents
    ? `
      <section class="section">
        <h2>Severity distribution</h2>
        ${severityBar(payload)}
      </section>

      <section class="section">
        <h2>Incidents in period</h2>
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Incident</th>
              <th>Impact</th>
              <th>Confidence</th>
              <th>Triage</th>
              <th>Exposed data</th>
              <th>Records</th>
              <th>Actor</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${payload.incidents.map(incidentRow).join("")}
          </tbody>
        </table>
      </section>

      ${narrative(payload)}`
    : `<div class="empty">
         No confirmed incidents were raised for ${esc(payload.scopeLabel)} in this period.
       </div>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <header>
    <div class="eyebrow">Nocturne${isWeekly ? " · Weekly report" : " · Evidence report"}</div>
    <h1>${esc(payload.scopeLabel)}</h1>
    <div class="meta">
      ${esc(payload.period.label)} ·
      ${esc(dateTime(payload.period.startsAt))} → ${esc(dateTime(payload.period.endsAt))}
      · generated ${esc(dateTime(payload.generatedAt))} by ${esc(payload.generatedBy)}
    </div>
  </header>

  <div class="stats">
    ${statCard(
      "Incidents",
      String(summary.totalIncidents),
      summary.byBand.critical ? colors.critical : colors.ion,
    )}
    ${statCard("Critical", String(summary.byBand.critical), colors.critical)}
    ${statCard("Open", String(summary.openCount), colors.high)}
    ${statCard("Mitigated", String(summary.mitigatedCount), colors.verified)}
    ${statCard(
      "Records claimed",
      summary.recordsClaimed ? summary.recordsClaimed.toLocaleString() : "—",
      colors.text1,
    )}
    ${statCard("Actors", String(summary.distinctActors), colors.ion)}
  </div>

  ${body}

  <footer>
    Every claim in this report was verified verbatim against the crawled source before
    the incident was raised; ungrounded model output is quarantined and never scored.
    Supporting evidence — the verbatim span and its offsets into the source page —
    stays in the Nocturne console. This document intentionally contains no leaked
    material. Record counts are the seller's claim, not a measured figure.
  </footer>
</body>
</html>`;
}

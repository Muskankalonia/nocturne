import type { ReportPayload } from "@/types/triage";

/**
 * CSV export of the incidents in a period.
 *
 * One row per incident, one column per field an analyst would filter on in a
 * spreadsheet. Deliberately flat: arrays are joined with a pipe rather than
 * nested, because the consumer of this file is Excel, not a parser.
 */

const COLUMNS = [
  "incident_key",
  "organization",
  "first_seen",
  "last_seen",
  "title",
  "source_url",
  "source",
  "impact_severity_score",
  "impact_severity_band",
  "evidence_confidence_score",
  "triage_priority_score",
  "triage_priority_band",
  "leak_types",
  "records_claimed",
  "actor",
  "actor_credibility",
  "grounding_level",
  "corroboration_count",
  "sighting_count",
  "remediation_status",
  "mitigated_at",
  "mitigated_by",
  "jira_issue",
  "ai_headline",
  "executive_summary",
] as const;

/**
 * Escapes one field for RFC 4180, and defuses spreadsheet formula injection.
 *
 * A dark-web page title is attacker-controlled text. A title beginning `=` or
 * `+` is executed as a formula the moment the CSV is opened in Excel, which
 * turns an evidence export into remote code execution on an analyst's laptop.
 * Prefixing a single quote makes the cell inert and still readable.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function renderIncidentsCsv(payload: ReportPayload): string {
  const lines: string[] = [];

  // A comment preamble makes the export self-describing: a file found on a
  // share six months later still says what it covers and who produced it.
  lines.push(`# Nocturne evidence export`);
  lines.push(`# scope,${cell(payload.scopeLabel)}`);
  lines.push(`# window,${cell(payload.period.label)}`);
  lines.push(`# period_start,${cell(payload.period.startsAt)}`);
  lines.push(`# period_end,${cell(payload.period.endsAt)}`);
  lines.push(`# generated_at,${cell(payload.generatedAt)}`);
  lines.push(`# generated_by,${cell(payload.generatedBy)}`);
  lines.push(`# incidents,${payload.summary.totalIncidents}`);
  lines.push(COLUMNS.join(","));

  for (const incident of payload.incidents) {
    lines.push(
      [
        incident.incidentKey,
        incident.organizationName,
        incident.firstSeen,
        incident.lastSeen,
        incident.title,
        incident.url,
        incident.source,
        incident.impactSeverityScore,
        incident.impactSeverityBand,
        incident.evidenceConfidenceScore,
        incident.triagePriorityScore,
        incident.triagePriorityBand,
        incident.leakTypes.join(" | "),
        incident.quantityClaimed,
        incident.actorName,
        incident.actorCredibilityScore,
        incident.groundingLevel,
        incident.corroborationCount,
        incident.sightingCount,
        incident.remediationStatus,
        incident.mitigatedAt,
        incident.mitigatedBy,
        incident.jiraIssueKey,
        incident.insightHeadline,
        incident.executiveSummary,
      ]
        .map(cell)
        .join(","),
    );
  }

  // CRLF: the line ending Excel expects, and harmless everywhere else.
  return `${lines.join("\r\n")}\r\n`;
}

export function csvFilename(payload: ReportPayload): string {
  const stamp = payload.generatedAt.slice(0, 10);
  const scope = payload.scopeLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `nocturne-evidence-${scope}-${payload.period.window}-${stamp}.csv`;
}

import { organizations } from "@/mocks/organizations";
import { listReportIncidents } from "@/server/triage-actions";
import { summarizeIncidents } from "@/server/reports/period";
import type { DataScope } from "@/types";
import type { ReportPayload, ReportPeriod } from "@/types/triage";

if (typeof window !== "undefined") {
  throw new Error("Nocturne report assembly may only run on the server.");
}

/** Human label for the scope a report covers. Printed on the cover. */
export function scopeLabel(scope: DataScope): string {
  if (scope.kind === "fleet") return "All monitored organizations";
  const organization = organizations.find(
    (candidate) => candidate.orgId === scope.orgId,
  );
  return organization?.canonicalName ?? scope.orgId;
}

/**
 * Assembles the payload every report format renders from.
 *
 * The scope passed here is always the caller's verified session scope, never
 * anything read off the request — a report is the one artifact in the console
 * that leaves it, so widening its scope by a query parameter would be an
 * exfiltration primitive rather than a bug.
 */
export async function buildReportPayload(input: {
  scope: DataScope;
  period: ReportPeriod;
  generatedBy: string;
}): Promise<ReportPayload> {
  const incidents = await listReportIncidents(input.scope, input.period);
  return {
    period: input.period,
    scopeLabel: scopeLabel(input.scope),
    generatedAt: new Date().toISOString(),
    generatedBy: input.generatedBy,
    summary: summarizeIncidents(incidents),
    incidents,
  };
}

/** Plain-text counterpart to the HTML body, for mail clients that want it. */
export function renderReportText(payload: ReportPayload): string {
  const { summary } = payload;
  const lines = [
    `Nocturne — ${payload.scopeLabel}`,
    `${payload.period.label}: ${payload.period.startsAt.slice(0, 10)} to ${payload.period.endsAt.slice(0, 10)}`,
    "",
    `Incidents: ${summary.totalIncidents}`,
    `Critical: ${summary.byBand.critical}   High: ${summary.byBand.high}`,
    `Open: ${summary.openCount}   Mitigated: ${summary.mitigatedCount}`,
    `Records claimed: ${summary.recordsClaimed ? summary.recordsClaimed.toLocaleString() : "—"}`,
    `Distinct actors: ${summary.distinctActors}`,
    "",
  ];

  if (summary.totalIncidents) {
    lines.push("Top incidents:");
    for (const incident of payload.incidents.slice(0, 10)) {
      lines.push(
        `  [${incident.impactSeverityBand ?? "—"} ${incident.impactSeverityScore ?? "—"}] ${
          incident.insightHeadline ?? incident.title
        }`,
      );
    }
    lines.push("");
  } else {
    lines.push("No confirmed incidents were raised in this period.");
    lines.push("");
  }

  lines.push(
    "Supporting evidence stays in the Nocturne console. This message contains no leaked material.",
  );
  const base = process.env.NOCTURNE_CONSOLE_URL?.trim().replace(/\/$/, "");
  if (base) lines.push(`Open the console: ${base}`);
  return lines.join("\n");
}

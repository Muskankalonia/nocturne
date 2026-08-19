import type { LeakType, SeverityBand } from "@/types";
import type {
  ReportIncident,
  ReportPeriod,
  ReportSummary,
  ReportWindow,
} from "@/types/triage";

/**
 * Report windows and the roll-up every report shares.
 *
 * Both the CSV and the PDF are built from the same `ReportPayload`, so the two
 * can never disagree about what "last 7 days" contained — which is the sort of
 * discrepancy that destroys trust in an evidence artifact the first time
 * somebody reconciles them.
 */

const WINDOW_HOURS: Record<ReportWindow, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
  "90d": 24 * 90,
};

const WINDOW_LABELS: Record<ReportWindow, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

export const REPORT_WINDOWS = Object.keys(WINDOW_HOURS) as ReportWindow[];

export function isReportWindow(value: string): value is ReportWindow {
  return value in WINDOW_HOURS;
}

export function resolvePeriod(window: ReportWindow, now = new Date()): ReportPeriod {
  const endsAt = new Date(now);
  const startsAt = new Date(endsAt.getTime() - WINDOW_HOURS[window] * 3_600_000);
  return {
    window,
    label: WINDOW_LABELS[window],
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

/**
 * The trailing seven days ending at the most recent midnight UTC.
 *
 * A weekly report has to be reproducible: running it twice on the same day must
 * describe the same week, which a rolling "now minus 168 hours" does not. This
 * snaps to a day boundary so Monday's report and its re-run agree.
 */
export function resolveWeeklyPeriod(now = new Date()): ReportPeriod {
  const endsAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const startsAt = new Date(endsAt.getTime() - 7 * 24 * 3_600_000);
  return {
    window: "7d",
    label: "Weekly report",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

const BANDS: SeverityBand[] = ["critical", "high", "medium", "low", "informational"];

export function summarizeIncidents(incidents: ReportIncident[]): ReportSummary {
  const byBand = Object.fromEntries(
    BANDS.map((band) => [band, 0]),
  ) as Record<SeverityBand, number>;

  const actors = new Set<string>();
  const dataClasses = new Set<LeakType>();
  let recordsClaimed = 0;
  let mitigatedCount = 0;

  for (const incident of incidents) {
    if (incident.impactSeverityBand) byBand[incident.impactSeverityBand] += 1;
    if (incident.actorName) actors.add(incident.actorName);
    for (const leakType of incident.leakTypes) dataClasses.add(leakType);
    recordsClaimed += incident.quantityClaimed ?? 0;
    if (incident.remediationStatus === "mitigated") mitigatedCount += 1;
  }

  return {
    totalIncidents: incidents.length,
    byBand,
    mitigatedCount,
    openCount: incidents.length - mitigatedCount,
    recordsClaimed,
    distinctActors: actors.size,
    exposedDataClasses: [...dataClasses],
    // Already ordered by impact severity descending by the query, so the first
    // row is the worst one. Recomputing here would risk the two disagreeing.
    topIncident: incidents[0] ?? null,
  };
}

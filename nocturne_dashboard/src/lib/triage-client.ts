import type {
  IncidentActionState,
  MitigationResponse,
  PageScreenshot,
  ReportFormat,
  ReportWindow,
  ReviewDecision,
  SocDispatchResponse,
} from "@/types/triage";

/**
 * Browser-side calls to the triage endpoints.
 *
 * Everything here posts `orgId` explicitly. At fleet scope a super admin has no
 * implicit organization, so the server requires one — and it checks the value
 * against the session rather than trusting it, which is why sending it is safe
 * and omitting it is not.
 */

export interface ChannelAvailability {
  email: boolean;
  jira: boolean;
  slack: boolean;
}

export class TriageRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
  }
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed with ${response.status}.`;
    throw new TriageRequestError(message, response.status, body);
  }
  return body as T;
}

export function fetchActionState(
  incidentKey: string,
  orgId: string,
): Promise<{ state: IncidentActionState; channels: ChannelAvailability }> {
  return send(
    `/api/incidents/${encodeURIComponent(incidentKey)}/actions?orgId=${encodeURIComponent(orgId)}`,
  );
}

export function markMitigated(
  incidentKey: string,
  orgId: string,
  note?: string,
): Promise<MitigationResponse> {
  return send(`/api/incidents/${encodeURIComponent(incidentKey)}/mitigate`, {
    method: "POST",
    body: JSON.stringify({ orgId, note: note ?? null }),
  });
}

export function unmarkMitigated(
  incidentKey: string,
  orgId: string,
): Promise<MitigationResponse> {
  return send(
    `/api/incidents/${encodeURIComponent(incidentKey)}/mitigate?orgId=${encodeURIComponent(orgId)}`,
    { method: "DELETE" },
  );
}

export function dispatchSocAlert(
  incidentKey: string,
  orgId: string,
  force = false,
): Promise<SocDispatchResponse> {
  return send(`/api/incidents/${encodeURIComponent(incidentKey)}/dispatch`, {
    method: "POST",
    body: JSON.stringify({ orgId, force }),
  });
}

export function fetchScreenshot(
  monitorKey: string,
  orgId: string,
): Promise<{ screenshot: PageScreenshot | null }> {
  return send(
    `/api/screenshots?monitorKey=${encodeURIComponent(monitorKey)}&orgId=${encodeURIComponent(orgId)}`,
  );
}

export function requestScreenshot(
  monitorKey: string,
  orgId: string,
  refresh = false,
): Promise<{ screenshot: PageScreenshot | null }> {
  return send("/api/screenshots", {
    method: "POST",
    body: JSON.stringify({ monitorKey, orgId, refresh }),
  });
}

export function submitReviewDecision(
  monitorKey: string,
  orgId: string,
  decision: ReviewDecision,
  note?: string,
): Promise<unknown> {
  return send("/api/incidents/review", {
    method: "POST",
    body: JSON.stringify({ monitorKey, orgId, decision, note: note ?? null }),
  });
}

export function withdrawReviewDecision(
  monitorKey: string,
  orgId: string,
): Promise<unknown> {
  return send(
    `/api/incidents/review?monitorKey=${encodeURIComponent(monitorKey)}&orgId=${encodeURIComponent(orgId)}`,
    { method: "DELETE" },
  );
}

/**
 * Report downloads are plain navigations, not fetches.
 *
 * The response is a file with a Content-Disposition header, and letting the
 * browser handle it gives a real download — including the progress indicator
 * and the resume behaviour — instead of buffering a PDF in a tab's memory to
 * hand back to the same browser through an object URL.
 */
export function evidenceReportUrl(
  window: ReportWindow,
  format: ReportFormat,
  orgId: string | null,
): string {
  const params = new URLSearchParams({ window, format });
  if (orgId) params.set("orgId", orgId);
  return `/api/reports/evidence?${params.toString()}`;
}

export function weeklyReportUrl(orgId: string | null): string {
  const params = new URLSearchParams();
  if (orgId) params.set("orgId", orgId);
  const query = params.toString();
  return `/api/reports/weekly${query ? `?${query}` : ""}`;
}

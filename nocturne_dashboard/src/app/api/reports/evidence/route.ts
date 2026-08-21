import { NextResponse } from "next/server";

import { buildReportPayload } from "@/server/reports/build";
import { csvFilename, renderIncidentsCsv } from "@/server/reports/csv";
import { isReportWindow, resolvePeriod } from "@/server/reports/period";
import { pdfFilename, renderReportPdf } from "@/server/reports/pdf";
import {
  API_RESPONSE_HEADERS,
  ORG_ID_PATTERN,
  authenticateRequest,
  badRequest,
  serviceUnavailable,
} from "@/server/route-auth";
import { recordAction, recordReportRun } from "@/server/triage-actions";
import type { DataScope } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Evidence export over a timeframe: a PDF summary or a CSV of the incidents.
 *
 * GET rather than POST because the response *is* the artifact, and a browser
 * downloading a file from a link is a much better experience than one
 * assembling a blob from a fetch. It mutates nothing; the audit row it writes
 * is a record of a read, which is the point of an evidence export.
 *
 *   /api/reports/evidence?window=7d&format=pdf[&orgId=…]
 */
export async function GET(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const window = params.get("window") ?? "7d";
  const format = params.get("format") ?? "pdf";

  if (!isReportWindow(window)) {
    return badRequest("window must be one of 24h, 7d, 30d, 90d.");
  }
  if (format !== "pdf" && format !== "csv") {
    return badRequest("format must be pdf or csv.");
  }

  // Narrowing only. A super admin may scope the export to one tenant; an
  // ORG_USER's scope is their session's and a mismatched orgId is refused
  // rather than quietly ignored.
  let scope: DataScope = auth.caller.scope;
  const requestedOrgId = params.get("orgId");
  if (requestedOrgId) {
    if (!ORG_ID_PATTERN.test(requestedOrgId)) {
      return badRequest("The requested organization identifier is invalid.");
    }
    if (
      auth.caller.user.role !== "SUPER_ADMIN"
      && auth.caller.user.orgId !== requestedOrgId
    ) {
      return NextResponse.json(
        { error: "You can only export your own organization." },
        { status: 403, headers: API_RESPONSE_HEADERS },
      );
    }
    scope = { kind: "org", orgId: requestedOrgId };
  }

  try {
    const period = resolvePeriod(window);
    const payload = await buildReportPayload({
      scope,
      period,
      generatedBy: auth.caller.username,
    });

    const orgId = scope.kind === "org" ? scope.orgId : null;
    await recordReportRun({
      orgId,
      kind: format === "pdf" ? "evidence_pdf" : "evidence_csv",
      period,
      incidentCount: payload.summary.totalIncidents,
      delivery: "download",
      recipients: [],
      generatedBy: auth.caller.username,
    });
    await recordAction({
      // Fleet exports have no single organization; attribute them to the
      // caller's own row so the audit view's join still finds a name.
      orgId: orgId ?? auth.caller.user.orgId ?? "admin",
      action: "export_evidence",
      actor: auth.caller.username,
      outcome: "success",
      summary: `Exported ${payload.summary.totalIncidents} incident(s) as ${format.toUpperCase()} · ${period.label}`,
      detail: { window, format, scope: payload.scopeLabel },
    });

    if (format === "csv") {
      const csv = renderIncidentsCsv(payload);
      return new NextResponse(csv, {
        headers: {
          ...API_RESPONSE_HEADERS,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${csvFilename(payload)}"`,
        },
      });
    }

    const pdf = await renderReportPdf(payload, { kind: "evidence" });
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        ...API_RESPONSE_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdfFilename(payload, "evidence")}"`,
      },
    });
  } catch (error) {
    return serviceUnavailable(
      "nocturne-evidence-report",
      `${format} export`,
      error,
      "Generating the evidence report failed.",
    );
  }
}

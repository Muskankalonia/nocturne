import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { isMailConfigured, queueReportEmail } from "@/server/alert-mailer";
import { buildReportPayload, renderReportText, scopeLabel } from "@/server/reports/build";
import { renderReportHtml } from "@/server/reports/html";
import { resolveWeeklyPeriod } from "@/server/reports/period";
import { pdfFilename, renderReportPdf } from "@/server/reports/pdf";
import {
  API_RESPONSE_HEADERS,
  ORG_ID_PATTERN,
  authenticateRequest,
  badRequest,
  serviceUnavailable,
} from "@/server/route-auth";
import {
  listWeeklyDigestRecipients,
  recordAction,
  recordReportRun,
} from "@/server/triage-actions";
import type { DataScope } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The weekly report, in both the shapes the requirement asks for.
 *
 *   GET  — download it now, as the signed-in user, for their own scope.
 *   POST — the scheduled send. Machine-to-machine, bearer token, mails every
 *          user who has the weekly digest switched on in their profile.
 *
 * Both render the same payload from `resolveWeeklyPeriod`, which snaps to a UTC
 * midnight boundary. A downloaded report and the emailed one for the same week
 * are therefore the same document, which is the entire reason anyone trusts a
 * recurring report.
 */

export async function GET(request: Request) {
  const auth = await authenticateRequest();
  if (!auth.ok) return auth.response;

  let scope: DataScope = auth.caller.scope;
  const requestedOrgId = new URL(request.url).searchParams.get("orgId");
  if (requestedOrgId) {
    if (!ORG_ID_PATTERN.test(requestedOrgId)) {
      return badRequest("The requested organization identifier is invalid.");
    }
    if (
      auth.caller.user.role !== "SUPER_ADMIN"
      && auth.caller.user.orgId !== requestedOrgId
    ) {
      return NextResponse.json(
        { error: "You can only download your own organization's report." },
        { status: 403, headers: API_RESPONSE_HEADERS },
      );
    }
    scope = { kind: "org", orgId: requestedOrgId };
  }

  try {
    const period = resolveWeeklyPeriod();
    const payload = await buildReportPayload({
      scope,
      period,
      generatedBy: auth.caller.username,
    });
    const pdf = await renderReportPdf(payload, { kind: "weekly" });

    await recordReportRun({
      orgId: scope.kind === "org" ? scope.orgId : null,
      kind: "weekly_pdf",
      period,
      incidentCount: payload.summary.totalIncidents,
      delivery: "download",
      recipients: [],
      generatedBy: auth.caller.username,
    });

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        ...API_RESPONSE_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${pdfFilename(payload, "weekly")}"`,
      },
    });
  } catch (error) {
    return serviceUnavailable(
      "nocturne-weekly-report",
      "download",
      error,
      "Generating the weekly report failed.",
    );
  }
}

/**
 * Scheduled send. Shares NOCTURNE_ALERT_DISPATCH_TOKEN with the alert sweep:
 * both are the same trust relationship — Cloud Scheduler calling the console —
 * and a second secret to rotate buys nothing.
 */
function isMachineAuthorized(request: Request): boolean {
  const expected = process.env.NOCTURNE_ALERT_DISPATCH_TOKEN?.trim();
  if (!expected || expected.length < 24) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!isMachineAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isMailConfigured()) {
    return NextResponse.json(
      { error: "Email delivery is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";
  const period = resolveWeeklyPeriod();

  try {
    const recipients = await listWeeklyDigestRecipients();
    const sent: string[] = [];
    const errors: string[] = [];

    // Grouped by scope so a fleet admin and three tenants cost four renders,
    // not one per recipient. Chromium is the expensive part of this route.
    const groups = new Map<string, typeof recipients>();
    for (const recipient of recipients) {
      const key = recipient.orgId ?? "__fleet__";
      groups.set(key, [...(groups.get(key) ?? []), recipient]);
    }

    for (const [key, members] of groups) {
      const scope: DataScope =
        key === "__fleet__" ? { kind: "fleet" } : { kind: "org", orgId: key };
      try {
        const payload = await buildReportPayload({
          scope,
          period,
          generatedBy: "Nocturne scheduled report",
        });
        const addresses = members.map((member) => member.email);
        if (dryRun) {
          sent.push(...addresses.map((address) => `${address} (dry run)`));
          continue;
        }

        const pdf = await renderReportPdf(payload, { kind: "weekly" });
        await queueReportEmail({
          to: addresses,
          subject: `[Nocturne] Weekly report — ${scopeLabel(scope)} — week to ${period.endsAt.slice(0, 10)}`,
          html: renderReportHtml(payload, { kind: "weekly" }),
          text: renderReportText(payload),
          attachment: { filename: pdfFilename(payload, "weekly"), content: pdf },
          meta: { kind: "weekly_report", scope: key, periodEnd: period.endsAt },
        });

        await recordReportRun({
          orgId: scope.kind === "org" ? scope.orgId : null,
          kind: "weekly_pdf",
          period,
          incidentCount: payload.summary.totalIncidents,
          delivery: "email",
          recipients: addresses,
          generatedBy: "scheduler",
        });
        await recordAction({
          orgId: scope.kind === "org" ? scope.orgId : "admin",
          action: "generate_weekly_report",
          actor: "scheduler",
          outcome: "success",
          summary: `Weekly report emailed to ${addresses.length} recipient(s)`,
          detail: { periodEnd: period.endsAt },
        });
        sent.push(...addresses);
      } catch (error) {
        errors.push(
          `${key}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }

    return NextResponse.json(
      { period, groups: groups.size, sent, errors },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return serviceUnavailable(
      "nocturne-weekly-report",
      "scheduled send",
      error,
      "The weekly report send failed.",
    );
  }
}

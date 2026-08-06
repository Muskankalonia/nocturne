import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { isMailConfigured, queueAlertEmail } from "@/server/alert-mailer";
import { claimAlertDelivery, findPendingAlerts } from "@/server/nocturne-backend";
import type { AlertDispatchResult } from "@/types/dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = { "Cache-Control": "no-store" };

/**
 * How far back a run will look. Bounds the cold-start case: with an empty
 * deliveries table every historical incident would otherwise qualify and a
 * first run would mail years of history in one burst.
 */
const DEFAULT_LOOKBACK_HOURS = 48;
const MAX_LOOKBACK_HOURS = 24 * 30;

/** Hard ceiling per run, so one sweep cannot empty a mail quota. */
const MAX_PER_RUN = 200;

/**
 * Machine-to-machine auth: this endpoint is called by Cloud Scheduler and by
 * the pipeline, never by a browser, so it takes a bearer token rather than a
 * session cookie. Compared in constant time — a fast rejection on the first
 * wrong byte would leak the prefix to anyone willing to time it.
 */
function isAuthorized(request: Request): boolean {
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

function parseLookback(request: Request): number {
  const raw = new URL(request.url).searchParams.get("lookbackHours");
  if (!raw) return DEFAULT_LOOKBACK_HOURS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LOOKBACK_HOURS;
  return Math.min(parsed, MAX_LOOKBACK_HOURS);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401, headers: RESPONSE_HEADERS },
    );
  }

  if (!isMailConfigured()) {
    return NextResponse.json(
      {
        error:
          "Email delivery is not configured. Set FIREBASE_PROJECT_ID (or run on Google infrastructure) and install the Trigger Email extension.",
      },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }

  // `dryRun` reports what would be sent without claiming or queueing anything,
  // which is the only safe way to point this at production the first time.
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "true";
  const result: AlertDispatchResult = { scanned: 0, queued: 0, skipped: 0, errors: [] };

  try {
    const pending = await findPendingAlerts(parseLookback(request));
    result.scanned = pending.length;

    for (const alert of pending.slice(0, MAX_PER_RUN)) {
      if (dryRun) {
        result.skipped += 1;
        continue;
      }

      // Claim first: losing the race means another dispatcher already owns this
      // one, so skipping is correct rather than an error.
      let claimed = false;
      try {
        claimed = await claimAlertDelivery(alert);
      } catch (claimError) {
        result.errors.push(
          `claim ${alert.incidentKey}/${alert.username}: ${
            claimError instanceof Error ? claimError.message : "unknown error"
          }`,
        );
        continue;
      }
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      try {
        await queueAlertEmail(alert);
        result.queued += 1;
      } catch (queueError) {
        // The claim stands. This alert will not be retried automatically, which
        // is the deliberate trade: a missed alert is recoverable by a human, a
        // duplicate "you have been breached" email is not.
        result.errors.push(
          `queue ${alert.incidentKey}/${alert.username}: ${
            queueError instanceof Error ? queueError.message : "unknown error"
          }`,
        );
      }
    }

    if (pending.length > MAX_PER_RUN) {
      result.errors.push(
        `${pending.length - MAX_PER_RUN} alerts deferred to the next run (per-run cap ${MAX_PER_RUN}).`,
      );
    }

    return NextResponse.json(result, { headers: RESPONSE_HEADERS });
  } catch (error) {
    console.error(
      "[nocturne-alert-dispatch] failed:",
      error instanceof Error ? error.message : "unknown server error",
    );
    return NextResponse.json(
      { error: "Alert dispatch failed." },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}

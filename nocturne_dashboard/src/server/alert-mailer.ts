import { cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

import { severityColor } from "@/theme/tokens";
import type { PendingAlert } from "@/types/dashboard";

if (typeof window !== "undefined") {
  throw new Error("Nocturne alert mail may only be queued on the server.");
}

/**
 * Breach alert delivery via the Firebase "Trigger Email from Firestore"
 * extension.
 *
 * Nothing here talks SMTP. The contract is a document written to a collection
 * the extension watches; the extension owns the connection, retries, and the
 * delivery state it writes back onto the same document. That means a transient
 * SMTP failure is invisible to this process and is retried without a duplicate
 * incident record on our side.
 *
 * Document shape is the extension's, not ours:
 *   { to: string[], message: { subject, text, html } }
 */

/** Collection the extension watches. Configurable: the install prompt asks. */
const MAIL_COLLECTION = process.env.FIREBASE_MAIL_COLLECTION?.trim() || "mail";

let firestore: FirebaseFirestore.Firestore | null = null;

function projectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID?.trim()
    || process.env.GOOGLE_CLOUD_PROJECT?.trim()
    || process.env.GCLOUD_PROJECT?.trim()
    || undefined
  );
}

/**
 * On Cloud Run the runtime service account is picked up automatically, so no
 * key material is needed or wanted. A JSON service-account key is only read
 * when explicitly supplied, for local runs outside Google infrastructure.
 */
function db(): FirebaseFirestore.Firestore {
  if (firestore) return firestore;

  if (!getApps().length) {
    const inlineKey = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
    initializeApp(
      inlineKey
        ? { credential: cert(JSON.parse(inlineKey)), projectId: projectId() }
        : { credential: applicationDefault(), projectId: projectId() },
    );
  }
  firestore = getFirestore();
  return firestore;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function consoleUrl(alert: PendingAlert): string {
  const base = process.env.NOCTURNE_CONSOLE_URL?.trim().replace(/\/$/, "") ?? "";
  return `${base}/leaks/${encodeURIComponent(alert.incidentKey)}`;
}

/**
 * The email deliberately carries no leaked material — not the quote, not the
 * record count. Mail is the least controlled channel this data could travel
 * through; the alert says a confirmed breach exists and sends the reader to the
 * console, where access is actually enforced.
 */
export function renderAlertEmail(alert: PendingAlert): {
  subject: string;
  text: string;
  html: string;
} {
  const band = alert.severityBand.toUpperCase();
  const score = alert.severityScore === null ? "—" : String(alert.severityScore);
  const link = consoleUrl(alert);
  const accent = severityColor[alert.severityBand] ?? severityColor.informational;

  const subject = `[Nocturne · ${band}] Confirmed breach for ${alert.organizationName}`;

  const text = [
    `A confirmed breach was detected for ${alert.organizationName}.`,
    "",
    `Severity: ${band} (impact ${score})`,
    `Incident: ${alert.title}`,
    alert.firstSeen ? `First seen: ${alert.firstSeen}` : null,
    "",
    `Open in Nocturne: ${link}`,
    "",
    "Evidence and the source page are available in the console. This message",
    "intentionally contains no leaked data.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const html = `
<div style="background:#04070E;padding:28px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#E8EEFA">
  <div style="max-width:560px;margin:0 auto;background:#0A1120;border:1px solid rgba(104,146,224,0.2);border-radius:10px;overflow:hidden">
    <div style="height:3px;background:${accent}"></div>
    <div style="padding:24px">
      <div style="font-size:11px;letter-spacing:0.14em;color:${accent};font-weight:600">
        ${escapeHtml(band)} · CONFIRMED BREACH
      </div>
      <h1 style="margin:12px 0 4px;font-size:19px;line-height:1.35;color:#E8EEFA">
        ${escapeHtml(alert.title)}
      </h1>
      <p style="margin:0 0 18px;font-size:13px;color:#9BADC9">
        ${escapeHtml(alert.organizationName)} · impact ${escapeHtml(score)}${
          alert.firstSeen ? ` · first seen ${escapeHtml(alert.firstSeen.slice(0, 10))}` : ""
        }
      </p>
      <a href="${escapeHtml(link)}"
         style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;
                padding:10px 18px;border-radius:6px;font-size:13px;font-weight:600">
        Open in Nocturne
      </a>
      <p style="margin:20px 0 0;font-size:11px;color:#61748F;line-height:1.6">
        Evidence and the source page are in the console. This message intentionally
        contains no leaked data. You are receiving it because ${escapeHtml(band)}
        alerts are enabled on your profile.
      </p>
    </div>
  </div>
</div>`.trim();

  return { subject, text, html };
}

/**
 * Queues one alert. Resolves once Firestore has the document — the extension
 * takes it from there, so a slow SMTP host never blocks the dispatch loop.
 */
export async function queueAlertEmail(alert: PendingAlert): Promise<void> {
  const { subject, text, html } = renderAlertEmail(alert);
  await db()
    .collection(MAIL_COLLECTION)
    .add({
      to: [alert.email],
      message: { subject, text, html },
      // Not read by the extension; this is our own trail for reconciling a
      // Firestore document back to the incident that produced it.
      nocturne: {
        incidentKey: alert.incidentKey,
        orgId: alert.orgId,
        username: alert.username,
        severityBand: alert.severityBand,
        queuedAt: new Date().toISOString(),
      },
    });
}

/** True when enough is configured for a queue attempt to be worth making. */
export function isMailConfigured(): boolean {
  return Boolean(
    projectId() || process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim(),
  );
}

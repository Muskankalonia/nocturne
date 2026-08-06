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

const LEAK_TYPE_LABELS: Record<string, string> = {
  credential: "Credentials",
  corporate_data: "Corporate data",
  pii: "Personal data",
  financial: "Financial data",
  malware_exploit: "Malware / exploit",
};

function leakLabel(value: string): string {
  return LEAK_TYPE_LABELS[value] ?? value.replace(/_/g, " ");
}

/**
 * The email carries the classification and the model's own summary, but never
 * a verbatim excerpt from the source page. Mail is the least controlled channel
 * this data could travel through: an analyst gets enough to judge urgency
 * without the leaked material itself following them into an inbox, a phone
 * lock screen, or a mail provider's index. Evidence stays behind the console,
 * where access is actually enforced.
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
  const headline = alert.insightHeadline?.trim() || alert.title;
  const classes = alert.leakTypes.map(leakLabel);
  const records =
    alert.quantityClaimed === null ? null : alert.quantityClaimed.toLocaleString();
  const seen = alert.firstSeen ? alert.firstSeen.slice(0, 10) : null;
  const sourceHost = (() => {
    try {
      return new URL(alert.sourceUrl).host;
    } catch {
      return null;
    }
  })();

  const subject = `[Nocturne · ${band}] ${alert.organizationName}: ${headline.slice(0, 90)}`;

  const facts: Array<[string, string]> = [
    ["Organization", alert.organizationName],
    ["Impact severity", `${score} (${band.toLowerCase()})`],
  ];
  if (alert.evidenceConfidenceScore !== null) {
    facts.push(["Evidence confidence", String(alert.evidenceConfidenceScore)]);
  }
  if (alert.triagePriorityScore !== null) {
    facts.push(["Triage priority", String(alert.triagePriorityScore)]);
  }
  if (classes.length) facts.push(["Exposed data", classes.join(", ")]);
  if (records) facts.push(["Records claimed", `${records} (seller's claim)`]);
  if (alert.actorName) facts.push(["Attributed actor", alert.actorName]);
  if (sourceHost) facts.push(["Source", sourceHost]);
  if (seen) facts.push(["First seen", seen]);

  const actions = alert.recommendedActions.slice(0, 4);

  const text = [
    `${band} — confirmed breach for ${alert.organizationName}`,
    "",
    headline,
    "",
    alert.executiveSummary?.trim() ?? "",
    "",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    "",
    ...(actions.length ? ["Recommended actions:", ...actions.map((a) => `  - ${a}`), ""] : []),
    `Open in Nocturne: ${link}`,
    "",
    "Supporting evidence and the source page are in the console. This message",
    "intentionally contains no verbatim leaked material.",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const factRows = facts
    .map(
      ([k, v]) => `
        <tr>
          <td style="padding:6px 0;font-size:12px;color:#61748F;white-space:nowrap;width:150px">${escapeHtml(k)}</td>
          <td style="padding:6px 0;font-size:13px;color:#E8EEFA">${escapeHtml(v)}</td>
        </tr>`,
    )
    .join("");

  const actionList = actions.length
    ? `
      <div style="margin:22px 0 0">
        <div style="font-size:11px;letter-spacing:0.12em;color:#61748F;font-weight:600;margin-bottom:8px">
          RECOMMENDED ACTIONS
        </div>
        <ul style="margin:0;padding-left:18px;font-size:13px;color:#C7D4E8;line-height:1.7">
          ${actions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}
        </ul>
      </div>`
    : "";

  const summary = alert.executiveSummary?.trim()
    ? `<p style="margin:0 0 20px;font-size:13.5px;line-height:1.65;color:#C7D4E8">
         ${escapeHtml(alert.executiveSummary.trim())}
       </p>`
    : "";

  const html = `
<div style="background:#04070E;padding:28px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#E8EEFA">
  <div style="max-width:620px;margin:0 auto;background:#0A1120;border:1px solid rgba(104,146,224,0.2);border-radius:10px;overflow:hidden">
    <div style="height:3px;background:${accent}"></div>
    <div style="padding:26px">
      <div style="font-size:11px;letter-spacing:0.14em;color:${accent};font-weight:600">
        ${escapeHtml(band)} · CONFIRMED BREACH
      </div>
      <h1 style="margin:12px 0 6px;font-size:20px;line-height:1.35;color:#E8EEFA">
        ${escapeHtml(headline)}
      </h1>
      <p style="margin:0 0 20px;font-size:12px;color:#61748F">
        ${escapeHtml(alert.title)}
      </p>

      ${summary}

      <table style="width:100%;border-collapse:collapse;border-top:1px solid rgba(104,146,224,0.15);border-bottom:1px solid rgba(104,146,224,0.15)">
        ${factRows}
      </table>

      ${actionList}

      <div style="margin:26px 0 0">
        <a href="${escapeHtml(link)}"
           style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;
                  padding:11px 20px;border-radius:6px;font-size:13px;font-weight:600">
          Open incident in Nocturne
        </a>
      </div>

      <p style="margin:22px 0 0;font-size:11px;color:#61748F;line-height:1.65">
        Every claim above was verified verbatim against the crawled source before this
        alert was raised; ungrounded model output is quarantined and never scored.
        Supporting evidence stays in the console — this message intentionally contains
        no leaked material. You are receiving it because ${escapeHtml(band.toLowerCase())}
        alerts are enabled on your Nocturne profile.
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

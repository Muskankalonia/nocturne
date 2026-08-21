import type { Browser } from "puppeteer";

import { renderReportHtml, type ReportRenderOptions } from "@/server/reports/html";
import type { ReportPayload } from "@/types/triage";

if (typeof window !== "undefined") {
  throw new Error("Nocturne PDF rendering may only run on the server.");
}

/**
 * HTML → PDF via headless Chromium.
 *
 * The browser is launched once and reused. A cold launch is roughly a second,
 * which is most of the latency of a small report, and a report screen where a
 * user tries three windows in a row would otherwise pay it three times.
 *
 * The page loaded is a data: URL built in this process. It never navigates,
 * fetches, or runs script that did not come from `renderReportHtml`, so the
 * usual headless-browser exposure — being pointed at a hostile page — does not
 * apply here. The screenshot worker, which genuinely does visit hostile pages,
 * is deliberately a separate process on the Python side with Tor in front of it.
 */

let browserPromise: Promise<Browser> | null = null;

/**
 * Puppeteer's own Chromium by default; `PUPPETEER_EXECUTABLE_PATH` when the
 * image ships a system Chromium instead, which is how the Cloud Run image stays
 * small enough to be worth deploying.
 */
async function launch(): Promise<Browser> {
  const puppeteer = (await import("puppeteer")).default;
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      // Required in most container runtimes, which do not grant the user
      // namespaces Chromium's sandbox needs. Acceptable only because the sole
      // content this browser ever loads is generated in-process, above.
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // /dev/shm is 64 MB in many containers, and Chromium crashes on a long
      // report when it fills. Backing shared memory with /tmp avoids it.
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none",
    ],
  });
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.connected) return existing;
    } catch {
      // Fall through and relaunch. A browser that died mid-render leaves the
      // promise resolved but the process gone.
    }
    browserPromise = null;
  }
  browserPromise = launch().catch((error: unknown) => {
    browserPromise = null;
    throw error;
  });
  return browserPromise;
}

export async function renderReportPdf(
  payload: ReportPayload,
  options: ReportRenderOptions,
): Promise<Buffer> {
  const html = renderReportHtml(payload, options);
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    // Chromium drops backgrounds when printing unless emulation is forced to
    // screen — without this the dark report prints as black text on white.
    await page.emulateMediaType("screen");
    const pdf = await page.pdf({
      format: "a4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: `
        <div style="width:100%;font-size:7px;color:#61748F;padding:0 12mm;
                    font-family:-apple-system,Segoe UI,Roboto,sans-serif;
                    display:flex;justify-content:space-between">
          <span>Nocturne · confidential</span>
          <span class="pageNumber"></span>/<span class="totalPages"></span>
        </div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close().catch(() => undefined);
  }
}

export function pdfFilename(payload: ReportPayload, kind: "evidence" | "weekly"): string {
  const stamp = payload.generatedAt.slice(0, 10);
  const scope = payload.scopeLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `nocturne-${kind}-${scope}-${payload.period.window}-${stamp}.pdf`;
}

/** True when a PDF render can be attempted at all. */
export function isPdfRenderingAvailable(): boolean {
  try {
    require.resolve("puppeteer");
    return true;
  } catch {
    return false;
  }
}

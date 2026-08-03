/*
 * Real click-through of the Nocturne Console.
 *
 *   node scripts/clicktest.cjs
 *   BASE=http://localhost:3000 node scripts/clicktest.cjs
 *
 * Assertions are case-insensitive on purpose: several labels render through
 * CSS `text-transform: uppercase`, and innerText reflects that — a case-
 * sensitive check produces false failures.
 */
const puppeteer = require("puppeteer");
const BASE = process.env.BASE || "http://localhost:3113";

const results = [];
const log = (name, ok, detail = "") =>
  results.push({ name, ok, detail: String(detail).slice(0, 200) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyText = (page) => page.evaluate(() => document.body.innerText);

/**
 * Wait for an AG Grid to actually have rows.
 *
 * Fixed sleeps were fine when these pages rendered from mocks. /leaks now waits
 * on a live Snowflake round trip that takes ~9s at fleet scope on a cold
 * warehouse, so a 1.6s sleep asserted against an empty grid and reported a
 * working feature as broken.
 */
const waitForGrid = (page, timeout = 30000) =>
  page
    .waitForFunction(
      () => document.querySelectorAll(".ag-center-cols-container .ag-row").length > 0,
      { timeout, polling: 250 },
    )
    .then(() => true)
    .catch(() => false);

async function login(page, user) {
  // Sessions are a signed HttpOnly cookie, so clearing localStorage does not
  // sign anyone out — /login would just bounce an authenticated user straight
  // back to the dashboard and leave no form to fill in.
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.evaluate(() =>
    fetch("/api/auth/session", { method: "DELETE", credentials: "same-origin" }).catch(() => {}),
  );
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector('button[type="submit"]', { timeout: 15000 });
  const inputs = await page.$$("input");
  if (inputs.length < 2) throw new Error("login form did not render — still authenticated?");
  await inputs[0].click({ clickCount: 3 });
  await inputs[0].type(user);
  await inputs[1].click({ clickCount: 3 });
  await inputs[1].type(user);
  await Promise.all([
    page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
  await sleep(900);
  return page.url();
}

/** Sweep the canvas until a node or edge opens the inspector. */
async function clickGraphElement(page) {
  const r = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return { left: b.left, top: b.top, w: b.width, h: b.height };
  });
  if (!r) return false;
  for (let gx = 0.1; gx <= 0.9; gx += 0.05) {
    for (let gy = 0.1; gy <= 0.9; gy += 0.05) {
      await page.mouse.click(r.left + r.w * gx, r.top + r.h * gy);
      await sleep(60);
      if (/selected node|selected edge/i.test(await bodyText(page))) return true;
    }
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  try {
    /* 1 — admin login */
    log("admin login lands on fleet", (await login(page, "admin")).includes("/admin/fleet"));

    /* 2 — organizations enable/disable toggle */
    await page.goto(`${BASE}/admin/organizations`, { waitUntil: "networkidle2" });
    await sleep(1600);
    // Target the monitoring Switch specifically — row-selection checkboxes
    // live in the same container and would otherwise match first.
    const SWITCH = 'input[aria-label^="Monitoring for"]';
    const sw = await page.$(SWITCH);
    if (!sw) {
      log("org toggle flips", false, "no switch found");
    } else {
      const label = await page.evaluate((el) => el.getAttribute("aria-label"), sw);
      const was = await page.evaluate((el) => el.checked, sw);
      await sw.click();
      await sleep(700);
      // The grid may redraw the row, so count checked switches rather than
      // re-querying one element by label.
      const checkedNow = await page.evaluate(
        (sel) => [...document.querySelectorAll(sel)].filter((n) => n.checked).length,
        SWITCH,
      );
      log(
        "org toggle flips",
        was ? checkedNow === 3 : checkedNow === 5,
        `${label}: was=${was}, now ${checkedNow}/5 enabled`,
      );
      log("org toggle confirms with a toast", /monitoring (enabled|paused)/i.test(await bodyText(page)));
    }

    /* 3 — grid checkboxes + quick filter */
    await page.goto(`${BASE}/leaks`, { waitUntil: "networkidle2" });
    await waitForGrid(page);
    const boxes = await page.$$(".ag-selection-checkbox, .ag-header-select-all");
    log("grid has selection checkboxes", boxes.length > 0, `${boxes.length} found`);

    const filterBox = await page.$('input[aria-label="Filter rows"]');
    if (!filterBox) {
      log("grid quick filter narrows rows", false, "no filter input");
    } else {
      const rowsBefore = (await page.$$(".ag-center-cols-container .ag-row")).length;
      // Take the search term from the data on screen. Hard-coding "NightFox"
      // only worked against the mocks — the live seed's actor is different, so
      // the filter correctly matched nothing and the test blamed the feature.
      const term = await page.evaluate(() => {
        const row = document.querySelector(".ag-center-cols-container .ag-row");
        const words = (row?.innerText || "").split(/[\s,|]+/).filter((w) => /^[A-Za-z]{6,}$/.test(w));
        return words[words.length - 1] || "";
      });
      await filterBox.click();
      await filterBox.type(term || "zzzz");
      await sleep(900);
      const rowsAfter = (await page.$$(".ag-center-cols-container .ag-row")).length;
      log(
        "grid quick filter narrows rows",
        rowsAfter > 0 && rowsAfter < rowsBefore,
        `"${term}": ${rowsBefore} -> ${rowsAfter}`,
      );
    }

    /* 4 — row selection via checkbox */
    await page.goto(`${BASE}/leaks`, { waitUntil: "networkidle2" });
    await waitForGrid(page);
    // The checkbox column is pinned left, so it lives in the pinned container.
    const cb = await page.$(".ag-pinned-left-cols-container .ag-selection-checkbox");
    if (cb) {
      await cb.click();
      await sleep(600);
      log("checkbox selection shows a count", /\d+ selected/i.test(await bodyText(page)));
    } else {
      log("checkbox selection shows a count", false, "no row checkbox");
    }

    /* 5 — needs-review row opens an explanation */
    await page.goto(`${BASE}/leaks?status=ambiguous`, { waitUntil: "networkidle2" });
    await waitForGrid(page);
    const reviewRows = await page.$$(".ag-center-cols-container .ag-row");
    if (reviewRows.length) {
      const from = page.url();
      await reviewRows[0].click();
      await sleep(1500);
      log("needs-review row opens detail", page.url().includes("/leaks/") && page.url() !== from);
      log(
        "needs-review detail explains why",
        /not a confirmed incident|never proven|different organization/i.test(await bodyText(page)),
      );
    } else {
      log("needs-review row opens detail", false, "no ambiguous rows");
    }

    /* 6 — confirmed row opens scored detail */
    await page.goto(`${BASE}/leaks?status=confirmed`, { waitUntil: "networkidle2" });
    await waitForGrid(page);
    const rows2 = await page.$$(".ag-center-cols-container .ag-row");
    if (rows2.length) {
      await rows2[0].click();
      // Wait for the destination content, not for the absence of a loading
      // string: at the instant of the click the old grid is still mounted and
      // "not loading" is trivially true, so that check passed immediately and
      // then asserted against a page that had not rendered yet.
      await page
        .waitForFunction(() => /score decomposition/i.test(document.body.innerText), {
          timeout: 30000,
          polling: 250,
        })
        .catch(() => {});
      const t = await bodyText(page);
      log("confirmed row opens scored detail", /score decomposition/i.test(t));
      log("detail shows verbatim evidence", /verbatim evidence|evidence_start/i.test(t));
    }

    /* 7 — global search */
    await page.goto(`${BASE}/leaks`, { waitUntil: "networkidle2" });
    await waitForGrid(page);
    const search = await page.$('input[aria-label="Search"]');
    if (!search) {
      log("global search returns results", false, "no search input");
    } else {
      await search.click();
      await search.type("NightFox");
      await sleep(1000);
      log("global search returns results", /incident|actor/i.test(await bodyText(page)));
      const from = page.url();
      await page.keyboard.press("Enter");
      await sleep(1400);
      log("search result navigates", page.url() !== from, `-> ${page.url().slice(-16)}`);
    }

    /* 8 — knowledge graph */
    await page.goto(`${BASE}/graph`, { waitUntil: "networkidle2" });
    await sleep(3200);
    // G6 v5 renders in layers, so one graph legitimately creates several canvas
    // elements. What matters is that the count is stable, not that it is 1.
    const canvasCount = await page.evaluate(() => document.querySelectorAll("canvas").length);
    log("graph renders", canvasCount > 0, `${canvasCount} canvas layer(s)`);
    log("graph click opens inspector", await clickGraphElement(page));

    /* 9 — no canvas leak on revisit */
    await page.goto(`${BASE}/actors`, { waitUntil: "networkidle2" });
    await sleep(800);
    await page.goto(`${BASE}/graph`, { waitUntil: "networkidle2" });
    await sleep(2800);
    const after = await page.evaluate(() => document.querySelectorAll("canvas").length);
    log(
      "graph does not leak canvases on revisit",
      after === canvasCount,
      `${canvasCount} -> ${after}`,
    );

    /* 10 — actors grid */
    await page.goto(`${BASE}/actors`, { waitUntil: "networkidle2" });
    await sleep(1600);
    log("actors page uses a filterable grid", Boolean(await page.$('input[aria-label="Filter rows"]')));

    /* 11 — users grid */
    await page.goto(`${BASE}/admin/users`, { waitUntil: "networkidle2" });
    await sleep(1600);
    log("users page uses a filterable grid", Boolean(await page.$('input[aria-label="Filter rows"]')));

    /* 12 — org user restrictions */
    await login(page, "palo_alto_networks");
    await page.goto(`${BASE}/admin/fleet`, { waitUntil: "networkidle2" });
    await sleep(1000);
    log(
      "org user blocked from admin page",
      /restricted to fleet administrators/i.test(await bodyText(page)),
    );

    await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
    await sleep(1000);
    log("org user has no fleet nav", !/fleet command/i.test(await bodyText(page)));

    /* 13 — sign out */
    // The collapsed rail shows only an icon, so match the accessible name.
    const signOut = await page.$('[aria-label="Sign out"]');
    // Dispatch on the element rather than clicking its coordinates: in dev the
    // Next.js indicator portal sits over the bottom-left of the collapsed rail
    // and swallows the pointer event. Real users hit the same overlay, but it
    // does not exist in a production build.
    if (signOut) await signOut.evaluate((el) => el.click());
    // Sign-out now round-trips to DELETE /api/auth/session before the shell can
    // redirect, so wait for the destination instead of guessing at a delay.
    await page
      .waitForFunction(() => location.pathname.startsWith("/login"), {
        timeout: 15000,
        polling: 200,
      })
      .catch(() => {});
    await sleep(400);
    log("sign out returns to login", page.url().includes("/login"));
  } catch (err) {
    log("harness", false, err.message);
  }

  console.log("\n================ CLICK TEST ================");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  — " + r.detail : ""}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (pageErrors.length) {
    console.log("\n--- page errors ---");
    [...new Set(pageErrors)].slice(0, 6).forEach((e) => console.log("  " + e.slice(0, 180)));
  }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();

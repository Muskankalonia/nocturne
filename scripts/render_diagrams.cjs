#!/usr/bin/env node
/**
 * Render every ```mermaid block in architecture.md to a PNG in docs/architecture.
 *
 * Mermaid auto-layout fills the width it is given, so a narrow page is exactly
 * what produces a cramped, unreadable diagram — hence the wide viewport and 2x
 * device pixel ratio below.
 *
 *   node scripts/render_diagrams.cjs
 *
 * Requires puppeteer (already in nocturne_dashboard) and mermaid. If mermaid is
 * missing this prints the one command that installs it.
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const MD = path.join(ROOT, "architecture.md");
const OUTDIR = path.join(ROOT, "docs/architecture");

const NAMES = [
  "01-system-end-to-end",
  "02-cascade-filter",
  "03-grounding",
  "04-config-loop",
  "05-presentation-layer",
];

function resolveFrom(candidates, what, hint) {
  for (const c of candidates) {
    try { return require.resolve(c); } catch { /* keep looking */ }
  }
  console.error(`Could not resolve ${what}.\n  ${hint}`);
  process.exit(1);
}

const puppeteer = require(resolveFrom(
  ["puppeteer", path.join(ROOT, "nocturne_dashboard/node_modules/puppeteer")],
  "puppeteer",
  "npm install --prefix nocturne_dashboard puppeteer",
));

const MERMAID = resolveFrom(
  ["mermaid/dist/mermaid.min.js", path.join(ROOT, "node_modules/mermaid/dist/mermaid.min.js")],
  "mermaid",
  "npm install --no-save mermaid@11",
);

const THEME = {
  background: "#080c15",
  primaryColor: "#0e1729",
  primaryTextColor: "#e8eefa",
  primaryBorderColor: "#4c8dff",
  lineColor: "#7aa4ff",
  secondaryColor: "#12203a",
  tertiaryColor: "#0a1120",
  clusterBkg: "#0b1220",
  clusterBorder: "#2a3a5c",
  edgeLabelBackground: "#0b1220",
  fontSize: "18px",
};

(async () => {
  const blocks = [...fs.readFileSync(MD, "utf8").matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length !== NAMES.length) {
    console.error(`architecture.md has ${blocks.length} mermaid blocks but NAMES lists ${NAMES.length}.`);
    process.exit(1);
  }
  fs.mkdirSync(OUTDIR, { recursive: true });

  const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
  for (const [i, src] of blocks.entries()) {
    const page = await browser.newPage();
    await page.setViewport({ width: 2400, height: 1400, deviceScaleFactor: 2 });
    await page.setContent(
      `<!doctype html><meta charset="utf-8">
       <style>html,body{margin:0;padding:40px;background:${THEME.background}}
       .mermaid svg{max-width:none!important;height:auto!important}</style>
       <div id="d" class="mermaid">${src.replace(/</g, "&lt;")}</div>`,
      { waitUntil: "domcontentloaded" },
    );
    await page.addScriptTag({ path: MERMAID });
    const ok = await page.evaluate(async (theme) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        darkMode: true,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        themeVariables: theme,
        flowchart: { htmlLabels: true, nodeSpacing: 55, rankSpacing: 80, padding: 18, useMaxWidth: false },
        sequence: { useMaxWidth: false },
      });
      try { await mermaid.run({ querySelector: ".mermaid" }); return true; }
      catch (e) { return String(e); }
    }, THEME);
    if (ok !== true) { console.error(`FAIL ${NAMES[i]}: ${ok}`); process.exitCode = 1; await page.close(); continue; }
    await new Promise((r) => setTimeout(r, 400));
    const el = await page.$("#d svg");
    const box = await el.boundingBox();
    await el.screenshot({ path: path.join(OUTDIR, `${NAMES[i]}.png`) });
    console.log(`  ${NAMES[i]}.png  ${Math.round(box.width)}x${Math.round(box.height)} @2x`);
    await page.close();
  }
  await browser.close();
})();

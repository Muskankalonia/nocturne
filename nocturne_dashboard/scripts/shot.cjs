/* Screenshot a route as a logged-in user. Usage: node scripts/shot.cjs <route> <out.png> [user] */
const puppeteer = require("puppeteer");
const BASE = process.env.BASE || "http://localhost:3113";
const route = process.argv[2] || "/";
const out = process.argv[3] || "shot.png";
const user = process.argv[4] || "palo_alto_networks";

(async () => {
  const b = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1600, height: 1000 },
  });
  const p = await b.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  // /login is the one route that must be captured signed out.
  if (route !== "/login") {
    await p.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
    const ins = await p.$$("input");
    await ins[0].type(user);
    await ins[1].type(user);
    await Promise.all([
      p.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 15000 }),
      p.click('button[type="submit"]'),
    ]);
  }

  await p.goto(`${BASE}${route}`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 3500));

  const info = await p.evaluate(() => {
    const c = document.querySelector("canvas");
    return c
      ? { canvas: { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } }
      : { canvas: null };
  });
  console.log(JSON.stringify(info));
  if (errors.length) console.log("ERRORS:", [...new Set(errors)].slice(0, 5).join(" | ").slice(0, 400));

  await p.screenshot({ path: out, fullPage: false });
  await b.close();
})();

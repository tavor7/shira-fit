// What-the-user-sees comparison of two builds on the ISOLATED perf stack (A = before, B = after a data-loading change):
// for each scenario, waits until the network is quiet and the text is stable, then compares all visible text and all
// accessibility labels (status badges such as "registered" are labels). Requests may differ by design; the screen must not.
// Usage: PLAYWRIGHT_MODULE_DIR=... PERF_BASE_A=http://127.0.0.1:8201 PERF_BASE_B=http://127.0.0.1:8202 PERF_ENGINE=chromium node compare-ui.mjs
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pwDir = process.env.PLAYWRIGHT_MODULE_DIR;
const { chromium, webkit } = require(pwDir ? path.join(pwDir, "playwright") : "playwright");
const A = process.env.PERF_BASE_A ?? "http://127.0.0.1:8201";
const B = process.env.PERF_BASE_B ?? "http://127.0.0.1:8202";
const ENGINE = process.env.PERF_ENGINE ?? "chromium";
for (const u of [A, B]) if (!["127.0.0.1", "localhost"].includes(new URL(u).hostname)) throw new Error(`non-local ${u}`);

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();

async function open(base, email) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => localStorage.setItem("shira_fit_language", "en"));
  await ctx.route(/\.supabase\.co\//, (r) => r.abort());
  const page = await ctx.newPage();
  const net = { inFlight: 0, last: Date.now() };
  const mine = (r) => new URL(r.url()).port === "57499";
  page.on("request", (r) => { if (mine(r)) { net.inFlight++; net.last = Date.now(); } });
  const done = (r) => { if (mine(r)) { net.inFlight = Math.max(0, net.inFlight - 1); net.last = Date.now(); } };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  await page.goto(`${base}/login`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("PerfPass123!");
  await page.getByPlaceholder("Password").press("Enter");
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30_000 });
  return { ctx, page, net };
}

async function settle(page, net) {
  const t0 = Date.now();
  let prev = "";
  while (Date.now() - t0 < 60_000) {
    await page.waitForTimeout(500);
    const snap = await capture(page);
    const quiet = net.inFlight === 0 && Date.now() - net.last >= 3000;
    if (quiet && snap === prev) return snap;
    prev = snap;
  }
  throw new Error("did not settle");
}

async function capture(page) {
  return page.evaluate(() => {
    const labels = [...document.querySelectorAll("[aria-label]")]
      .filter((e) => e.getClientRects().length > 0)
      .map((e) => e.getAttribute("aria-label"));
    return JSON.stringify({ path: location.pathname, text: document.body.innerText.replace(/\s+/g, " ").trim(), labels });
  });
}

const scenarios = [];
for (const email of ["perf-ath-002@perf.test", "perf-ath-001@perf.test", "perf-ath-009@perf.test"]) {
  scenarios.push([`${email} home (this week)`, email, async () => {}]);
  scenarios.push([`${email} home (next week)`, email, async (page) => {
    await page.locator('[aria-label="Next week"]').locator("visible=true").first().click();
  }]);
  scenarios.push([`${email} my sessions`, email, async (page) => {
    await page.goto(new URL("/athlete/my-sessions", page.url()).href);
  }]);
}
scenarios.push(["perf-coach-1@perf.test home", "perf-coach-1@perf.test", async () => {}]);
scenarios.push(["perf-mgr-2@perf.test home", "perf-mgr-2@perf.test", async () => {}]);
scenarios.push(["perf-mgr-1@perf.test (super user) home", "perf-mgr-1@perf.test", async () => {}]);

let differ = 0;
for (const [name, email, act] of scenarios) {
  const results = [];
  for (const base of [A, B]) {
    const { ctx, page, net } = await open(base, email);
    await settle(page, net);
    await act(page);
    results.push(await settle(page, net));
    await ctx.close();
  }
  const same = results[0] === results[1];
  if (!same) {
    differ++;
    const [a, b] = results.map((r) => JSON.parse(r));
    let i = 0;
    while (i < a.text.length && a.text[i] === b.text[i]) i++;
    console.log(`${ENGINE} ${name}: DIFFERENT (path ${a.path} vs ${b.path}; labels ${a.labels.length} vs ${b.labels.length})\n    A …${a.text.slice(Math.max(0, i - 60), i + 80)}\n    B …${b.text.slice(Math.max(0, i - 60), i + 80)}`);
  } else {
    const a = JSON.parse(results[0]);
    console.log(`${ENGINE} ${name}: SAME (${a.text.length} chars, ${a.labels.length} labels)`);
  }
}
await browser.close();
console.log(differ === 0 ? `RESULT: identical screens in ${scenarios.length} scenarios` : `RESULT: ${differ} scenario(s) differ`);
process.exit(differ === 0 ? 0 : 1);

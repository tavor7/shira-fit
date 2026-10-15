// Verifies that a build WITH the performance instrumentation behaves exactly like a build WITHOUT it while the
// instrumentation is disabled (its default). Both builds run against the isolated perf stack; for each role the same steps
// (cold start → open first session → back) are executed and compared: Supabase requests (method + path, ids redacted,
// counted), final route, visible page text, and absence of the panel / global hook.
//
// Usage: PLAYWRIGHT_MODULE_DIR=... PERF_BASE_A=http://127.0.0.1:8201 PERF_BASE_B=http://127.0.0.1:8202 \
//        PERF_ENGINE=chromium|webkit node compare-disabled.mjs
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pwDir = process.env.PLAYWRIGHT_MODULE_DIR;
const { chromium, webkit } = require(pwDir ? path.join(pwDir, "playwright") : "playwright");
const A = process.env.PERF_BASE_A ?? "http://127.0.0.1:8201";
const B = process.env.PERF_BASE_B ?? "http://127.0.0.1:8202";
const ENGINE = process.env.PERF_ENGINE ?? "chromium";
const PASSWORD = process.env.PERF_PASSWORD ?? "PerfPass123!";
const ACCOUNTS = { athlete: "perf-ath-002@perf.test", coach: "perf-coach-1@perf.test", manager: "perf-mgr-2@perf.test" };
const TIME_RANGE = /\d{2}:\d{2}\D{0,4}[–-]\D{0,4}\d{2}:\d{2}/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

for (const u of [A, B]) if (!["127.0.0.1", "localhost"].includes(new URL(u).hostname)) throw new Error(`non-local ${u}`);
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();

async function ctxFor(base, state) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    hasTouch: true,
    ignoreHTTPSErrors: true,
    ...(state ? { storageState: state } : {}),
  });
  // Instrumentation explicitly OFF (also the default); language fixed so page text is comparable.
  await ctx.addInitScript(() => {
    localStorage.removeItem("sf_perf");
    localStorage.setItem("shira_fit_language", "en");
  });
  await ctx.route(/\.supabase\.co\//, (r) => r.abort());
  return ctx;
}

/** Settled = no Supabase request in flight and none started for 3 s, and the visible text unchanged since. */
async function settle(page, net) {
  const t0 = Date.now();
  let prev = "";
  while (Date.now() - t0 < 60_000) {
    await page.waitForTimeout(500);
    const text = await page.evaluate(() => document.body.innerText);
    const quiet = net.inFlight === 0 && Date.now() - net.lastActivity >= 3000;
    if (quiet && text === prev) return;
    prev = text;
  }
  throw new Error("page did not settle within 60 s");
}

function trackNetwork(page, reqs) {
  const net = { inFlight: 0, lastActivity: Date.now() };
  const mine = (r) => new URL(r.url()).port === "57499";
  page.on("request", (r) => {
    if (!mine(r)) return;
    net.inFlight += 1;
    net.lastActivity = Date.now();
    if (reqs) reqs.push(`${r.method()} ${new URL(r.url()).pathname.replace(UUID, ":id")}`);
  });
  const done = (r) => {
    if (!mine(r)) return;
    net.inFlight = Math.max(0, net.inFlight - 1);
    net.lastActivity = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return net;
}

async function capture(page, reqs) {
  const counts = {};
  for (const r of reqs.splice(0)) counts[r] = (counts[r] ?? 0) + 1;
  const state = await page.evaluate(() => ({
    route: location.pathname.replace(/[0-9a-f-]{36}/g, ":id"),
    hasPanel: !!document.querySelector('[aria-label="Performance panel"]'),
    hasGlobal: typeof globalThis.__SF_PERF__ !== "undefined",
    text: document.body.innerText.replace(/\s+/g, " ").trim(),
  }));
  return { requests: counts, ...state };
}

async function runSteps(base, role) {
  const login = await ctxFor(base);
  const lp = await login.newPage();
  const lnet = trackNetwork(lp, null);
  await lp.goto(`${base}/login`);
  await lp.getByPlaceholder("Email").fill(ACCOUNTS[role]);
  await lp.getByPlaceholder("Password").fill(PASSWORD);
  await lp.getByPlaceholder("Password").press("Enter");
  await lp.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30_000 });
  await settle(lp, lnet);
  const state = await login.storageState();
  await login.close();

  const ctx = await ctxFor(base, state);
  const page = await ctx.newPage();
  const reqs = [];
  const net = trackNetwork(page, reqs);
  const steps = {};
  await page.goto(`${base}/`);
  await settle(page, net);
  steps.coldStart = await capture(page, reqs);
  await page.getByText(TIME_RANGE).locator("visible=true").first().click();
  await settle(page, net);
  steps.openDetail = await capture(page, reqs);
  await page.goBack();
  await settle(page, net);
  steps.back = await capture(page, reqs);
  await ctx.close();
  return steps;
}

function diffCounts(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of [...keys].sort()) if ((a[k] ?? 0) !== (b[k] ?? 0)) out.push(`${k}: ${a[k] ?? 0} vs ${b[k] ?? 0}`);
  return out;
}

function textDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 60);
  return `first difference at char ${i}:\n    A: …${a.slice(from, i + 80)}\n    B: …${b.slice(from, i + 80)}`;
}

// Warm-up (discarded): the first pass in a fresh browser/server is slower and would only test the settle logic.
await runSteps(A, "athlete");
await runSteps(B, "athlete");

let failures = 0;
for (const role of ["athlete", "coach", "manager"]) {
  const a = await runSteps(A, role);
  const b = await runSteps(B, role);
  for (const step of Object.keys(a)) {
    const d = diffCounts(a[step].requests, b[step].requests);
    const total = (x) => Object.values(x.requests).reduce((s, n) => s + n, 0);
    const sameText = a[step].text === b[step].text;
    const ok = d.length === 0 && a[step].route === b[step].route && sameText && !b[step].hasPanel && !b[step].hasGlobal;
    if (!ok) failures += 1;
    console.log(
      `${ENGINE} ${role} ${step}: ${ok ? "SAME" : "DIFFERENT"} | requests ${total(a[step])} vs ${total(b[step])}` +
        ` | route ${a[step].route} vs ${b[step].route} | text ${sameText ? "same" : "differs"}` +
        ` | panel ${b[step].hasPanel} | global ${b[step].hasGlobal}` +
        (d.length ? `\n    request diffs: ${d.join("; ")}` : "") +
        (!sameText ? `\n    ${textDiff(a[step].text, b[step].text)}` : "")
    );
  }
}
await browser.close();
console.log(failures === 0 ? "RESULT: identical behaviour with instrumentation disabled" : `RESULT: ${failures} step(s) differ`);
process.exit(failures === 0 ? 0 : 1);

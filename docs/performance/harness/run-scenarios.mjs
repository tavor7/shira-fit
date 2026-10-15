// Phase 0 scenario runner for the ISOLATED local perf environment (docs/performance/README.md).
// Drives a local web build (served by serve-static.mjs, talking to latency-proxy.mjs → local perf stack) with Playwright,
// reads the in-app instrumentation (globalThis.__SF_PERF__) and writes raw JSON + a markdown summary.
//
// Usage:
//   PLAYWRIGHT_MODULE_DIR=/path/to/node_modules PERF_BUNDLE_DIR=<perfweb> PERF_OUT=<dir> \
//   PERF_ENGINE=chromium|webkit PERF_RUNS=5 node run-scenarios.mjs
//
// Safety: refuses non-localhost targets, refuses a bundle that references any *.supabase.co project, and aborts every
// browser request to *.supabase.co. Writes only to the isolated perf stack (S7 registers then cancels a synthetic athlete).

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const pwDir = process.env.PLAYWRIGHT_MODULE_DIR;
const { chromium, webkit } = require(pwDir ? path.join(pwDir, "playwright") : "playwright");

const BASE = process.env.PERF_BASE ?? "http://127.0.0.1:8199";
const DIRECT_API = process.env.PERF_DIRECT_API ?? "http://127.0.0.1:57421";
const ANON_KEY = process.env.PERF_ANON_KEY ?? "";
const ENGINE = process.env.PERF_ENGINE ?? "chromium";
const RUNS = Number(process.env.PERF_RUNS ?? 5);
const OUT = process.env.PERF_OUT ?? "perf-results";
const PASSWORD = process.env.PERF_PASSWORD ?? "PerfPass123!";
const DB_CONTAINER = process.env.PERF_DB_CONTAINER ?? "supabase_db_shirafit-perf";
const RESUME_WAIT_MS = Number(process.env.PERF_RESUME_WAIT_MS ?? 35_000);

for (const u of [BASE, DIRECT_API]) {
  if (!["127.0.0.1", "localhost"].includes(new URL(u).hostname)) throw new Error(`refusing non-local target ${u}`);
}
{
  const dir = path.join(process.env.PERF_BUNDLE_DIR ?? "", "_expo/static/js/web");
  const js = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  for (const f of js) {
    if (/[a-z0-9]{20}\.supabase\.co/.test(fs.readFileSync(path.join(dir, f), "utf8"))) {
      throw new Error(`refusing to run: ${f} references a hosted Supabase project`);
    }
  }
}

const ACCOUNTS = {
  // perf-ath-002: 285 session ids on the athlete calendar, matching production's largest athlete (287) on 2026-10-15.
  athlete: process.env.PERF_ATHLETE ?? "perf-ath-002@perf.test",
  coach: "perf-coach-1@perf.test",
  manager: "perf-mgr-2@perf.test",
};
const HOME = { athlete: "athlete.home", coach: "coach.home", manager: "manager.home" };
const DETAIL = { athlete: "athlete.session", coach: "coach.session", manager: "manager.session" };
/** iPhone 15-class viewport; the engine decides the rest. */
const PHONE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};
const TIME_RANGE = /\d{2}:\d{2}\D{0,4}[–-]\D{0,4}\d{2}:\d{2}/;

fs.mkdirSync(OUT, { recursive: true });
const browserType = ENGINE === "webkit" ? webkit : chromium;
const browser = await browserType.launch({ headless: true });
const states = {};

function psql(sql) {
  return execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-At", "-c", sql], { encoding: "utf8" }).trim();
}

async function newContext(role) {
  const ctx = await browser.newContext({ ...PHONE, ignoreHTTPSErrors: true, ...(states[role] ? { storageState: states[role] } : {}) });
  await ctx.addInitScript(() => {
    localStorage.setItem("sf_perf", "1");
    localStorage.setItem("shira_fit_language", "en");
  });
  await ctx.route(/\.supabase\.co\//, (r) => r.abort());
  return ctx;
}

async function snap(page) {
  return page.evaluate(() => globalThis.__SF_PERF__?.snapshot() ?? null);
}

/** Waits for a NEW visit of `screen` that shows content, with no request in flight for `quietMs`. */
async function waitVisit(page, screen, afterVisitId, { quietMs = 1000, timeoutMs = 45_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await page.evaluate(
      ([scr, after, quiet]) => {
        const sn = globalThis.__SF_PERF__?.snapshot();
        if (!sn) return null;
        const v = [...sn.visits].reverse().find((x) => x.screen === scr && x.id > after);
        if (!v || v.contentAt == null) return null;
        const open = sn.requests.some((r) => r.end == null);
        const lastEnd = Math.max(0, ...sn.requests.map((r) => r.end ?? 0));
        if (open || performance.now() - lastEnd < quiet) return null;
        const openNotReady = v.notReady.some((p) => p.end == null);
        if (openNotReady) return null;
        return v.id;
      },
      [screen, afterVisitId, quietMs]
    );
    if (s != null) return s;
    await page.waitForTimeout(100);
  }
  throw new Error(`timeout waiting for ${screen}`);
}

function maxVisitId(sn) {
  return Math.max(0, ...(sn?.visits ?? []).map((v) => v.id));
}

function bytesTracker(page) {
  let bytes = 0;
  let count = 0;
  page.on("requestfinished", async (req) => {
    if (!req.url().startsWith("https://127.0.0.1:57499")) return;
    try {
      const sz = await req.sizes();
      bytes += sz.responseBodySize + sz.responseHeadersSize;
      count += 1;
    } catch {
      /* ignore */
    }
  });
  return {
    take() {
      const r = { bytes, count };
      bytes = 0;
      count = 0;
      return r;
    },
  };
}

async function login(role) {
  const ctx = await newContext(role);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder("Email").fill(ACCOUNTS[role]);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByPlaceholder("Password").press("Enter");
  await waitVisit(page, HOME[role], 0, { quietMs: 1500 });
  states[role] = await ctx.storageState();
  await ctx.close();
}

async function clickFirstSession(page) {
  await page.getByText(TIME_RANGE).locator("visible=true").first().click();
}

async function setVisibility(page, state) {
  await page.evaluate((st) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => st });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => st === "hidden" });
    // Browsers fire it on document and it bubbles to window, where supabase-js listens.
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, state);
}

function summaryOf(sn, visitId) {
  const s = sn.summaries.find((x) => x.visitId === visitId);
  const v = sn.visits.find((x) => x.id === visitId);
  return { ...s, contentAtSinceNavStart: v?.contentAt != null ? Math.round(v.contentAt) : null };
}

async function requestsBetween(page, t0, t1) {
  const sn = await snap(page);
  return sn.requests.filter((r) => r.start >= t0 && r.start <= t1);
}

async function athleteToken(email) {
  const res = await fetch(`${DIRECT_API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`token for ${email}: ${res.status}`);
  return (await res.json()).access_token;
}

async function rpcAs(token, fn, args) {
  const res = await fetch(`${DIRECT_API}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return res.json();
}

async function runRole(role, run) {
  const out = { role, run, engine: ENGINE, steps: {} };
  const ctx = await newContext(role);
  const page = await ctx.newPage();
  const bytes = bytesTracker(page);

  // S1 cold start (stored session, fresh page) → home content.
  await page.goto(`${BASE}/`);
  let vHome = await waitVisit(page, HOME[role], 0);
  let sn = await snap(page);
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return n ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), loadEvent: Math.round(n.loadEventEnd) } : null;
  });
  out.steps.coldStart = { home: summaryOf(sn, vHome), startup: sn.startup, jsStartAt: Math.round(sn.jsStartAt), nav, network: bytes.take() };

  // S2/S5/S6 home → session detail (tap → content).
  let before = maxVisitId(sn);
  await clickFirstSession(page);
  const vDetail = await waitVisit(page, DETAIL[role], before);
  sn = await snap(page);
  out.steps.openDetail = { detail: summaryOf(sn, vDetail), network: bytes.take() };
  if (role === "manager") {
    const roster = [...sn.visits].reverse().find((v) => v.screen === "session.roster" && v.id > before);
    out.steps.openDetail.roster = roster ? summaryOf(sn, roster.id) : null;
  }

  // S3 back to home (return to a visited screen).
  before = maxVisitId(sn);
  await page.goBack();
  vHome = await waitVisit(page, HOME[role], before);
  sn = await snap(page);
  out.steps.backToHome = { home: summaryOf(sn, vHome), network: bytes.take() };

  if (role === "manager") {
    // S11 menu navigation → Overview (dashboard, week), then S9 month and global.
    before = maxVisitId(sn);
    await page.locator('[aria-label="Open navigation menu"]').locator("visible=true").first().click();
    await page.getByRole("button", { name: "Overview", exact: true }).locator("visible=true").first().click();
    const vDash = await waitVisit(page, "manager.dashboard", before, { quietMs: 1500 });
    sn = await snap(page);
    out.steps.dashboardWeek = { dashboard: summaryOf(sn, vDash), network: bytes.take() };
    for (const mode of ["Month", "Global"]) {
      const t0 = await page.evaluate(() => performance.now());
      await page.getByText(mode, { exact: true }).locator("visible=true").first().click();
      await page.waitForTimeout(200);
      await waitVisit(page, "manager.dashboard", vDash - 1, { quietMs: 1500, timeoutMs: 60_000 });
      sn = await snap(page);
      const v = sn.visits.find((x) => x.id === vDash);
      const interval = v.notReady[v.notReady.length - 1];
      const reqs = await requestsBetween(page, t0, Number.MAX_SAFE_INTEGER);
      out.steps[`dashboard${mode}`] = {
        clickToContentMs: interval?.end != null ? Math.round(interval.end - t0) : null,
        requests: reqs.length,
        endpoints: reqs.map((r) => `${r.endpoint} ${Math.round((r.end ?? 0) - r.start)}ms`),
        network: bytes.take(),
      };
    }

    // S11 back to Sessions through the menu.
    before = maxVisitId(sn);
    await page.locator('[aria-label="Open navigation menu"]').locator("visible=true").first().click();
    await page.getByRole("button", { name: "Sessions", exact: true }).locator("visible=true").first().click();
    vHome = await waitVisit(page, HOME[role], before);
    sn = await snap(page);
    out.steps.menuToHome = { home: summaryOf(sn, vHome), network: bytes.take() };

    // S7 realtime: a synthetic athlete registers (then cancels) on the isolated stack while the manager home is open.
    const sessionId = psql(
      `select s.id from public.training_sessions s where s.max_participants = 12 and not s.is_hidden and s.is_open_for_registration
         and s.session_date between current_date + 1 and current_date + 6
         and (select count(*) from public.session_registrations r where r.session_id = s.id and r.status = 'active') < 10
       order by s.session_date, s.start_time limit 1;`
    );
    if (sessionId) {
      const token = await athleteToken("perf-ath-157@perf.test");
      const t0 = await page.evaluate(() => performance.now());
      const reg = await rpcAs(token, "register_for_session", { p_session_id: sessionId, p_accept_extra_subscription_charge: false });
      await page.waitForTimeout(5000);
      const t1 = await page.evaluate(() => performance.now());
      sn = await snap(page);
      const v = sn.visits.find((x) => x.id === vHome);
      const flashes = v.notReady.filter((p) => p.start >= t0);
      const reqs = sn.requests.filter((r) => r.start >= t0 && r.start <= t1);
      out.steps.realtimeRegistration = {
        registerResult: reg?.ok === true ? "ok" : JSON.stringify(reg).slice(0, 80),
        requestsIn5s: reqs.length,
        skeletonFlashes: flashes.length,
        skeletonMs: Math.round(flashes.reduce((a, p) => a + ((p.end ?? t1) - p.start), 0)),
        network: bytes.take(),
      };
      await rpcAs(token, "cancel_registration", { p_session_id: sessionId, p_reason: "perf harness cleanup" });
      await page.waitForTimeout(3000);
      // A cancellation creates a cancellations row; remove the synthetic artefacts so every run starts from the same data.
      psql(`delete from public.cancellations where session_id = '${sessionId}' and reason = 'perf harness cleanup';
            delete from public.session_registrations r using auth.users u where r.session_id = '${sessionId}' and r.user_id = u.id and u.email = 'perf-ath-157@perf.test';`);
      bytes.take();
    }
  }

  // S12 resume (first run only: needs a real background period longer than the 30 s refetch threshold).
  if (run === 0 && RESUME_WAIT_MS > 0) {
    await setVisibility(page, "hidden");
    await page.waitForTimeout(RESUME_WAIT_MS);
    const t0 = await page.evaluate(() => performance.now());
    await setVisibility(page, "visible");
    await page.waitForTimeout(5000);
    const t1 = await page.evaluate(() => performance.now());
    const reqs = await requestsBetween(page, t0, t1);
    const endpoints = {};
    for (const r of reqs) endpoints[r.endpoint] = (endpoints[r.endpoint] ?? 0) + 1;
    out.steps.resume = { hiddenMs: RESUME_WAIT_MS, requestsIn5s: reqs.length, endpoints, network: bytes.take() };
  }

  out.rawSnapshot = await snap(page);
  await ctx.close();
  return out;
}

const results = [];
for (const role of (process.env.PERF_ROLES ?? "athlete,coach,manager").split(",")) {
  await login(role);
  for (let run = 0; run < RUNS; run++) {
    try {
      const r = await runRole(role, run);
      results.push(r);
      console.log(`${ENGINE} ${role} run ${run + 1}/${RUNS} ok`);
    } catch (e) {
      results.push({ role, run, engine: ENGINE, error: String(e?.message ?? e).split("\n")[0] });
      console.log(`${ENGINE} ${role} run ${run + 1}/${RUNS} FAILED: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
}
await browser.close();

const file = path.join(OUT, `${ENGINE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ engine: ENGINE, runs: RUNS, base: BASE, results }, null, 2));
console.log(`wrote ${file}`);

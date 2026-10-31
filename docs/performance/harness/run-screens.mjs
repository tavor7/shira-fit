// Phase 2 scenario runner: in-app navigation across the screens run-scenarios.mjs does not reach (subscriptions, payments,
// roster calendar, participant history, athlete My Sessions / subscription), plus the cost of navigation itself.
// Same isolated environment, safety checks and instrumentation as run-scenarios.mjs (docs/performance/README.md).
//
// Navigation is in-app (history.pushState + popstate, which expo-router handles like a link), never a page reload, and
// read-only: no scenario writes.
//
// Usage: PLAYWRIGHT_MODULE_DIR=… PERF_BUNDLE_DIR=… PERF_OUT=… PERF_BASE=http://127.0.0.1:8299 \
//   PERF_PROXY_ORIGIN=https://127.0.0.1:57599 PERF_ENGINE=chromium PERF_RUNS=3 node run-screens.mjs

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const pwDir = process.env.PLAYWRIGHT_MODULE_DIR;
const { chromium, webkit } = require(pwDir ? path.join(pwDir, "playwright") : "playwright");

const BASE = process.env.PERF_BASE ?? "http://127.0.0.1:8199";
const PROXY_ORIGIN = process.env.PERF_PROXY_ORIGIN ?? "https://127.0.0.1:57499";
const ENGINE = process.env.PERF_ENGINE ?? "chromium";
const RUNS = Number(process.env.PERF_RUNS ?? 3);
const OUT = process.env.PERF_OUT ?? "perf-results";
const PASSWORD = process.env.PERF_PASSWORD ?? "PerfPass123!";
const DB_CONTAINER = process.env.PERF_DB_CONTAINER ?? "supabase_db_shirafit-perf";
const LABEL = process.env.PERF_LABEL ?? "run";

for (const u of [BASE, PROXY_ORIGIN]) {
  if (!["127.0.0.1", "localhost"].includes(new URL(u).hostname)) throw new Error(`refusing non-local target ${u}`);
}
{
  const dir = path.join(process.env.PERF_BUNDLE_DIR ?? "", "_expo/static/js/web");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".js"))) {
    if (/[a-z0-9]{20}\.supabase\.co/.test(fs.readFileSync(path.join(dir, f), "utf8"))) {
      throw new Error(`refusing to run: ${f} references a hosted Supabase project`);
    }
  }
}

const psql = (sql) =>
  execFileSync("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-At", "-c", sql], { encoding: "utf8" }).trim();

const subId = psql(
  "select s.id from public.subscriptions s join auth.users u on u.id = s.payee_id where u.email = 'perf-ath-002@perf.test' limit 1;"
);
const athleteId = psql("select id from auth.users where email = 'perf-ath-002@perf.test';");

const FLOWS = {
  manager: {
    email: "perf-mgr-2@perf.test",
    home: ["/manager/sessions", "manager.home"],
    steps: [
      ["rosterCalendar", "/manager/roster-calendar", "manager.rosterCalendar"],
      ["accountPayments", "/manager/account-payments", "manager.accountPayments"],
      ["subscriptions", "/manager/subscriptions", "manager.subscriptions"],
      ["subscriptionDetail", `/manager/subscriptions/${subId}`, "manager.subscriptionDetail"],
      ["subscriptionsAgain", "/manager/subscriptions", "manager.subscriptions"],
      ["participantHistory", `/manager/participant-history?presetUserId=${athleteId}`, "participantHistory"],
      ["dashboard", "/manager/dashboard", "manager.dashboard"],
      ["homeAgain", "/manager/sessions", "manager.home"],
    ],
  },
  athlete: {
    email: "perf-ath-002@perf.test",
    home: ["/athlete/sessions", "athlete.home"],
    steps: [
      ["mySessions", "/athlete/my-sessions", "athlete.mySessions"],
      ["homeAgain", "/athlete/sessions", "athlete.home"],
      ["mySessionsAgain", "/athlete/my-sessions", "athlete.mySessions"],
      ["homeAgain2", "/athlete/sessions", "athlete.home"],
    ],
  },
  coach: {
    email: "perf-coach-1@perf.test",
    home: ["/coach/sessions", "coach.home"],
    steps: [
      ["participantHistory", `/coach/participant-history?presetUserId=${athleteId}`, "participantHistory"],
      ["homeAgain", "/coach/sessions", "coach.home"],
    ],
  },
};

const PHONE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await (ENGINE === "webkit" ? webkit : chromium).launch({ headless: true });
const states = {};

async function newContext(role) {
  const ctx = await browser.newContext({ ...PHONE, ignoreHTTPSErrors: true, ...(states[role] ? { storageState: states[role] } : {}) });
  await ctx.addInitScript(() => {
    localStorage.setItem("sf_perf", "1");
    localStorage.setItem("shira_fit_language", "en");
  });
  await ctx.route(/\.supabase\.co\//, (r) => r.abort());
  return ctx;
}

const snap = (page) => page.evaluate(() => globalThis.__SF_PERF__?.snapshot() ?? null);
const maxVisitId = (sn) => Math.max(0, ...(sn?.visits ?? []).map((v) => v.id));

async function waitVisit(page, screen, afterVisitId, { quietMs = 1000, timeoutMs = 45_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const id = await page.evaluate(
      ([scr, after, quiet]) => {
        const sn = globalThis.__SF_PERF__?.snapshot();
        if (!sn) return null;
        const v = [...sn.visits].reverse().find((x) => x.screen === scr && x.id > after);
        if (!v || v.contentAt == null) return null;
        if (sn.requests.some((r) => r.end == null)) return null;
        const lastEnd = Math.max(0, ...sn.requests.map((r) => r.end ?? 0));
        if (performance.now() - lastEnd < quiet) return null;
        return v.id;
      },
      [screen, afterVisitId, quietMs]
    );
    if (id != null) return id;
    await page.waitForTimeout(100);
  }
  throw new Error(`timeout waiting for ${screen}`);
}

function bytesTracker(page) {
  let bytes = 0;
  page.on("requestfinished", async (req) => {
    if (!req.url().startsWith(PROXY_ORIGIN)) return;
    try {
      const sz = await req.sizes();
      bytes += sz.responseBodySize + sz.responseHeadersSize;
    } catch {
      /* ignore */
    }
  });
  return { take: () => ((b) => ((bytes = 0), b))(bytes) };
}

async function login(role) {
  const ctx = await newContext(role);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder("Email").fill(FLOWS[role].email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByPlaceholder("Password").press("Enter");
  await waitVisit(page, FLOWS[role].home[1], 0, { quietMs: 1500 });
  states[role] = await ctx.storageState();
  await ctx.close();
}

async function navigate(page, url) {
  await page.evaluate((u) => {
    window.history.pushState({}, "", u);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, url);
}

async function runRole(role, run) {
  const flow = FLOWS[role];
  const ctx = await newContext(role);
  const page = await ctx.newPage();
  const bytes = bytesTracker(page);
  const out = { role, run, engine: ENGINE, label: LABEL, steps: {} };
  await page.goto(`${BASE}${flow.home[0]}`);
  await waitVisit(page, flow.home[1], 0, { quietMs: 1500 });
  bytes.take();
  for (const [name, url, screen] of flow.steps) {
    const before = maxVisitId(await snap(page));
    const t0 = await page.evaluate(() => performance.now());
    await navigate(page, url);
    const vid = await waitVisit(page, screen, before);
    const sn = await snap(page);
    const v = sn.visits.find((x) => x.id === vid);
    const reqs = sn.requests.filter((r) => r.start >= t0);
    const endpoints = {};
    for (const r of reqs) endpoints[r.endpoint] = (endpoints[r.endpoint] ?? 0) + 1;
    const lastEnd = Math.max(t0, ...reqs.map((r) => r.end ?? t0));
    out.steps[name] = {
      navToContentMs: v.contentAt != null ? Math.round(Math.max(0, v.contentAt - t0)) : null,
      settledMs: Math.round(lastEnd - t0),
      requests: reqs.length,
      endpoints,
      kb: Math.round(bytes.take() / 1024),
    };
  }
  await ctx.close();
  return out;
}

const results = [];
for (const role of (process.env.PERF_ROLES ?? "manager,athlete,coach").split(",")) {
  await login(role);
  for (let run = 0; run < RUNS; run++) {
    try {
      results.push(await runRole(role, run));
      console.log(`${ENGINE} ${LABEL} ${role} run ${run + 1}/${RUNS} ok`);
    } catch (e) {
      results.push({ role, run, engine: ENGINE, label: LABEL, error: String(e?.message ?? e).split("\n")[0] });
      console.log(`${ENGINE} ${LABEL} ${role} run ${run + 1}/${RUNS} FAILED: ${String(e?.message ?? e).split("\n")[0]}`);
    }
  }
}
await browser.close();
const file = path.join(OUT, `screens-${LABEL}-${ENGINE}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ engine: ENGINE, runs: RUNS, label: LABEL, results }, null, 2));
console.log(`wrote ${file}`);

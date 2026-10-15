// Read-only post-deploy check of the production web app (no login, no writes). Verifies:
//  - default: the app renders, no ⏱ panel, no globalThis.__SF_PERF__, no page errors;
//  - explicit enable (?sf_perf=1): panel appears and opens; the snapshot contains only the approved fields;
//  - explicit disable (?sf_perf=0): panel gone again after reload.
// Usage: PLAYWRIGHT_MODULE_DIR=... PERF_ENGINE=chromium|webkit node verify-production.mjs [https://shira-fit-mobile-web.onrender.com]
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const pwDir = process.env.PLAYWRIGHT_MODULE_DIR;
const { chromium, webkit } = require(pwDir ? path.join(pwDir, "playwright") : "playwright");
const BASE = process.argv[2] ?? "https://shira-fit-mobile-web.onrender.com";
const ENGINE = process.env.PERF_ENGINE ?? "chromium";
const SENSITIVE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|@|https?:\/\/|supabase\.co|select=|eyJ|05\d{8}/i;

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
});
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} [${ENGINE}] ${name}${detail ? " — " + detail : ""}`);
};

// 1. Default (never enabled on this fresh profile).
await page.goto(`${BASE}/`);
await page.waitForTimeout(6000);
const bundle = await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => s.includes("/_expo/static/js/web/")) ?? "");
check("app renders the sign-in screen", await page.getByPlaceholder(/email|אימייל|דוא/i).first().isVisible().catch(() => false), `bundle ${bundle.split("/").pop()}`);
check("panel hidden by default", (await page.locator('[aria-label="Performance panel"]').count()) === 0);
check("no global hook by default", await page.evaluate(() => typeof globalThis.__SF_PERF__ === "undefined"));
check("flag not set by default", await page.evaluate(() => localStorage.getItem("sf_perf") === null));
check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

// 2. Explicit enable on this device only.
await page.goto(`${BASE}/?sf_perf=1`);
await page.waitForTimeout(6000);
const fab = page.locator('[aria-label="Performance panel"]');
check("panel button appears when enabled", (await fab.count()) === 1);
await fab.first().click();
await page.waitForTimeout(500);
check("panel opens", await page.getByText("Copy JSON").isVisible().catch(() => false));
// The global hook installs lazily on the first recorded request/visit; the signed-out sign-in page records nothing,
// so read the snapshot the way a user exports it: the panel's "Copy JSON" (clipboard; Chromium grants read access).
let snap = null;
if (ENGINE === "chromium") {
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
  await page.getByText("Copy JSON").click();
  await page.waitForTimeout(500);
  snap = await page.evaluate(async () => JSON.parse(await navigator.clipboard.readText()));
  check("Copy JSON exports a snapshot", snap != null && snap.version === 1);
} else {
  console.log(`INFO [${ENGINE}] snapshot export not read (no clipboard access in this engine); content checked in chromium`);
}
if (snap) {
  const keys = Object.keys(snap).sort().join(",");
  check("snapshot has only the approved top-level fields", keys === "capturedAt,jsStartAt,requests,startup,summaries,version,visits", keys);
  const reqKeys = new Set(snap.requests.flatMap((r) => Object.keys(r)));
  const allowed = new Set(["id", "endpoint", "method", "start", "end", "status", "visitId"]);
  check("request records have only approved fields", [...reqKeys].every((k) => allowed.has(k)), [...reqKeys].join(","));
  check("no URL/id/email/token/phone in snapshot", !SENSITIVE.test(JSON.stringify(snap)), `${snap.requests.length} requests, ${snap.visits.length} visits recorded`);
}

// 3. Explicit disable.
await page.goto(`${BASE}/?sf_perf=0`);
await page.waitForTimeout(5000);
check("disable removes the flag", await page.evaluate(() => localStorage.getItem("sf_perf") === null));
await page.goto(`${BASE}/`);
await page.waitForTimeout(5000);
check("panel hidden again after disable", (await page.locator('[aria-label="Performance panel"]').count()) === 0);

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(failed === 0 ? `ALL ${results.length} CHECKS PASSED (${ENGINE})` : `${failed} CHECK(S) FAILED (${ENGINE})`);
process.exit(failed === 0 ? 0 : 1);

// Functional auth / consent verification on the ISOLATED perf stack, run against two builds (A = before, B = after) to
// prove a startup change keeps the same outcomes. Scenarios (Performance Phase 1 / step 2):
//   1 normal sign-in → home, no gate
//   2 legal-consent gate genuinely required → gate shown, still shown after resume
//   3 signup consents pending at first login → recorded exactly once by the client sync, gate never flashes
//   4 account switch → no stale profile
//   5 pending athlete approved while the app is in the background → leaves /pending on resume
//   6 athlete disabled while the app is in the background → sent to /disabled on resume
// Usage: PLAYWRIGHT_MODULE_DIR=... PERF_BASE_A=http://127.0.0.1:8201 PERF_BASE_B=http://127.0.0.1:8202 \
//        PERF_ENGINE=chromium|webkit [PERF_RESUME_HIDDEN_MS=35000] node verify-auth-consent.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
const pwDir = process.env.PLAYWRIGHT_MODULE_DIR;
const { chromium, webkit } = require(pwDir ? path.join(pwDir, "playwright") : "playwright");
const A = process.env.PERF_BASE_A ?? "http://127.0.0.1:8201";
const B = process.env.PERF_BASE_B ?? "http://127.0.0.1:8202";
const ENGINE = process.env.PERF_ENGINE ?? "chromium";
const HIDDEN_MS = Number(process.env.PERF_RESUME_HIDDEN_MS ?? 35_000);
const PASSWORD = "PerfPass123!";
const DB = "supabase_db_shirafit-perf";
const DIALOG = '[role="dialog"][aria-modal="true"]';

for (const u of [A, B]) if (!["127.0.0.1", "localhost"].includes(new URL(u).hostname)) throw new Error(`non-local ${u}`);

function sql(q) {
  // Isolated stack only: refuse if any non-@perf.test user exists (i.e. this is not the synthetic perf database).
  const guard = execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-At", "-c",
    "select count(*) from auth.users where email not like '%@perf.test'"], { encoding: "utf8" }).trim();
  if (guard !== "0") throw new Error("refusing: not the isolated perf database");
  return execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { encoding: "utf8" }).trim();
}
const uid = (email) => sql(`select id from auth.users where email='${email}'`);

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, hasTouch: true, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => localStorage.setItem("shira_fit_language", "en"));
  await ctx.route(/\.supabase\.co\//, (r) => r.abort());
  return { ctx, page: await ctx.newPage() };
}
async function login(page, base, email) {
  await page.goto(`${base}/login`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByPlaceholder("Password").press("Enter");
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30_000 });
}
async function setVisibility(page, st) {
  await page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, st);
}
/** Polls for `ms`; returns whether the gate dialog was ever visible and whether it is visible at the end. */
async function watchDialog(page, ms) {
  let ever = false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.locator(DIALOG).first().isVisible().catch(() => false)) ever = true;
    await page.waitForTimeout(100);
  }
  return { ever, end: await page.locator(DIALOG).first().isVisible().catch(() => false) };
}
async function waitForPath(page, re, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (re.test(new URL(page.url()).pathname)) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

const scenarios = {
  async normal(base) {
    const { ctx, page } = await newPage();
    await login(page, base, "perf-ath-020@perf.test");
    const d = await watchDialog(page, 4000);
    const out = { path: new URL(page.url()).pathname, gateEver: d.ever };
    await ctx.close();
    return out;
  },

  async legalGateRequired(base) {
    const u = uid("perf-ath-021@perf.test");
    sql(`delete from public.user_consents where user_id='${u}'; update public.app_settings set legal_consent_gate_enabled = true where id = 1;`);
    try {
      const { ctx, page } = await newPage();
      await login(page, base, "perf-ath-021@perf.test");
      const first = await watchDialog(page, 5000);
      await setVisibility(page, "hidden");
      await page.waitForTimeout(1500);
      await setVisibility(page, "visible");
      const afterResume = await watchDialog(page, 4000);
      await ctx.close();
      return { gateShown: first.end, gateAfterResume: afterResume.end };
    } finally {
      sql(`update public.app_settings set legal_consent_gate_enabled = false where id = 1;`);
    }
  },

  async signupConsentsPending(base) {
    const u = uid("perf-ath-022@perf.test");
    // Simulate "consented at signup, but the server-side sync could not record it yet": pending metadata, no rows.
    // session_replication_role=replica skips the auth.users signup-consent trigger for this one update (the local
    // postgres role does not own auth.users, so the trigger cannot be disabled).
    sql(`begin;
         set local session_replication_role = replica;
         delete from public.user_consents where user_id='${u}';
         update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data,'{}'::jsonb) || '{"legal_consent_pending":{"terms_of_service":{"version":1,"status":"accepted"},"privacy_policy":{"version":1,"status":"accepted"}}}'::jsonb where id='${u}';
         commit;
         update public.app_settings set legal_consent_gate_enabled = true where id = 1;`);
    try {
      const { ctx, page } = await newPage();
      await login(page, base, "perf-ath-022@perf.test");
      const d = await watchDialog(page, 6000);
      await ctx.close();
      const rows = sql(`select consent_type || ':' || count(*) from public.user_consents where user_id='${u}' group by consent_type order by 1`).split("\n").filter(Boolean);
      const pendingLeft = sql(`select coalesce(raw_user_meta_data ? 'legal_consent_pending', false) from auth.users where id='${u}'`);
      return { gateEver: d.ever, consentRows: rows.join(","), pendingMetadataLeft: pendingLeft === "t" };
    } finally {
      sql(`update public.app_settings set legal_consent_gate_enabled = false where id = 1;`);
    }
  },

  async accountSwitch(base) {
    const { ctx, page } = await newPage();
    await login(page, base, "perf-ath-023@perf.test");
    await page.waitForTimeout(2500);
    await page.locator('[aria-label*="Perf Athlete 023"]').locator("visible=true").first().click();
    await page.getByText("Log out", { exact: true }).locator("visible=true").first().click();
    await page.waitForURL((x) => x.pathname.includes("login"), { timeout: 20_000 });
    await login(page, base, "perf-coach-2@perf.test");
    await page.waitForTimeout(3000);
    const coachLabel = await page.locator('[aria-label*="Perf Coach Two"]').count();
    const staleLabel = await page.locator('[aria-label*="Perf Athlete 023"]').count();
    const out = { path: new URL(page.url()).pathname, newUserShown: coachLabel > 0, staleProfileShown: staleLabel > 0 };
    await ctx.close();
    return out;
  },

  async pendingApprovedInBackground(base) {
    const u = uid("perf-ath-024@perf.test");
    sql(`update public.profiles set approval_status='pending' where user_id='${u}'`);
    try {
      const { ctx, page } = await newPage();
      await login(page, base, "perf-ath-024@perf.test");
      const onPending = await waitForPath(page, /\/pending$/, 10_000);
      await setVisibility(page, "hidden");
      sql(`update public.profiles set approval_status='approved' where user_id='${u}'`);
      await page.waitForTimeout(HIDDEN_MS);
      await setVisibility(page, "visible");
      const leftPending = await waitForPath(page, /^\/(athlete\/)?(sessions|$)/, 10_000);
      const out = { startedOnPending: onPending, leftPendingAfterResume: leftPending, path: new URL(page.url()).pathname };
      await ctx.close();
      return out;
    } finally {
      sql(`update public.profiles set approval_status='approved' where user_id='${u}'`);
    }
  },

  async disabledInBackground(base) {
    const u = uid("perf-ath-025@perf.test");
    try {
      const { ctx, page } = await newPage();
      await login(page, base, "perf-ath-025@perf.test");
      await page.waitForTimeout(3000);
      await setVisibility(page, "hidden");
      sql(`update public.profiles set disabled_at = now() where user_id='${u}'`);
      await page.waitForTimeout(HIDDEN_MS);
      await setVisibility(page, "visible");
      const sentToDisabled = await waitForPath(page, /\/disabled$/, 10_000);
      const out = { sentToDisabledAfterResume: sentToDisabled, path: new URL(page.url()).pathname };
      await ctx.close();
      return out;
    } finally {
      sql(`update public.profiles set disabled_at = null, disabled_by = null where user_id='${u}'`);
    }
  },
};

let differ = 0;
for (const [name, fn] of Object.entries(scenarios)) {
  const a = await fn(A);
  const b = await fn(B);
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) differ += 1;
  console.log(`${ENGINE} ${name}: ${same ? "SAME" : "DIFFERENT"}\n    A ${JSON.stringify(a)}\n    B ${JSON.stringify(b)}`);
}
await browser.close();
console.log(differ === 0 ? "RESULT: identical auth/consent outcomes" : `RESULT: ${differ} scenario(s) differ`);
process.exit(differ === 0 ? 0 : 1);

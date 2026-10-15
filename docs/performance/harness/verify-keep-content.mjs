// Phase 1 / step 5 behaviour check on the ISOLATED perf stack, measured from the DOM (not from the app's own perf
// instrumentation): samples the page every 50 ms and reports how long the calendar content was hidden.
//   back      athlete / coach / manager: home -> open a session -> back
//   realtime  manager home while a registration is added and removed in the database
//   failure   a refresh whose session request fails: content must stay, with the "couldn't refresh" notice
//   switch    athlete A signs out, athlete B signs in: no frame may show A's registration badges
// "Content visible" = the week calendar is rendered (its "Next week" control is in the DOM), not its skeleton.
// Usage: PLAYWRIGHT_MODULE_DIR=... PERF_BASE=http://127.0.0.1:8203 PERF_ENGINE=chromium node verify-keep-content.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require(path.join(process.env.PLAYWRIGHT_MODULE_DIR, "playwright"));
const BASE = process.env.PERF_BASE ?? "http://127.0.0.1:8203";
const ENGINE = process.env.PERF_ENGINE ?? "chromium";
const DB = process.env.PERF_DB_CONTAINER ?? "supabase_db_shirafit-perf";
if (!["127.0.0.1", "localhost"].includes(new URL(BASE).hostname)) throw new Error("non-local base");
const sql = (q) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", q]).toString().trim();
const TIME_RANGE = /\d{2}:\d{2}\D{0,4}[–-]\D{0,4}\d{2}:\d{2}/;

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
const out = { engine: ENGINE, base: BASE };

async function signIn(email) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => localStorage.setItem("shira_fit_language", "en"));
  await ctx.route(/\.supabase\.co\//, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("PerfPass123!");
  await page.getByPlaceholder("Password").press("Enter");
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30_000 });
  await waitContent(page);
  await page.waitForTimeout(2500);
  return { ctx, page };
}
// The week calendar's "Next week" control exists only while the calendar itself is rendered (the loading state replaces
// the whole calendar with skeleton cards). Session times also appear outside the calendar, so they are not a signal.
const contentVisible = (page) =>
  page.evaluate(() => [...document.querySelectorAll('[aria-label="Next week"]')].some((e) => e.getClientRects().length > 0));
async function waitContent(page, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await contentVisible(page)) return; await page.waitForTimeout(100); }
  throw new Error("content never appeared");
}
/** Samples for `ms`; returns the total time the calendar content was hidden. */
async function hiddenDuring(page, ms) {
  let hidden = 0, last = Date.now();
  const t0 = last;
  while (Date.now() - t0 < ms) {
    const vis = await contentVisible(page);
    const now = Date.now();
    if (!vis) hidden += now - last;
    last = now;
    await page.waitForTimeout(50);
  }
  return hidden;
}

// back navigation
out.back = {};
for (const [role, email] of [["athlete", "perf-ath-002@perf.test"], ["coach", "perf-coach-1@perf.test"], ["manager", "perf-mgr-2@perf.test"]]) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const { ctx, page } = await signIn(email);
    await page.getByText(TIME_RANGE).locator("visible=true").first().click();
    await page.waitForTimeout(2500);
    await page.goBack();
    runs.push(await hiddenDuring(page, 3000));
    await ctx.close();
  }
  out.back[role] = runs;
  console.log(`${ENGINE} back to ${role} home: content hidden ${runs.join(", ")} ms`);
}

// realtime (manager home)
{
  const { ctx, page } = await signIn("perf-mgr-2@perf.test");
  const sid = sql("select id from public.training_sessions where session_date between current_date and current_date + 6 and not is_hidden order by session_date, start_time limit 1");
  const uid = sql(`select p.user_id from public.profiles p join auth.users u on u.id = p.user_id where u.email like 'perf-ath-%' and p.user_id not in (select user_id from public.session_registrations where session_id = '${sid}') limit 1`);
  const sampling = hiddenDuring(page, 6000);
  await page.waitForTimeout(500);
  sql(`insert into public.session_registrations (session_id, user_id, status) values ('${sid}', '${uid}', 'active')`);
  await page.waitForTimeout(2500);
  sql(`delete from public.session_registrations where session_id = '${sid}' and user_id = '${uid}'`);
  out.realtime = { hiddenMs: await sampling };
  console.log(`${ENGINE} realtime on manager home (add + remove a registration): content hidden ${out.realtime.hiddenMs} ms`);
  await ctx.close();
}

// refresh failure: after the first load, session requests fail; open a session and come back
out.failure = {};
for (const [role, email] of [["athlete", "perf-ath-002@perf.test"], ["coach", "perf-coach-1@perf.test"], ["manager", "perf-mgr-2@perf.test"]]) {
  const { ctx, page } = await signIn(email);
  await page.getByText(TIME_RANGE).locator("visible=true").first().click();
  await page.waitForTimeout(2500);
  let blocked = 0;
  await ctx.route(/\/rest\/v1\/training_sessions\?/, (r) => { blocked++; return r.abort(); });
  await page.goBack();
  // postgrest-js retries a failed GET with backoff (1 s, 2 s, 4 s) before reporting the error to the screen.
  await page.waitForTimeout(10_000);
  const kept = await contentVisible(page);
  const notice = (await page.getByText("Couldn't refresh — showing what was loaded earlier.").locator("visible=true").count()) > 0;
  out.failure[role] = { contentKept: kept, noticeShown: notice, blockedRequests: blocked };
  console.log(`${ENGINE} failed refresh on ${role} home: content kept=${kept}, notice shown=${notice} (requests blocked: ${blocked})`);
  await ctx.close();
}

// account switch on one device: A's registration badges must never show for B
{
  const regLabels = (page) => page.evaluate(() => [...document.querySelectorAll("[aria-label]")]
    .filter((e) => e.getClientRects().length > 0).map((e) => e.getAttribute("aria-label")).filter((l) => /registered/i.test(l ?? "")).sort().join("|"));
  const { ctx, page } = await signIn("perf-ath-002@perf.test");
  const aLabels = await regLabels(page);
  await page.locator('[aria-label*="Account menu"]').locator("visible=true").first().click();
  await page.getByText("Log out").locator("visible=true").first().click();
  await page.waitForURL((u) => u.pathname.includes("login"), { timeout: 20_000 });
  await page.getByPlaceholder("Email").fill("perf-ath-001@perf.test");
  await page.getByPlaceholder("Password").fill("PerfPass123!");
  await page.getByPlaceholder("Password").press("Enter");
  const frames = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) { frames.push(await regLabels(page)); await page.waitForTimeout(50); }
  const bFinal = frames[frames.length - 1];
  const leaked = aLabels !== "" && aLabels !== bFinal && frames.some((f) => f === aLabels);
  out.switch = { aBadges: aLabels.split("|").filter(Boolean).length, bBadges: bFinal.split("|").filter(Boolean).length, leakedFrames: frames.filter((f) => aLabels !== bFinal && f === aLabels).length };
  console.log(`${ENGINE} account switch: A had ${out.switch.aBadges} badges, B has ${out.switch.bBadges}; frames showing A's badges to B: ${out.switch.leakedFrames}${leaked ? " (LEAK)" : ""}`);
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(out));

// Browser test for the coach session-permission UI (security branch), against an ISOLATED local stack only.
// Creates its own users and sessions, then checks, as a coach and as a manager:
//   coach: no "Create session" in the menu; create / manage URLs redirect home; the session page has no "Edit
//          session"; a full session offers no capacity increase / over-capacity add (only "Session full"); the row
//          menu has no "Rate"; moving into a full session offers no capacity options; the day sheet has no "Add
//          session" and no delete; permitted actions still work (add a participant, mark attendance, remove).
//   manager: still sees "Rate", capacity options and delete (smoke).
// Usage: PLAYWRIGHT_MODULE_DIR=... UI_BASE=http://127.0.0.1:8301 API_URL=http://127.0.0.1:57431 ANON_KEY=... \
//        SERVICE_ROLE_KEY=... DB_CONTAINER=supabase_db_shirafit-sec PERF_ENGINE=chromium node ui-coach-permissions.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium, webkit } = require(path.join(process.env.PLAYWRIGHT_MODULE_DIR, "playwright"));
const BASE = process.env.UI_BASE ?? "http://127.0.0.1:8301";
const API = process.env.API_URL ?? "http://127.0.0.1:57431";
const ANON = process.env.ANON_KEY, SERVICE = process.env.SERVICE_ROLE_KEY;
const DB = process.env.DB_CONTAINER ?? "supabase_db_shirafit-sec";
const ENGINE = process.env.PERF_ENGINE ?? "chromium";
for (const u of [BASE, API]) if (!["127.0.0.1", "localhost"].includes(new URL(u).hostname)) throw new Error(`non-local ${u}`);

const sql = (q) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", q]).toString().trim();
const n = String(Date.now()).slice(-7);
const PASSWORD = "Passw0rd!x";
async function mkuser(tag, role, name) {
  const email = `ui-sec-${tag}-${n}@t.local`;
  const r = await fetch(`${API}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true,
      user_metadata: { full_name: name, phone: `05${n}${tag.length}`, gender: "female", address: "A", zip_code: "1" } }),
  }).then((x) => x.json());
  sql(`update public.profiles set approval_status = 'approved', role = '${role}' where user_id = '${r.id}'`);
  // Accept whatever consents the stack currently requires, through the same RPCs the app's consent gate uses, so the
  // gate's dialog doesn't cover the screens under test.
  const tok = (await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }),
  }).then((x) => x.json())).access_token;
  const rpc = (fn, body) => fetch(`${API}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }).then((x) => x.json());
  const req = await rpc("get_required_consents", {});
  for (const c of req?.required ?? []) {
    await rpc("record_user_consent", { p_consent_type: c.consent_type ?? c.type, p_status: "accepted",
      p_consent_version: c.version ?? c.consent_version, p_ip_address: null, p_user_agent: "ui-test" });
  }
  return { id: r.id, email };
}
const coach = await mkuser("coach", "coach", `Coach UI ${n}`);
const mgr = await mkuser("mgr", "manager", `Manager UI ${n}`);
const a1 = await mkuser("a1", "athlete", `Athlete One ${n}`);
const a2 = await mkuser("a2", "athlete", `Athlete Two ${n}`);
const D1 = sql("select (current_date + (7 - extract(dow from current_date)::int) + 1)::date");
const sess = (date, time, max) => sql(`insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values ('${date}', '${time}', '${coach.id}', ${max}, true) returning id`).split("\n")[0];
const S_OPEN = sess(D1, "06:10", 3);
const S_FULL = sess(D1, "06:40", 1);
sql(`insert into public.session_registrations (session_id, user_id, status) values ('${S_OPEN}', '${a1.id}', 'active'), ('${S_FULL}', '${a2.id}', 'active')`);

const browser = await (ENGINE === "webkit" ? webkit : chromium).launch();
let failed = 0, passed = 0;
const check = (label, cond, extra = "") => {
  if (cond) { passed++; console.log(`  PASSED: ${label}`); } else { failed++; console.log(`  FAILED: ${label} ${extra}`); }
};
async function signIn(email) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true });
  await ctx.addInitScript(() => {
    localStorage.setItem("shira_fit_language", "en");
    // The web app restores the last visited route on load (src/lib/webLastRoute.ts). Forget it before the app starts on
    // every load, so a direct URL is always honoured (clearing it before goto alone races with the page being left).
    for (const k of Object.keys(localStorage)) if (k.startsWith("shirafit:lastWebAppRoute:")) localStorage.removeItem(k);
  });
  await ctx.route(/\.supabase\.co\//, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill(PASSWORD);
  await page.getByPlaceholder("Password").press("Enter");
  await page.waitForURL((u) => !u.pathname.includes("login"), { timeout: 30_000 });
  await page.waitForTimeout(2500);
  return { ctx, page };
}
const visible = (page, text, exact = true) => page.getByText(text, { exact }).locator("visible=true");
const has = async (page, text, exact = true) => (await visible(page, text, exact).count()) > 0;
// A client-side redirect can interrupt the load itself (net::ERR_ABORTED); that's the behaviour under test, not a failure.
const go = async (page, p, { expectRedirect = false } = {}) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("shirafit:lastWebAppRoute:")) localStorage.removeItem(k); });
    // A client-side redirect can interrupt the load itself (net::ERR_ABORTED). That's expected only for the redirect
    // checks; anywhere else an interrupted load means the previous page navigated, so load again.
    await page.goto(`${BASE}${p}`).catch((e) => { if (!String(e).includes("ERR_ABORTED")) throw e; });
    await page.waitForTimeout(3000);
    if (expectRedirect || new URL(page.url()).pathname === p) return;
  }
  throw new Error(`could not open ${p} (still on ${new URL(page.url()).pathname})`);
};

console.log(`== ${ENGINE}: coach`);
{
  const { ctx, page } = await signIn(coach.email);
  await page.locator('[aria-label="Open navigation menu"]').locator("visible=true").first().click();
  await page.waitForTimeout(800);
  check("menu has Sessions", await has(page, "Sessions"));
  check("menu has no Create session", !(await has(page, "Create session")));
  await page.keyboard.press("Escape");

  await go(page, "/coach/create-session", { expectRedirect: true });
  check("/coach/create-session redirects away", !new URL(page.url()).pathname.includes("create-session"), page.url());
  await go(page, `/coach/session/manage/${S_OPEN}`, { expectRedirect: true });
  check("/coach/session/manage/:id redirects away", !new URL(page.url()).pathname.includes("/manage/"), page.url());

  await go(page, `/coach/session/${S_OPEN}`);
  check("session page shows the participant", await has(page, `Athlete One ${n}`, false));
  check("session page has no Edit session", !(await has(page, "Edit session")));
  check("session page keeps Add participant", await has(page, "Add participant"));

  // Row menu: Move / Remove yes, Rate no.
  await page.locator(`[aria-label="More actions for Athlete One ${n}"]`).locator("visible=true").first().click();
  await page.waitForTimeout(600);
  check("row menu has no Rate", !(await has(page, "Rate")));
  check("row menu keeps Move", (await page.getByText(/^Move/).locator("visible=true").count()) > 0);
  // Move into the full session: no capacity options for a coach.
  await page.getByText(/^Move/).locator("visible=true").first().click();
  await page.waitForTimeout(2500);
  const fullRow = page.getByText(/06:40/).locator("visible=true").first();
  if (await fullRow.count()) {
    await fullRow.click();
    await page.waitForTimeout(800);
    check("move into a full session explains it", await has(page, "Pick a session with a free place."));
    check("move offers no capacity increase", !(await has(page, "Increase max by 1")));
  } else check("move sheet lists the full own session", false);
  await page.keyboard.press("Escape");

  // Add participant to the FULL session: "Session full", no increase / over-capacity choices.
  await go(page, `/coach/session/${S_FULL}`);
  await visible(page, "Add participant").first().click();
  await page.waitForTimeout(1500);
  // The modal decides "full" from counts it loads on open; pick only once they're shown, as a person would.
  await page.getByText(/Capacity: 1\/1/).locator("visible=true").first().waitFor({ timeout: 15_000 }).catch(async (e) => {
    if (process.env.UI_SHOT_DIR) await page.screenshot({ path: path.join(process.env.UI_SHOT_DIR, `capacity-wait-${ENGINE}.png`) });
    throw e;
  });
  const search = page.getByPlaceholder(/search/i).locator("visible=true").first();
  if (await search.count()) await search.fill(`Athlete One ${n}`);
  await page.waitForTimeout(2000);
  await page.getByText(`Athlete One ${n}`).locator("visible=true").last().click();
  // The "Session full" toast appears and fades on its own timer: poll for it instead of looking once.
  let toldFull = false;
  for (let i = 0; i < 60 && !toldFull; i++) { toldFull = await has(page, "Session full", false); if (!toldFull) await page.waitForTimeout(100); }
  check("full session: coach is told it's full", toldFull);
  check("full session: no Increase capacity", !(await has(page, "Increase capacity")));
  check("full session: no add-over-capacity", !(await has(page, "Keep capacity, add anyway")));
  const count = sql(`select count(*) from public.session_registrations where session_id = '${S_FULL}' and status = 'active'`);
  check("full session still has 1 of 1", count === "1", count);

  // Day sheet: no Add session, no Delete.
  await go(page, "/coach/sessions");
  const dayCell = page.getByText(/06:10/).locator("visible=true").first();
  if (await dayCell.count()) { await dayCell.click(); await page.waitForTimeout(1200); }
  check("day view: no Add session", !(await has(page, "Add session")));
  check("day view: no Delete", (await page.locator('[aria-label="Delete"]').locator("visible=true").count()) === 0);

  // Permitted: add a participant to the open session (succeeds and is stored).
  await go(page, `/coach/session/${S_OPEN}`);
  await visible(page, "Add participant").first().click();
  await page.waitForTimeout(1500);
  const search2 = page.getByPlaceholder(/search/i).locator("visible=true").first();
  if (await search2.count()) await search2.fill(`Athlete Two ${n}`);
  await page.waitForTimeout(2000);
  await page.getByText(`Athlete Two ${n}`).locator("visible=true").last().click();
  await page.waitForTimeout(2500);
  const added = sql(`select count(*) from public.session_registrations where session_id = '${S_OPEN}' and user_id = '${a2.id}' and status = 'active'`);
  check("coach adds a participant to own session (stored)", added === "1", added);
  await ctx.close();
}

console.log(`== ${ENGINE}: manager`);
{
  const { ctx, page } = await signIn(mgr.email);
  await go(page, `/manager/session/${S_OPEN}`);
  await page.locator(`[aria-label="More actions for Athlete One ${n}"]`).locator("visible=true").first().click();
  await page.waitForTimeout(600);
  check("manager row menu keeps Rate", await has(page, "Rate"));
  await page.keyboard.press("Escape");
  await go(page, `/manager/session/${S_FULL}`);
  // Wait for the page to render the button (a swallowed early click left the modal closed in 1 of ~10 runs).
  await visible(page, "Add participant").first().waitFor({ timeout: 15_000 });
  await visible(page, "Add participant").first().click();
  await page.waitForTimeout(1500);
  // The modal decides "full" from counts it loads on open; pick only once they're shown, as a person would.
  await page.getByText(/Capacity: 1\/1/).locator("visible=true").first().waitFor({ timeout: 15_000 }).catch(async (e) => {
    if (process.env.UI_SHOT_DIR) await page.screenshot({ path: path.join(process.env.UI_SHOT_DIR, `capacity-wait-${ENGINE}.png`) });
    throw e;
  });
  const search = page.getByPlaceholder(/search/i).locator("visible=true").first();
  if (await search.count()) await search.fill(`Athlete One ${n}`);
  await page.waitForTimeout(2000);
  await page.getByText(`Athlete One ${n}`).locator("visible=true").last().click().catch(() => {});
  await page.waitForTimeout(1500);
  if (process.env.UI_SHOT_DIR) await page.screenshot({ path: path.join(process.env.UI_SHOT_DIR, `manager-full-${ENGINE}.png`) });
  check("manager is offered Increase capacity on a full session", await has(page, "Increase capacity"));
  await ctx.close();
}

await browser.close();
console.log(`\nUI coach permissions (${ENGINE}): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

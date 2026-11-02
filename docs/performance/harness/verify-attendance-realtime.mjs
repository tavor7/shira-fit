// Two connected staff users on the same session (ISOLATED perf stack only): a manager and the session's coach.
//   R1 manager marks the first roster row Absent      -> time until the coach's screen shows it
//   R2 coach sets it back to Not set                  -> time until the manager's screen shows it (the manager skipped the
//                                                         echo of its own R1 write; this proves later changes still arrive)
//   R3 an athlete registers through the API           -> both rosters gain the participant
//   R4 the athlete cancels                            -> both rosters drop them; the manager's cancellations list updates
// Synthetic registrations / cancellations are removed afterwards so every run starts from the same data.
// Usage: PLAYWRIGHT_MODULE_DIR=… BASE=http://127.0.0.1:<port> ANON=<local anon key> ENGINE=chromium|webkit node verify-attendance-realtime.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
const pw = require(path.join(process.env.PLAYWRIGHT_MODULE_DIR ?? "", "playwright"));
const BASE = process.env.BASE;
const API = "http://127.0.0.1:57421";
const ANON = process.env.ANON;
if (!/^http:\/\/127\.0\.0\.1:/.test(BASE ?? "")) throw new Error("local targets only");
const psql = (q) =>
  execFileSync("docker", ["exec", "-i", "supabase_db_shirafit-perf", "psql", "-U", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();

const SID = psql(`select s.id from training_sessions s join auth.users u on u.id = s.coach_id
  where u.email = 'perf-coach-1@perf.test' and s.session_date between current_date + 1 and current_date + 6
    and s.is_open_for_registration and not s.is_hidden
    and (select count(*) from session_registrations r where r.session_id = s.id and r.status = 'active') between 2 and s.max_participants - 2
  order by s.session_date, s.start_time limit 1`);
if (!SID) throw new Error("no suitable coach session in the next 6 days");
const ATHLETE = "perf-ath-157@perf.test";
psql(`delete from cancellations c using auth.users u where c.session_id = '${SID}' and c.user_id = u.id and u.email = '${ATHLETE}';
      delete from session_registrations r using auth.users u where r.session_id = '${SID}' and r.user_id = u.id and u.email = '${ATHLETE}';`);

const browser = await pw[process.env.ENGINE ?? "chromium"].launch({ headless: true });
async function open(email, p) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, hasTouch: true, ignoreHTTPSErrors: true });
  await ctx.addInitScript(() => localStorage.setItem("shira_fit_language", "en"));
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.waitForTimeout(3000);
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("PerfPass123!");
  await page.getByText("Sign in", { exact: true }).click();
  await page.waitForTimeout(6000);
  await page.goto(`${BASE}${p}`);
  await page.waitForTimeout(6000);
  return page;
}
const firstRadio = (page, name) => page.getByRole("radio", { name }).locator("visible=true").first();
const checked = async (page, name) => (await firstRadio(page, name).getAttribute("aria-checked")) === "true";
const hasText = async (page, re) => (await page.getByText(re).locator("visible=true").count()) > 0;
async function until(fn, timeoutMs = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}
async function token(email) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "PerfPass123!" }),
  });
  return (await r.json()).access_token;
}
async function rpc(tok, fn, args) {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return r.json();
}

const out = { engine: process.env.ENGINE ?? "chromium", base: BASE };
const mgr = await open("perf-mgr-2@perf.test", `/manager/session/${SID}`);
const coach = await open("perf-coach-1@perf.test", `/coach/session/${SID}`);
try {
  // R1
  await firstRadio(mgr, "Absent").click();
  out.R1_manager_sees_own_change_ms = await until(() => checked(mgr, "Absent"));
  out.R1_coach_sees_it_ms = await until(() => checked(coach, "Absent"));
  // R2
  await mgr.waitForTimeout(1500);
  await firstRadio(coach, "Not set").click();
  out.R2_coach_sees_own_change_ms = await until(() => checked(coach, "Not set"));
  out.R2_manager_sees_it_ms = await until(() => checked(mgr, "Not set"));
  // R3 / R4
  const name = psql(`select full_name from profiles p join auth.users u on u.id = p.user_id where u.email = '${ATHLETE}'`);
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const tok = await token(ATHLETE);
  const reg = await rpc(tok, "register_for_session", { p_session_id: SID, p_accept_extra_subscription_charge: false });
  out.R3_register = reg?.ok === true ? "ok" : JSON.stringify(reg).slice(0, 80);
  out.R3_manager_roster_shows_athlete_ms = await until(() => hasText(mgr, re));
  out.R3_coach_roster_shows_athlete_ms = await until(() => hasText(coach, re));
  const can = await rpc(tok, "cancel_registration", { p_session_id: SID, p_reason: "perf harness cleanup" });
  out.R4_cancel = can?.ok === true ? "ok" : JSON.stringify(can).slice(0, 80);
  out.R4_manager_cancellations_list_shows_it_ms = await until(() => hasText(mgr, /perf harness cleanup/));
  out.R4_coach_roster_drops_athlete_ms = await until(async () => !(await hasText(coach, re)));
} finally {
  psql(`delete from cancellations c using auth.users u where c.session_id = '${SID}' and c.user_id = u.id and u.email = '${ATHLETE}';
        delete from session_registrations r using auth.users u where r.session_id = '${SID}' and r.user_id = u.id and u.email = '${ATHLETE}';`);
  await browser.close();
}
console.log(JSON.stringify(out));

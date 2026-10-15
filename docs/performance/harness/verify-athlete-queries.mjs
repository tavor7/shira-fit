// Equivalence check for Performance Phase 1 / step 3 on the ISOLATED perf stack: for many synthetic athletes, signed in
// through the real Auth/PostgREST/RLS path, the OLD athlete queries (session ids in the URL) and the NEW ones (fixed-size
// URLs) must return exactly the same sessions.
//   calendar:    old = my active registration ids → training_sessions or(is_hidden=false, id in ids) ≤ browse end
//                new = training_sessions is_hidden=false ≤ end  ∪  session_registrations(me, active) → hidden sessions ≤ end
//   my sessions: old = my active registration ids → training_sessions id in ids
//                new = session_registrations(me, active) → training_sessions (inner join)
//   badges:      old = my regs / waitlist filtered by `session_id in (calendar ids)`; new = all mine, filtered client-side
// Usage: PERF_ANON_KEY=... node verify-athlete-queries.mjs [count=20]
import { execFileSync } from "node:child_process";

const API = process.env.PERF_DIRECT_API ?? "http://127.0.0.1:57421";
const KEY = process.env.PERF_ANON_KEY ?? "";
const COUNT = Number(process.argv[2] ?? 20);
if (!["127.0.0.1", "localhost"].includes(new URL(API).hostname)) throw new Error("refusing non-local API");
const psql = (q) => execFileSync("docker", ["exec", "-i", "supabase_db_shirafit-perf", "psql", "-U", "postgres", "-At", "-c", q], { encoding: "utf8" }).trim();
if (psql("select count(*) from auth.users where email not like '%@perf.test'") !== "0") throw new Error("not the perf database");
const END = psql("select ((timezone('Asia/Jerusalem', now()))::date - extract(dow from (timezone('Asia/Jerusalem', now()))::date)::int + 13)::text");
const SELECT = "*,trainer:profiles!coach_id(full_name,calendar_color)";

async function token(email) {
  const r = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "PerfPass123!" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login ${email}: ${JSON.stringify(j)}`);
  return { tok: j.access_token, uid: j.user.id };
}
async function get(tok, pathAndQuery) {
  const r = await fetch(`${API}/rest/v1/${pathAndQuery}`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`${r.status} ${pathAndQuery.slice(0, 80)}: ${await r.text()}`);
  return { rows: await r.json(), urlLength: `${API}/rest/v1/${pathAndQuery}`.length };
}
const key = (s) => `${s.session_date}|${s.start_time}|${s.id}`;
/** Canonical JSON (keys sorted at every level): embedded rows come back with keys in a different order, same values. */
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const unwrap = (r) => (Array.isArray(r.training_sessions) ? r.training_sessions[0] : r.training_sessions);

let failures = 0;
let maxOldUrl = 0;
let maxNewUrl = 0;
let hiddenCovered = 0;
for (let n = 1; n <= COUNT; n++) {
  const email = `perf-ath-${String(n).padStart(3, "0")}@perf.test`;
  const { tok, uid } = await token(email);
  const regs = await get(tok, `session_registrations?select=session_id&user_id=eq.${uid}&status=eq.active`);
  const ids = regs.rows.map((r) => r.session_id);

  // calendar
  const oldCal = ids.length
    ? await get(tok, `training_sessions?select=${SELECT}&or=(is_hidden.eq.false,id.in.(${ids.join(",")}))&session_date=lte.${END}&order=session_date,start_time`)
    : await get(tok, `training_sessions?select=${SELECT}&is_hidden=eq.false&session_date=lte.${END}&order=session_date,start_time`);
  const vis = await get(tok, `training_sessions?select=${SELECT}&is_hidden=eq.false&session_date=lte.${END}&order=session_date,start_time`);
  const mine = await get(tok, `session_registrations?select=training_sessions!inner(${SELECT})&user_id=eq.${uid}&status=eq.active&training_sessions.is_hidden=eq.true&training_sessions.session_date=lte.${END}`);
  const newMap = new Map(vis.rows.map((s) => [s.id, s]));
  for (const r of mine.rows) { const s = unwrap(r); if (s?.id) newMap.set(s.id, s); }
  const oldKeys = oldCal.rows.map(key).sort();
  const newKeys = [...newMap.values()].map(key).sort();
  const calSame = JSON.stringify(oldKeys) === JSON.stringify(newKeys);
  const fieldsSame = oldCal.rows.every((o) => JSON.stringify(canon(o)) === JSON.stringify(canon(newMap.get(o.id))));
  hiddenCovered += mine.rows.length;

  // my sessions
  const oldMy = ids.length ? await get(tok, `training_sessions?select=id,session_date,start_time,duration_minutes,is_kickbox&id=in.(${ids.join(",")})`) : { rows: [], urlLength: 0 };
  const newMy = await get(tok, `session_registrations?select=training_sessions!inner(id,session_date,start_time,duration_minutes,is_kickbox)&user_id=eq.${uid}&status=eq.active`);
  const mySame = JSON.stringify(oldMy.rows.map(key).sort()) === JSON.stringify(newMy.rows.map(unwrap).map(key).sort());

  // badges (registered / waitlisted among calendar sessions)
  const calIds = oldCal.rows.map((s) => s.id);
  const calSet = new Set(calIds);
  const oldBadge = calIds.length ? await get(tok, `session_registrations?select=session_id&user_id=eq.${uid}&status=eq.active&session_id=in.(${calIds.join(",")})`) : { rows: [], urlLength: 0 };
  const oldWait = calIds.length ? await get(tok, `waitlist_requests?select=session_id&user_id=eq.${uid}&session_id=in.(${calIds.join(",")})`) : { rows: [], urlLength: 0 };
  const allWait = await get(tok, `waitlist_requests?select=session_id&user_id=eq.${uid}`);
  const badgeSame =
    JSON.stringify(oldBadge.rows.map((r) => r.session_id).sort()) === JSON.stringify(ids.filter((i) => calSet.has(i)).sort()) &&
    JSON.stringify(oldWait.rows.map((r) => r.session_id).sort()) === JSON.stringify(allWait.rows.map((r) => r.session_id).filter((i) => calSet.has(i)).sort());

  maxOldUrl = Math.max(maxOldUrl, oldCal.urlLength, oldMy.urlLength, oldBadge.urlLength, oldWait.urlLength);
  maxNewUrl = Math.max(maxNewUrl, vis.urlLength, mine.urlLength, newMy.urlLength, regs.urlLength, allWait.urlLength);
  const ok = calSame && fieldsSame && mySame && badgeSame;
  if (!ok) failures += 1;
  console.log(`${email}: ${ok ? "SAME" : "DIFFERENT"} | calendar ${oldKeys.length} vs ${newKeys.length}${fieldsSame ? "" : " (fields differ)"} | hidden-registered ${mine.rows.length} | my-sessions ${oldMy.rows.length} vs ${newMy.rows.length} | badges ${badgeSame ? "same" : "DIFFER"}`);
}
console.log(`longest URL: old ${maxOldUrl} chars, new ${maxNewUrl} chars; hidden registered sessions exercised: ${hiddenCovered}`);
console.log(failures === 0 ? `RESULT: identical results for ${COUNT} athletes` : `RESULT: ${failures} athlete(s) differ`);
process.exit(failures === 0 ? 0 : 1);

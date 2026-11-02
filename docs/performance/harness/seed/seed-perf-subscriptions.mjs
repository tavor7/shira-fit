// Seeds subscriptions on the ISOLATED perf stack through the app's own create_subscription RPC, signed in as a synthetic
// manager, so every row passes the real server validation (no direct inserts into financial tables).
// Production had 17 subscriptions on 2026-10-31; this creates 60 (≈3.5×) to test growth.
//
// Usage: PERF_SUPABASE_URL=http://127.0.0.1:57421 PERF_ANON_KEY=<local anon> node seed-perf-subscriptions.mjs
// Refuses non-localhost URLs. Idempotent: athletes that already have an active subscription are skipped by the server.

const URL_ = process.env.PERF_SUPABASE_URL ?? "http://127.0.0.1:57421";
const ANON = process.env.PERF_ANON_KEY ?? "";
const PASSWORD = process.env.PERF_PASSWORD ?? "PerfPass123!";
const COUNT = Number(process.env.PERF_SUBSCRIPTIONS ?? 60);
if (!["127.0.0.1", "localhost"].includes(new URL(URL_).hostname)) throw new Error(`refusing non-local target ${URL_}`);

async function token(email) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`token ${email}: ${res.status}`);
  return (await res.json()).access_token;
}

async function call(tok, path, body, method = "POST") {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { apikey: ANON, Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const mgr = await token("perf-mgr-2@perf.test");
const emails = Array.from({ length: COUNT }, (_, i) => `perf-ath-${String(i + 1).padStart(3, "0")}@perf.test`);
const { json: users } = await call(
  mgr,
  `/rest/v1/profiles?select=user_id,username&role=eq.athlete&limit=1000`,
  null,
  "GET"
);
const idByEmail = {};
for (const e of emails) {
  const t = await token(e).catch(() => null);
  if (!t) continue;
  const me = await call(t, "/auth/v1/user", null, "GET");
  idByEmail[e] = me.json?.id;
}
const today = new Date();
let ok = 0;
let failed = 0;
for (const [i, e] of emails.entries()) {
  const id = idByEmail[e];
  if (!id) continue;
  const start = new Date(today.getTime() - (14 + (i % 8) * 7) * 86400000).toISOString().slice(0, 10);
  const groupLimit = 1 + (i % 3);
  const res = await call(mgr, "/rest/v1/rpc/create_subscription", {
    p_payee_id: id,
    p_payee_is_manual: false,
    p_monthly_price_ils: 300 + groupLimit * 100,
    p_start_date: start,
    p_end_date: null,
    p_anchor_day: null,
    p_allowances: [
      { tier: "personal", weekly_limit: 0 },
      { tier: "pair", weekly_limit: 0 },
      { tier: "trio", weekly_limit: 0 },
      { tier: "quartet", weekly_limit: 0 },
      { tier: "quintet", weekly_limit: 0 },
      { tier: "sextet", weekly_limit: 0 },
      { tier: "group", weekly_limit: groupLimit },
    ],
    p_initial_payment_amount_ils: i % 2 === 0 ? 300 + groupLimit * 100 : null,
    p_initial_payment_method: i % 2 === 0 ? "cash" : null,
    p_initial_payment_payer_name: null,
    p_initial_payment_note: null,
    p_initial_payment_client_request_id: null,
  });
  if (res.json?.ok) ok += 1;
  else {
    failed += 1;
    if (failed <= 3) console.log(`create_subscription ${e}:`, JSON.stringify(res.json).slice(0, 200));
  }
}
console.log(`subscriptions created: ${ok}, not created: ${failed} (users listed: ${users?.length ?? 0})`);

// Creates the synthetic @perf.test accounts on the ISOLATED local performance stack (see docs/performance/README.md).
// Usage: PERF_SUPABASE_URL=http://127.0.0.1:57421 PERF_SERVICE_ROLE_KEY=... node create-perf-users.mjs
// Refuses to run against anything that is not localhost. Never point it at the hosted project.

const url = process.env.PERF_SUPABASE_URL ?? "";
const serviceKey = process.env.PERF_SERVICE_ROLE_KEY ?? "";
const password = process.env.PERF_PASSWORD ?? "PerfPass123!";

const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (host !== "127.0.0.1" && host !== "localhost") {
  console.error(`Refusing to run: PERF_SUPABASE_URL must be a localhost URL, got "${url}".`);
  process.exit(2);
}
if (!serviceKey) {
  console.error("PERF_SERVICE_ROLE_KEY is required (from `supabase status -o env` in the perf stack workdir).");
  process.exit(2);
}

/** Same population shape as production on 2026-10-15: 3 managers (1 super user), 3 coaches, 157 athletes. */
const accounts = [
  { email: "perf-mgr-1@perf.test", fullName: "Perf Manager One" },
  { email: "perf-mgr-2@perf.test", fullName: "Perf Manager Two" },
  { email: "perf-mgr-3@perf.test", fullName: "Perf Manager Three" },
  { email: "perf-coach-1@perf.test", fullName: "Perf Coach One" },
  { email: "perf-coach-2@perf.test", fullName: "Perf Coach Two" },
  { email: "perf-coach-3@perf.test", fullName: "Perf Coach Three" },
  ...Array.from({ length: 157 }, (_, i) => {
    const n = String(i + 1).padStart(3, "0");
    return { email: `perf-ath-${n}@perf.test`, fullName: `Perf Athlete ${n}` };
  }),
];

async function createUser(a, i) {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: a.email,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: a.fullName,
        phone: `0500${String(100000 + i).slice(-6)}`,
        gender: i % 5 === 0 ? "male" : "female",
        date_of_birth: `${1975 + (i % 30)}-0${1 + (i % 9)}-1${i % 9}`,
        address: "Perf Street 1",
        zip_code: "1234567",
      },
    }),
  });
  if (res.status === 422) return "exists";
  if (!res.ok) throw new Error(`${a.email}: HTTP ${res.status} ${await res.text()}`);
  return "created";
}

let created = 0;
let existing = 0;
for (const [i, a] of accounts.entries()) {
  const r = await createUser(a, i);
  if (r === "created") created += 1;
  else existing += 1;
}
console.log(`perf users: ${created} created, ${existing} already existed, ${accounts.length} total`);

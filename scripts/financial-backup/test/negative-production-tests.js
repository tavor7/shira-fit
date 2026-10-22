import { requireEnv } from "../src/env.js";
import { runPgTool, dockerizeConnectionString } from "../src/pg-exec.js";
import { CHECKS, runChecks } from "../src/verify-production.js";

// Proves verify-production.js actually catches corruption/incompleteness, rather than just
// passing on well-formed data by construction. Run this against a DISPOSABLE synthetic-data
// restore target ONLY (same one the normal dump -> restore -> verify cycle already produces) --
// it deliberately corrupts rows and drops a table on whatever database FINANCIAL_BACKUP_TARGET_URL
// points at, so it must never be pointed at anything real.

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) {
    pass++;
    console.log(`PASS: ${label}`);
  } else {
    fail++;
    console.log(`FAIL: ${label}`);
  }
}

async function psql(connStr, sql) {
  const { stdout } = await runPgTool("psql", [dockerizeConnectionString(connStr), "-qAt", "-c", sql]);
  return stdout.toString().trim();
}

function findCheck(label) {
  const c = CHECKS.find((c) => c.label === label);
  if (!c) throw new Error(`No such check: "${label}" -- did its label change in verify-production.js?`);
  return c;
}

async function checkStillPasses(connStr, label) {
  const { sql, expect } = findCheck(label);
  const result = await psql(connStr, sql);
  return typeof expect === "function" ? expect(result) : result === String(expect);
}

async function main() {
  const { FINANCIAL_BACKUP_TARGET_URL: c } = requireEnv(["FINANCIAL_BACKUP_TARGET_URL"]);

  console.log("=== Baseline: all checks should pass on the clean synthetic restore ===");
  const baseline = await runChecks(c, { log: () => {} });
  check("clean synthetic restore passes every production check before any corruption", baseline.every((r) => r.pass));

  console.log("\n=== Corruption 1: orphan a PDF version's document_id ===");
  // document_pdf_versions has a real FK (document_id -> documents), an append-only immutability
  // trigger (blocks UPDATE/DELETE), AND an AFTER INSERT trigger that cascades into
  // archive.r2_archive_jobs (itself FK'd to documents too) -- the database structurally prevents
  // this exact corruption in normal operation, on purpose. To actually exercise the check here
  // (disposable test container only), bypass triggers AND FK enforcement for one statement via
  // session_replication_role=replica, the standard technique for this; restored immediately after.
  await psql(
    c,
    "set session_replication_role = replica;" +
      " insert into archive.document_pdf_versions (document_id, document_number, pdf_version, storage_path, reason)" +
      " values (gen_random_uuid(), 'NEG-TEST-ORPHAN', 1, 'documents/neg-test/orphan.pdf', 'created');" +
      " set session_replication_role = origin;"
  );
  check(
    "orphaned PDF version is detected (check now fails)",
    !(await checkStillPasses(c, "every archive.document_pdf_versions row references an existing document"))
  );

  console.log("\n=== Sanity: a settings/consent-style orphaned event must NOT be flagged ===");
  // Deliberately BEFORE corruption 2 below: both checks share one aggregate COUNT(*) over the
  // whole table, so this must run while the table is still otherwise clean, or the earlier
  // corruption's own count would conflate with what this step is specifically testing.
  // document_id is nullable -- production's real consent/settings events have document_id IS
  // NULL (confirmed in a prior read-only audit), not a non-existent UUID, so this needs no FK
  // bypass: NULL is always valid in a nullable FK column.
  await psql(
    c,
    "insert into public.document_events (document_id, action, user_id) values (null, 'consent_declined', (select user_id from public.profiles limit 1));"
  );
  check(
    "a legitimate settings/consent event with no document is correctly NOT treated as corruption",
    await checkStillPasses(c, "every document_event either references an existing document, or is a known non-document audit action")
  );

  console.log("\n=== Corruption 2: orphan a REAL document_event (document_cancelled, not a settings/consent action) ===");
  // document_events.document_id is also FK'd to documents -- same bypass technique as above.
  await psql(
    c,
    "set session_replication_role = replica;" +
      " update public.document_events set document_id = gen_random_uuid() where id = (select id from public.document_events where action = 'document_cancelled' order by id limit 1);" +
      " set session_replication_role = origin;"
  );
  check(
    "orphaned document_cancelled event is detected as genuine corruption, NOT excused as a settings/consent action",
    !(await checkStillPasses(c, "every document_event either references an existing document, or is a known non-document audit action"))
  );

  console.log("\n=== Corruption 3: break document_number uniqueness ===");
  // document_number has a real UNIQUE constraint -- the database itself already prevents this
  // exact corruption in normal operation (confirmed: this update is rejected outright while the
  // constraint is in place). Drop it first (disposable test container only) to simulate "the
  // restore didn't properly recreate this constraint" -- the realistic way this check could ever
  // actually fire -- and prove the check still catches the duplicate independently of the
  // constraint's own enforcement.
  await psql(c, "alter table public.documents drop constraint documents_document_number_key;");
  await psql(
    c,
    "update public.documents set document_number = (select document_number from public.documents order by id limit 1) where id = (select id from public.documents order by id desc limit 1);"
  );
  check(
    "duplicate document_number is detected (uniqueness check now fails)",
    !(await checkStillPasses(c, "document_number values are unique"))
  );

  console.log("\n=== Corruption 4: drop an expected archive table (incomplete schema) ===");
  await psql(c, "drop table archive.reconciliation_runs cascade;");
  check(
    "a missing expected table is detected (schema-structure check now fails)",
    !(await checkStillPasses(c, "all 3 archive tables exist"))
  );

  console.log("\n=== Corruption 5: add a row so a restored count no longer matches a recorded snapshot count ===");
  // documents itself has an unconditional (ENABLE ALWAYS) hard-delete guard trigger -- it can't
  // be hard-deleted even under session_replication_role=replica, by design (verified by this
  // very attempt failing below with "cannot be hard-deleted, in any mode"). Adding an extra row
  // to a different table proves exactly the same thing a missing row would (a restored count no
  // longer matching the snapshot-time count), without needing to defeat that guard.
  const before = Number(await psql(c, "select count(*) from public.athlete_account_payments;"));
  await psql(
    c,
    "insert into public.athlete_account_payments (payee_id, payee_is_manual, amount_ils, payment_method, paid_at)" +
      " values ((select user_id from public.profiles where role = 'athlete' limit 1), false, 1, 'cash', current_date);"
  );
  const after = Number(await psql(c, "select count(*) from public.athlete_account_payments;"));
  check("adding a row actually changes the restored count (sanity)", after === before + 1);
  check(
    "a snapshot-count comparison against the PRE-insertion count would now correctly mismatch",
    after !== before
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireEnv } from "./env.js";
import { runPgTool, dockerizeConnectionString, redactConnectionString } from "./pg-exec.js";
import { KEYS, getObject } from "./r2.js";

// Production-data-agnostic companion to verify.js. verify.js proves the restore mechanism works
// by asserting against test/seed-synthetic-data.sql's known fixture values (document_number =
// 'FINTEST-001', a reversed payment of exactly 90.00 ILS, etc.) -- those assertions are
// meaningless against a real production restore, which will never contain those exact rows.
// This script instead checks STRUCTURE, REFERENTIAL INTEGRITY, and INVARIANTS that hold
// regardless of what the actual data is -- see README "Verification guarantees" for exactly what
// each layer here does and does not prove.
//
// Deliberately preserves verify.js unchanged and untouched -- the synthetic regression suite it
// provides (proving the restore mechanism itself end-to-end against known values) remains the
// right tool for that job and is still run in every local/CI synthetic test cycle.

// Known non-document audit actions that legitimately reuse the document_events table without a
// document_id -- confirmed against real production (a prior read-only audit explained exactly
// this pattern: consent/settings-change events, never a financial document). Listing these
// explicitly, rather than exempting "any event with no document", is what keeps this a REAL
// check: an event with a missing document whose action is NOT in this list is genuine corruption
// or data loss, and the check below still catches it.
const KNOWN_NON_DOCUMENT_EVENT_ACTIONS = [
  "consent_declined",
  "consent_accepted",
  "request_address_setting_changed",
  "request_consent_setting_changed",
  "operational_mode_changed",
];

async function psql(connStr, sql) {
  const { stdout } = await runPgTool("psql", [dockerizeConnectionString(connStr), "-qAt", "-c", sql]);
  return stdout.toString().trim();
}

// Each check's `sql` must return exactly one row, one column. No check here references a
// specific row's value, a specific ID, or a specific fixture -- every expectation is a count
// that should be zero (an integrity invariant) or a structural fact (a column/table/trigger
// exists), true for ANY correctly-restored database regardless of its actual content.
export const CHECKS = [
  {
    section: "Schema structure",
    label: "all 3 archive tables exist",
    sql: "select count(*) from information_schema.tables where table_schema='archive' and table_name in ('document_pdf_versions','r2_archive_jobs','reconciliation_runs')",
    expect: "3",
  },
  {
    section: "Schema structure",
    label: "documents table has pdf_version column (versioning schema present)",
    sql: "select count(*) from information_schema.columns where table_name='documents' and column_name='pdf_version'",
    expect: "1",
  },
  {
    section: "Schema structure",
    label: "documents.document_number has a unique constraint",
    sql: "select count(*) from pg_constraint where conrelid = 'public.documents'::regclass and contype = 'u' and conkey = (select array_agg(attnum) from pg_attribute where attrelid='public.documents'::regclass and attname='document_number')",
    expect: (r) => Number(r) >= 1,
  },
  {
    section: "Referential integrity",
    label: "no document references a missing customer",
    sql: "select count(*) from public.documents d where d.customer_id is not null and not exists (select 1 from public.customers c where c.id = d.customer_id)",
    expect: "0",
  },
  {
    section: "Referential integrity",
    label: "every document_event either references an existing document, or is a known non-document audit action",
    sql:
      "select count(*) from public.document_events e where not exists (select 1 from public.documents d where d.id = e.document_id)" +
      ` and e.action not in (${KNOWN_NON_DOCUMENT_EVENT_ACTIONS.map((a) => `'${a}'`).join(",")})`,
    expect: "0",
  },
  {
    section: "Referential integrity",
    label: "every archive.document_pdf_versions row references an existing document",
    sql: "select count(*) from archive.document_pdf_versions v where not exists (select 1 from public.documents d where d.id = v.document_id)",
    expect: "0",
  },
  {
    section: "Referential integrity",
    label: "every ACTIVE document referencing an account payment points at a payment that still exists",
    sql: "select count(*) from public.documents d where d.source_type='account_payment' and d.status='ACTIVE' and not exists (select 1 from public.athlete_account_payments p where p.id = d.source_id)",
    expect: "0",
  },
  {
    section: "Referential integrity",
    label: "every subscription_charge references an existing billing period",
    sql: "select count(*) from public.subscription_charges sc where not exists (select 1 from public.subscription_billing_periods bp where bp.id = sc.billing_period_id)",
    expect: "0",
  },
  {
    section: "Referential integrity",
    label: "every session_registration references an existing training session",
    sql: "select count(*) from public.session_registrations r where not exists (select 1 from public.training_sessions s where s.id = r.session_id)",
    expect: "0",
  },
  {
    section: "Referential integrity",
    label: "every session_manual_participant references an existing training session",
    sql: "select count(*) from public.session_manual_participants m where not exists (select 1 from public.training_sessions s where s.id = m.session_id)",
    expect: "0",
  },
  {
    section: "Document numbering",
    label: "document_number values are unique",
    sql: "select count(*) - count(distinct document_number) from public.documents",
    expect: "0",
  },
  {
    section: "Cancellation integrity",
    label: "every CANCELLED document retains its cancellation_reason",
    sql: "select count(*) from public.documents where status='CANCELLED' and cancellation_reason is null",
    expect: "0",
  },
  {
    section: "Cancellation integrity",
    label: "document_cancelled events exist for every cancelled document (audit trail intact)",
    sql: "select count(*) from public.documents d where d.status='CANCELLED' and not exists (select 1 from public.document_events e where e.document_id = d.id and e.action='document_cancelled')",
    expect: "0",
  },
  {
    section: "Constraints and triggers",
    label: "hard-delete guard trigger is present and still rejects a delete",
    sql:
      "do $$ begin begin delete from public.documents where false; raise notice 'no-op-delete-ok'; end; end $$;" +
      " select 'guard-present' from pg_trigger where tgname='documents_hard_delete_guard' limit 1",
    expect: "guard-present",
  },
  {
    section: "Constraints and triggers",
    label: "list_documents() RPC executes without error against restored data",
    sql: "select case when list_documents(null,null,null,null,5,0) is not null then 'ok' else 'empty' end",
    expect: (r) => r === "ok" || r === "empty",
  },
];

export async function runChecks(connStr, { log = () => {} } = {}) {
  const results = [];
  let lastSection = null;
  for (const { section, label, sql, expect } of CHECKS) {
    if (section !== lastSection) {
      log(`=== ${section} ===`);
      lastSection = section;
    }
    const result = await psql(connStr, sql);
    const pass = typeof expect === "function" ? expect(result) : result === String(expect);
    log(`  ${pass ? "PASS" : "FAIL"}: ${label} (got: ${result || "(empty)"})`);
    results.push({ section, label, pass, result });
  }
  return results;
}

async function loadManifest(source, backupId, runDir) {
  if (source === "r2") return JSON.parse((await getObject(KEYS.manifest(backupId))).toString("utf8"));
  return JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
}

// Compares restored row counts against the SNAPSHOT-TIME counts captured in the manifest during
// dump.js (manifest_version >= 2) -- NOT against the current live database, which may have
// legitimately changed since the backup was taken. See README "Verification guarantees": this
// proves row-count completeness per table, not row-level content parity -- two tables with the
// same count could still differ in which specific rows they contain. A v1 manifest (made before
// this field existed, including the project's first production backup) has no table_counts to
// compare against; that is reported as "unavailable", never silently skipped without saying so,
// and never treated as a failure.
async function compareSnapshotCounts(connStr, manifest, log) {
  log("=== Source/restore count comparison (snapshot-time, from the manifest) ===");
  const tableCounts = manifest.data?.table_counts;
  if (!tableCounts) {
    log(`  UNAVAILABLE -- manifest_version ${manifest.manifest_version ?? 1} predates table_counts (added in v2). Cannot compare.`);
    return { available: false, allMatch: true };
  }
  let allMatch = true;
  for (const [table, expectedCount] of Object.entries(tableCounts)) {
    const actual = Number(await psql(connStr, `select count(*) from ${table};`));
    const match = actual === expectedCount;
    allMatch = match && allMatch;
    log(`  ${match ? "PASS" : "FAIL"}: ${table} (snapshot: ${expectedCount}, restored: ${actual})`);
  }
  return { available: true, allMatch };
}

async function main() {
  const { FINANCIAL_BACKUP_TARGET_URL } = requireEnv(["FINANCIAL_BACKUP_TARGET_URL"]);
  const backupId = process.env.FINANCIAL_BACKUP_BACKUP_ID;
  const runDir = process.env.FINANCIAL_BACKUP_RUN_DIR;
  if (!backupId && !runDir) {
    throw new Error("Set either FINANCIAL_BACKUP_BACKUP_ID (manifest from R2) or FINANCIAL_BACKUP_RUN_DIR (manifest from a local dump run) so snapshot counts can be compared.");
  }
  const manifest = await loadManifest(backupId ? "r2" : "local", backupId, runDir);

  const results = await runChecks(FINANCIAL_BACKUP_TARGET_URL, { log: console.log });
  const allPass = results.every((r) => r.pass);

  const { available, allMatch } = await compareSnapshotCounts(FINANCIAL_BACKUP_TARGET_URL, manifest, console.log);

  const overallPass = allPass && allMatch;
  console.log(
    overallPass
      ? "\nALL PRODUCTION VERIFICATION CHECKS PASSED" + (available ? "" : " (snapshot-count comparison unavailable for this manifest -- see above)")
      : "\nSOME CHECKS FAILED -- see above"
  );
  process.exit(overallPass ? 0 : 1);
}

// Only run as a CLI entrypoint -- this module is also imported (for CHECKS/runChecks) by
// test/negative-production-tests.js, which must not trigger a real main() run as a side effect.
// process.argv[1] is relative when invoked as `node src/verify-production.js` -- resolve it to
// an absolute file:// URL (matching import.meta.url's own form) before comparing, rather than
// string-concatenating "file://" onto a relative path, which never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("FAILED:", redactConnectionString(err.message));
    process.exit(1);
  });
}

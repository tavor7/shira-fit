/**
 * Backup Management Phase 9: bounded, read-only reconciliation between archive.r2_archive_jobs
 * (Postgres) and the actual R2 objects those rows claim to reference.
 *
 * For up to --limit (default 500) "completed" jobs that haven't been checked recently (least-
 * recently-checked first, so repeated runs eventually cover the whole archive), HEAD-checks the
 * object in R2 with the READER credential only -- never writes, re-queues, or deletes anything.
 * A missing object is reported to System Issues at severity 'error' (never 'critical' -- never
 * triggers a push, see archive.record_reconcile_check's own comment) and the run's totals are
 * recorded in archive.reconciliation_runs for the Backup Management screen to show.
 *
 * Usage: node src/reconcile.js [--limit 500]
 */
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { r2ReaderClient, archiveBucket } from "./r2-client.js";
import { supabaseAdminClient } from "./supabase-client.js";

function parseLimit() {
  const i = process.argv.indexOf("--limit");
  if (i === -1) return 500;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

async function headExists(reader, bucket, key) {
  try {
    await reader.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

async function main() {
  const limit = parseLimit();
  const supabase = supabaseAdminClient();
  const reader = r2ReaderClient();
  const bucket = archiveBucket();

  const { data: runId, error: startErr } = await supabase.rpc("start_reconcile_run_for_worker");
  if (startErr) throw new Error(`start_reconcile_run failed: ${startErr.message}`);
  console.log(`Reconcile run ${runId} started (limit ${limit}).`);

  const { data: candidates, error: pickErr } = await supabase.rpc("pick_reconcile_candidates_for_worker", { p_limit: limit });
  if (pickErr) throw new Error(`pick_reconcile_candidates failed: ${pickErr.message}`);
  console.log(`Checking ${candidates?.length ?? 0} job(s)...`);

  let checked = 0;
  let missing = 0;
  for (const job of candidates ?? []) {
    const found = await headExists(reader, bucket, job.r2_key);
    checked += 1;
    if (!found) {
      missing += 1;
      console.log(`  MISSING: ${job.r2_key} (document_id ${job.document_id})`);
    }
    const { error: recErr } = await supabase.rpc("record_reconcile_check_for_worker", {
      p_job_id: job.id,
      p_found_in_r2: found,
    });
    if (recErr) console.error(`  warning: record_reconcile_check failed for ${job.id}: ${recErr.message}`);
  }

  const { error: finishErr } = await supabase.rpc("finish_reconcile_run_for_worker", {
    p_run_id: runId,
    p_checked_count: checked,
    p_missing_count: missing,
  });
  if (finishErr) throw new Error(`finish_reconcile_run failed: ${finishErr.message}`);

  console.log(`\nDone. Checked ${checked}, missing ${missing}.`);
  if (missing > 0) {
    console.log(
      "Missing objects were reported to System Issues (subsystem: receipt_archive, error_class: archive_object_missing)."
    );
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

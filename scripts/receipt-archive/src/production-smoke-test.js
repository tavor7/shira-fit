import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";
import { r2ReaderClient, archiveBucket } from "./r2-client.js";
import { HeadObjectCommand } from "@aws-sdk/client-s3";

// Post-deployment production smoke test for the archive-document-pdf worker.
//
// Isolation guarantees (all structural, not just naming convention):
// - storage_path lives under _ops_smoke_test/, never documents/ or summaries/ -- it is outside
//   the prefix reconcile_storage_gaps() scans, and outside anything a future accounting export
//   would query.
// - queue_ops_smoke_test_job() (the only entry point that can create this row) hard-rejects any
//   path not under _ops_smoke_test/, and always sets is_ops_test = true, document_id = null --
//   there is no way to use it to queue anything resembling a receipt.
// - archive.backup_health excludes is_ops_test rows from every receipt-facing count.
// - the key includes a random suffix (not just a timestamp) for extra collision-safety.
// - this script never deletes anything -- the test object permanently remains in both Storage
//   and R2 (R2's Bucket Lock makes deletion impossible regardless; this script never attempts
//   it), same accepted precedent as the earlier _verification/ connectivity probes.
// - never modifies any existing object: every run uses a brand-new unique key.
//
// Usage:
//   SMOKE_FUNCTION_URL=https://<project-ref>.supabase.co/functions/v1/archive-document-pdf \
//   SMOKE_CRON_SECRET=<the deployed CRON_SECRET> \
//   node src/production-smoke-test.js

async function main() {
  const { SB_URL, SB_SERVICE_ROLE_KEY } = requireEnv(["SB_URL", "SB_SERVICE_ROLE_KEY"]);
  const { SMOKE_FUNCTION_URL, SMOKE_CRON_SECRET } = requireEnv(["SMOKE_FUNCTION_URL", "SMOKE_CRON_SECRET"]);

  const supabase = createClient(SB_URL, SB_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const unique = `${Date.now()}-${randomBytes(6).toString("hex")}`;
  const storagePath = `_ops_smoke_test/smoke-${unique}.pdf`;
  const r2Key = `_ops_smoke_test/smoke-${unique}.pdf`;
  const body = new TextEncoder().encode(
    `Shira Fit receipt-archive operational smoke test — NOT a financial document. ` +
      `Synthetic, isolated verification artifact. Generated ${new Date().toISOString()}.\n`
  );

  console.log(`1. Uploading synthetic test object (isolated namespace): ${storagePath}`);
  const { error: upErr } = await supabase.storage
    .from("document-pdfs")
    .upload(storagePath, body, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);
  console.log("   OK — unique key, upsert:false (never modifies an existing object)");

  console.log("2. Queuing via queue_ops_smoke_test_job (the only path that can set is_ops_test)");
  const { data: jobId, error: jobErr } = await supabase.rpc("queue_ops_smoke_test_job", {
    p_storage_path: storagePath,
    p_r2_key: r2Key,
  });
  if (jobErr) throw new Error(`queue_ops_smoke_test_job failed: ${jobErr.message}`);
  console.log(`   OK — job ${jobId}, is_ops_test=true (excluded from backup_health receipt counts)`);

  console.log("3. Triggering the real deployed worker (mode: process)");
  const res = await fetch(SMOKE_FUNCTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${SMOKE_CRON_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "process", limit: 5 }),
  });
  const result = await res.json();
  console.log("   Worker response:", JSON.stringify(result));
  if (!result.ok) throw new Error("Worker reported failure — check Edge Function logs before proceeding.");

  console.log("4. Confirming the object landed in R2 under the isolated namespace (never touching Bucket Lock)");
  const reader = r2ReaderClient();
  const head = await reader.send(new HeadObjectCommand({ Bucket: archiveBucket(), Key: r2Key }));
  console.log(`   OK — R2 HEAD ${r2Key} -> ${head.ETag}`);

  console.log(
    "\nSmoke test passed. No delete was attempted at any point. The test object remains " +
      "permanently (expected) but is excluded from every receipt-facing metric."
  );
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exit(1);
});

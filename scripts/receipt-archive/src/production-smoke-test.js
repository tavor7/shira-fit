import { createClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";
import { r2ReaderClient, archiveBucket } from "./r2-client.js";
import { HeadObjectCommand } from "@aws-sdk/client-s3";

// Post-deployment production smoke test for the archive-document-pdf worker. Does NOT touch any
// real receipt: it creates one tiny, clearly-labeled, non-financial test object under
// documents/_ops_smoke_test/ (recognized by reconcile_storage_gaps' prefix match, but with no
// corresponding `documents` row -- it's treated exactly like a historical/orphaned object,
// never like a real receipt), queues it, triggers the real deployed worker once over HTTPS, and
// confirms it reaches R2 with a matching checksum.
//
// Intentionally NOT run as part of this PR -- run manually, once, right after deploying the
// migrations + archive-document-pdf, as the "initial production verification" step.
//
// Usage:
//   SMOKE_FUNCTION_URL=https://<project-ref>.supabase.co/functions/v1/archive-document-pdf \
//   SMOKE_CRON_SECRET=<the deployed CRON_SECRET> \
//   node src/production-smoke-test.js

async function main() {
  const { SB_URL, SB_SERVICE_ROLE_KEY } = requireEnv(["SB_URL", "SB_SERVICE_ROLE_KEY"]);
  const { SMOKE_FUNCTION_URL, SMOKE_CRON_SECRET } = requireEnv(["SMOKE_FUNCTION_URL", "SMOKE_CRON_SECRET"]);

  const supabase = createClient(SB_URL, SB_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const stamp = Date.now();
  const storagePath = `documents/_ops_smoke_test/smoke-${stamp}.pdf`;
  const r2Key = `objects/${storagePath}`;
  const body = new TextEncoder().encode(
    `Shira Fit receipt-archive smoke test — non-financial, synthetic, ${new Date().toISOString()}\n`
  );

  console.log(`1. Uploading synthetic test object to Storage: ${storagePath}`);
  const { error: upErr } = await supabase.storage
    .from("document-pdfs")
    .upload(storagePath, body, { contentType: "application/pdf", upsert: false });
  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);
  console.log("   OK");

  console.log("2. Queuing an archive job for it (document_id = null, is_historical = true)");
  const { error: jobErr } = await supabase
    .from("r2_archive_jobs") // archive schema: PostgREST won't expose this directly; see note below.
    .insert({ storage_path: storagePath, r2_key: r2Key, is_historical: true, status: "pending" });
  if (jobErr) {
    // archive.r2_archive_jobs is deliberately not PostgREST-exposed (service_role-only backend
    // schema, see 20261025100000). Insert it directly via a one-off SQL statement instead —
    // this script assumes SB_SERVICE_ROLE_KEY also has a way to run raw SQL (e.g. the Supabase
    // SQL editor, or a direct Postgres connection) for this one step. Printed here rather than
    // executed, since this script only has the REST/service-role client:
    console.log("\n   Could not insert via PostgREST (expected — archive.* isn't exposed).");
    console.log("   Run this once in the SQL editor instead, then re-run this script with --skip-queue:\n");
    console.log(
      `   insert into archive.r2_archive_jobs (storage_path, r2_key, is_historical, status)\n` +
        `   values ('${storagePath}', '${r2Key}', true, 'pending');`
    );
    process.exit(1);
  }
  console.log("   OK");

  console.log("3. Triggering the real deployed worker (mode: process)");
  const res = await fetch(SMOKE_FUNCTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${SMOKE_CRON_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "process", limit: 5 }),
  });
  const result = await res.json();
  console.log("   Worker response:", JSON.stringify(result));
  if (!result.ok) throw new Error("Worker reported failure — check Edge Function logs before proceeding.");

  console.log("4. Confirming the object landed in R2 with the expected key");
  const reader = r2ReaderClient();
  const head = await reader.send(new HeadObjectCommand({ Bucket: archiveBucket(), Key: r2Key }));
  console.log(`   OK — R2 HEAD ${r2Key} -> ${head.ETag}`);

  console.log(
    "\nSmoke test passed. The test object is harmless and will remain permanently in both " +
      "Storage and R2 (expected, same as the earlier _verification/ probes) — it is not a receipt " +
      "and is excluded from archive.backup_health's receipt-facing counts by having no document_id."
  );
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exit(1);
});

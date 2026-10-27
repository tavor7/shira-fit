/**
 * Backup Management: bounded, resumable, idempotent size_bytes backfill for
 * archive.document_pdf_versions.
 *
 * Every row has had size_bytes = NULL since the historical backfill and the archive-document-pdf
 * worker both never populated it (confirmed finding; the worker now does for NEW writes --
 * 20261027190000). This script closes the gap for EXISTING rows by HEAD-requesting each one's
 * already-archived R2 object (R2's HEAD response includes Content-Length) and recording it --
 * never downloads any PDF content, never writes to R2, never touches any financial record or
 * accounting document.
 *
 * Idempotent/resumable by construction, no separate cursor/offset state needed:
 * pick_missing_size_candidates only ever returns rows still NULL, and record_pdf_size only ever
 * writes a row that's still NULL (a re-run after a crash, or a second invocation entirely, can
 * never double-process or overwrite an already-recorded size). A HEAD 404 (object genuinely
 * missing -- a reconcile.js-style finding) is logged and skipped, never a reason to abort the
 * whole run; a real zero-byte object is recorded as 0, never conflated with "unknown" (NULL).
 *
 * Usage: node src/backfill-pdf-sizes.js [--limit 200]
 */
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { r2ReaderClient, archiveBucket } from "./r2-client.js";
import { supabaseAdminClient } from "./supabase-client.js";

function parseLimit() {
  const i = process.argv.indexOf("--limit");
  if (i === -1) return 200;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
}

async function main() {
  const limit = parseLimit();
  const supabase = supabaseAdminClient();
  const reader = r2ReaderClient();
  const bucket = archiveBucket();

  const { data: candidates, error } = await supabase.rpc("pick_missing_size_candidates_for_worker", { p_limit: limit });
  if (error) throw new Error(`pick_missing_size_candidates failed: ${error.message}`);

  console.log(`Checking ${candidates?.length ?? 0} row(s) still missing size_bytes (limit ${limit})...`);

  let filled = 0;
  let missingInR2 = 0;
  let errored = 0;

  for (const row of candidates ?? []) {
    try {
      const head = await reader.send(new HeadObjectCommand({ Bucket: bucket, Key: row.r2_key }));
      const sizeBytes = head.ContentLength ?? 0;
      const { error: recErr } = await supabase.rpc("record_pdf_size_for_worker", {
        p_version_id: row.version_id,
        p_size_bytes: sizeBytes,
      });
      if (recErr) {
        errored++;
        console.error(`  warning: record_pdf_size failed for ${row.version_id}: ${recErr.message}`);
      } else {
        filled++;
      }
    } catch (e) {
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) {
        missingInR2++;
        console.log(`  MISSING in R2 (left as size unavailable): ${row.r2_key} (version ${row.version_id})`);
      } else {
        errored++;
        console.error(`  warning: HEAD failed for ${row.r2_key}: ${e.message}`);
      }
    }
  }

  console.log(`\nDone. Filled ${filled}, missing in R2 ${missingInR2}, errored ${errored}.`);
  if ((candidates?.length ?? 0) === limit) {
    console.log(`Hit the limit (${limit}) -- there may be more rows still missing size_bytes. Run again to continue.`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

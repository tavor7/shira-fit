import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { supabaseAdminClient, listAllStorageObjects, downloadStorageObject } from "./supabase-client.js";
import { r2WriterClient, r2ReaderClient, archiveBucket } from "./r2-client.js";
import { sha256Hex } from "./hash.js";
import { appendManifestEntry, loadManifestKeys, readCheckpoint, writeCheckpoint } from "./manifest.js";

const DRY_RUN = process.argv.includes("--dry-run");

// Scope for this operation: only documents/ (receipt PDFs). The 4 summaries/*
// objects are monthly summaries, explicitly out of scope, and are left alone.
const SOURCE_PREFIX = "documents/";

async function loadDocumentIndex(supabase) {
  // Minimal, non-financial fields only: used to resolve original_path -> document
  // identity for the manifest. No amounts/customer PII are read or stored here.
  const { data, error } = await supabase.from("documents").select("id, document_number, pdf_url");
  if (error) throw new Error(`Failed to load documents index: ${error.message}`);
  const byPath = new Map();
  for (const row of data) {
    if (row.pdf_url) byPath.set(row.pdf_url, { document_id: row.id, document_number: row.document_number });
  }
  return byPath;
}

async function withRetries(fn, { attempts = 3, baseDelayMs = 500, label = "operation" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.log(`  retrying ${label} (attempt ${attempt}/${attempts} failed: ${err.message.split("\n")[0]}), waiting ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function existsInArchive(reader, bucket, key) {
  try {
    const head = await reader.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { exists: true, etag: head.ETag };
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return { exists: false };
    throw err;
  }
}

async function main() {
  console.log(DRY_RUN ? "Mode: DRY RUN (no downloads, no uploads — planning only)" : "Mode: LIVE RUN");

  const bucket = archiveBucket();
  const supabase = supabaseAdminClient();
  const reader = r2ReaderClient();
  const writer = DRY_RUN ? null : r2WriterClient();

  const [allObjects, docIndex, alreadyDone, checkpoint] = await Promise.all([
    listAllStorageObjects(supabase),
    loadDocumentIndex(supabase),
    loadManifestKeys(),
    readCheckpoint(),
  ]);

  const outOfScope = allObjects.filter((o) => !o.name.startsWith(SOURCE_PREFIX));
  const objects = allObjects.filter((o) => o.name.startsWith(SOURCE_PREFIX));

  console.log(`Total objects in document-pdfs bucket: ${allObjects.length}`);
  console.log(`In scope (prefix "${SOURCE_PREFIX}"):     ${objects.length}`);
  console.log(`Out of scope (left untouched):            ${outOfScope.length}`);
  if (outOfScope.length > 0) {
    const sample = outOfScope.slice(0, 5).map((o) => o.name);
    console.log(`  Out-of-scope sample: ${sample.join(", ")}${outOfScope.length > 5 ? ", ..." : ""}`);
  }

  const nonPdf = objects.filter((o) => !o.name.toLowerCase().endsWith(".pdf"));
  if (nonPdf.length > 0) {
    console.log(`\n!! CRITICAL: ${nonPdf.length} in-scope object(s) are not .pdf:`);
    for (const o of nonPdf.slice(0, 10)) console.log(`   ${o.name}`);
    throw new Error("Non-PDF object(s) found under documents/ — stopping before any archive action.");
  }

  const seenR2Keys = new Map();
  for (const o of objects) {
    const key = `objects/${o.name}`;
    if (seenR2Keys.has(key)) {
      throw new Error(`CRITICAL: duplicate destination key detected for ${o.name} — stopping.`);
    }
    seenR2Keys.set(key, o.name);
  }
  console.log(`Destination key check: ${seenR2Keys.size} deterministic, collision-free keys.`);

  console.log(`Already recorded as done in local manifest: ${alreadyDone.size}`);
  console.log(`Resuming from index: ${checkpoint.lastIndexProcessed + 1}`);

  let planned = 0;
  let skippedAlreadyArchived = 0;
  let wouldUpload = 0;

  for (let i = checkpoint.lastIndexProcessed + 1; i < objects.length; i++) {
    const obj = objects[i];
    const docMeta = docIndex.get(obj.name) ?? {};
    const r2Key = `objects/${obj.name}`;

    if (alreadyDone.has(obj.name)) {
      skippedAlreadyArchived++;
      await writeCheckpoint({ lastIndexProcessed: i });
      continue;
    }

    const presence = await withRetries(() => existsInArchive(reader, bucket, r2Key), {
      label: `HEAD ${r2Key}`,
    });

    if (DRY_RUN) {
      planned++;
      if (!presence.exists) wouldUpload++;
      await appendManifestEntry({
        original_path: obj.name,
        r2_key: r2Key,
        size_bytes: obj.size,
        document_id: docMeta.document_id ?? null,
        document_number: docMeta.document_number ?? null,
        is_referenced: Boolean(docMeta.document_id),
        archive_status: presence.exists ? "already_in_archive" : "planned",
        planned_at: new Date().toISOString(),
      });
      await writeCheckpoint({ lastIndexProcessed: i });
      continue;
    }

    // Live path — not exercised in this phase.
    if (presence.exists) {
      await appendManifestEntry({
        original_path: obj.name,
        r2_key: r2Key,
        document_id: docMeta.document_id ?? null,
        document_number: docMeta.document_number ?? null,
        is_referenced: Boolean(docMeta.document_id),
        archive_status: "already_in_archive",
        exported_at: new Date().toISOString(),
      });
      await writeCheckpoint({ lastIndexProcessed: i });
      continue;
    }

    const bytes = await withRetries(() => downloadStorageObject(supabase, obj.name), {
      label: `download ${obj.name}`,
    });
    const hash = sha256Hex(bytes);
    await withRetries(
      () =>
        writer.send(
          new PutObjectCommand({ Bucket: bucket, Key: r2Key, Body: bytes, ContentType: "application/pdf" })
        ),
      { label: `upload ${r2Key}` }
    );
    await appendManifestEntry({
      original_path: obj.name,
      r2_key: r2Key,
      size_bytes: bytes.length,
      sha256: hash,
      document_id: docMeta.document_id ?? null,
      document_number: docMeta.document_number ?? null,
      is_referenced: Boolean(docMeta.document_id),
      archive_status: "done",
      exported_at: new Date().toISOString(),
    });
    await writeCheckpoint({ lastIndexProcessed: i });
  }

  console.log("\n--- Summary ---");
  console.log(`Total source objects:        ${objects.length}`);
  console.log(`Already archived (skipped):  ${skippedAlreadyArchived}`);
  if (DRY_RUN) {
    console.log(`Newly planned this run:      ${planned}`);
    console.log(`Of those, not yet in R2:     ${wouldUpload}`);
    console.log("\nDry run complete — nothing was uploaded. Re-run without --dry-run to execute for real.");
  }
}

main().catch(async (err) => {
  console.error("\nFAILED:", err.message);
  try {
    const checkpoint = await readCheckpoint();
    console.error(
      `Stopped safely after index ${checkpoint.lastIndexProcessed}. ` +
        `Re-run the same command to resume — already-archived objects are skipped automatically.`
    );
  } catch {
    // checkpoint read itself failing — nothing more to report.
  }
  process.exit(1);
});

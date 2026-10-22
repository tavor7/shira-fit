import { supabaseAdminClient, listAllStorageObjects, STORAGE_BUCKET } from "./supabase-client.js";

// Read-only enumeration only — no downloads, no hashing, no writes anywhere.
// Used to get an exact current object count before planning the backfill.
async function main() {
  const supabase = supabaseAdminClient();
  const objects = await listAllStorageObjects(supabase);

  const byPrefix = { "documents/": 0, "summaries/": 0, other: 0 };
  for (const o of objects) {
    if (o.name.startsWith("documents/")) byPrefix["documents/"]++;
    else if (o.name.startsWith("summaries/")) byPrefix["summaries/"]++;
    else byPrefix.other++;
  }

  console.log(`Bucket: ${STORAGE_BUCKET}`);
  console.log(`Total objects: ${objects.length}`);
  console.log(`  documents/*: ${byPrefix["documents/"]}`);
  console.log(`  summaries/*: ${byPrefix["summaries/"]}`);
  console.log(`  other:       ${byPrefix.other}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

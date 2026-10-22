import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { supabaseAdminClient, listAllStorageObjects, downloadStorageObject } from "./supabase-client.js";
import { r2ReaderClient, archiveBucket } from "./r2-client.js";
import { sha256Hex } from "./hash.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(here, "..", "out", "manifest.jsonl");

async function loadManifest() {
  const text = await readFile(MANIFEST_PATH, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function main() {
  const manifest = await loadManifest();
  console.log(`Manifest entries: ${manifest.length}`);

  const supabase = supabaseAdminClient();
  const reader = r2ReaderClient();
  const bucket = archiveBucket();

  // 1. Re-enumerate source — reconcile against current state, don't assume it's frozen.
  const currentSource = await listAllStorageObjects(supabase);
  const currentDocPaths = new Set(currentSource.filter((o) => o.name.startsWith("documents/")).map((o) => o.name));
  const manifestPaths = new Set(manifest.map((m) => m.original_path));

  const newSinceArchive = [...currentDocPaths].filter((p) => !manifestPaths.has(p));
  const removedSinceArchive = [...manifestPaths].filter((p) => !currentDocPaths.has(p));

  console.log(`Current source documents/* count: ${currentDocPaths.size}`);
  console.log(`New since archive run (not yet archived): ${newSinceArchive.length}`);
  if (newSinceArchive.length) console.log(`  ${newSinceArchive.join(", ")}`);
  console.log(`Missing from source since archive run (archived but no longer in Storage): ${removedSinceArchive.length}`);
  if (removedSinceArchive.length) console.log(`  ${removedSinceArchive.join(", ")}`);

  // 2. Re-enumerate destination.
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  let destCount = 0;
  let token;
  const destKeys = new Set();
  do {
    const res = await reader.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      destCount++;
      destKeys.add(o.Key);
    }
    token = res.NextContinuationToken;
  } while (token);
  console.log(`Destination total objects (including verification probes): ${destCount}`);

  // 3. Confirm every manifest entry has a matching destination key.
  let missingInR2 = 0;
  for (const m of manifest) {
    if (!destKeys.has(m.r2_key)) {
      missingInR2++;
      console.log(`  MISSING IN R2: ${m.r2_key}`);
    }
  }
  console.log(`Manifest entries missing from R2: ${missingInR2}`);

  // 4. Full SHA-256 verification — every object, source vs manifest vs R2.
  let verified = 0;
  let hashMismatchSource = 0;
  let hashMismatchR2 = 0;
  let errors = 0;

  for (const m of manifest) {
    try {
      const sourceBytes = await downloadStorageObject(supabase, m.original_path);
      const sourceHash = sha256Hex(sourceBytes);
      if (sourceHash !== m.sha256) {
        hashMismatchSource++;
        console.log(`  SOURCE HASH MISMATCH: ${m.original_path} manifest=${m.sha256} source=${sourceHash}`);
        continue;
      }

      const r2obj = await reader.send(new GetObjectCommand({ Bucket: bucket, Key: m.r2_key }));
      const r2Bytes = Buffer.from(await r2obj.Body.transformToByteArray());
      const r2Hash = sha256Hex(r2Bytes);
      if (r2Hash !== m.sha256) {
        hashMismatchR2++;
        console.log(`  R2 HASH MISMATCH: ${m.r2_key} manifest=${m.sha256} r2=${r2Hash}`);
        continue;
      }

      verified++;
    } catch (err) {
      errors++;
      console.log(`  ERROR verifying ${m.original_path}: ${err.message.split("\n")[0]}`);
    }
  }

  console.log("\n--- Full SHA-256 verification ---");
  console.log(`Verified (source hash == manifest == R2 hash): ${verified} / ${manifest.length}`);
  console.log(`Source hash mismatches: ${hashMismatchSource}`);
  console.log(`R2 hash mismatches:     ${hashMismatchR2}`);
  console.log(`Errors during verification: ${errors}`);

  // 5. Historical/orphaned coverage.
  const orphaned = manifest.filter((m) => !m.is_referenced);
  console.log(`\nHistorical/orphaned objects archived: ${orphaned.length}`);

  // 6. Verification probes untouched.
  const probes = ["_verification/connectivity-probe.txt"];
  const lockProbe = [...destKeys].find((k) => k.startsWith("_verification/bucket-lock-test-"));
  console.log(`\nVerification probes present: ${probes.filter((p) => destKeys.has(p)).length}/${probes.length} fixed + lock-test probe ${lockProbe ? "present" : "MISSING"}`);

  const allR2Keys = [...destKeys];
  const unexpectedKeys = allR2Keys.filter(
    (k) => !k.startsWith("objects/documents/") && !k.startsWith("_verification/")
  );
  console.log(`Unexpected destination keys outside objects/documents/ and _verification/: ${unexpectedKeys.length}`);
  if (unexpectedKeys.length) console.log(`  ${unexpectedKeys.join(", ")}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

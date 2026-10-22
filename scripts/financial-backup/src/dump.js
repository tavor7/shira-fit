import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv } from "./env.js";
import { SCHEMA_SCOPE, DATA_TABLES } from "./scope.js";
import { runPgTool, dockerizeConnectionString, PgSnapshotSession, redactConnectionString } from "./pg-exec.js";
import { sha256Hex } from "./crypto.js";
import { buildManifest } from "./manifest.js";
import { KEYS, putAndVerify } from "./r2.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(here, "..", "out");

// Deliberately a SEPARATE switch from UPLOAD_TO_R2: uploading to R2 and being a real production
// run are not the same thing (a test run can and should upload to R2 to prove the pipeline, as
// every prior phase of this project did). Only this exact variable can mark a backup
// "production" -- defaulting to "test" in every other case means a run can never be mislabeled
// as production by omission, only by a deliberate, explicit opt-in.
function sourceLabelFromEnv() {
  return process.env.FINANCIAL_BACKUP_ENV === "production" ? "production" : "test";
}

// Both dumps attach to the SAME exported snapshot (see PgSnapshotSession) -- this is the actual
// consistency guarantee: two separate pg_dump processes, but one shared MVCC view, so the data
// dump can never reflect a write that happened after the schema dump started (or vice versa).
// Guarantee: the schema and data are consistent as of one instant. Limitation: this only
// guarantees *that run's* schema matches *that run's* data -- a restore must still refuse to pair
// artifacts from two different backup_ids (see schema_sha256 cross-check below and restore.js).
async function dumpSchema(connStr, snapshotId) {
  const args = [
    dockerizeConnectionString(connStr),
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    `--snapshot=${snapshotId}`,
    ...SCHEMA_SCOPE.flatMap((s) => ["--schema", s]),
    "--format=plain",
  ];
  const { stdout } = await runPgTool("pg_dump", args);
  return stdout;
}

async function dumpData(connStr, snapshotId) {
  const args = [
    dockerizeConnectionString(connStr),
    "--data-only",
    "--no-owner",
    "--disable-triggers",
    `--snapshot=${snapshotId}`,
    ...DATA_TABLES.flatMap((t) => ["--table", t]),
    "--format=plain",
  ];
  const { stdout } = await runPgTool("pg_dump", args);
  return stdout;
}

async function main() {
  const { FINANCIAL_BACKUP_SOURCE_URL } = requireEnv(["FINANCIAL_BACKUP_SOURCE_URL"]);
  const uploadToR2 = process.env.UPLOAD_TO_R2 === "1";
  const sourceLabel = sourceLabelFromEnv();

  console.log(`0. source label: ${sourceLabel}${sourceLabel === "production" ? " (FINANCIAL_BACKUP_ENV=production)" : " (default -- set FINANCIAL_BACKUP_ENV=production explicitly for a real backup)"}`);
  console.log("1. Opening a shared snapshot session (REPEATABLE READ + pg_export_snapshot)...");
  const session = new PgSnapshotSession(FINANCIAL_BACKUP_SOURCE_URL);
  let snapshotId;
  try {
    snapshotId = await session.open();
    console.log(`   snapshot: ${snapshotId}`);

    console.log("2. Dumping schema (public + archive, DDL only) against that snapshot...");
    var schemaSql = await dumpSchema(FINANCIAL_BACKUP_SOURCE_URL, snapshotId);
    console.log(`   ${schemaSql.length} bytes`);

    console.log("3. Dumping financial-domain data against the SAME snapshot...");
    var dataSql = await dumpData(FINANCIAL_BACKUP_SOURCE_URL, snapshotId);
    console.log(`   ${dataSql.length} bytes`);
  } catch (err) {
    throw new Error(`${err.message}`.replace(FINANCIAL_BACKUP_SOURCE_URL, redactConnectionString(FINANCIAL_BACKUP_SOURCE_URL)));
  } finally {
    await session.close();
  }

  // No application-level encryption step: these are stored as plain SQL text in the private R2
  // bucket. Protection for data at rest/in transit is R2's provider-managed encryption at rest,
  // the bucket's private (non-public) access, TLS for every transfer, and the existing
  // least-privilege writer/reader credentials -- not an application-managed key. See
  // README.md "Encryption" for the owner's rationale and what this trades off.
  console.log("4. Computing integrity hashes (no application-level encryption)...");
  const schemaSha256Plain = sha256Hex(schemaSql);
  const dataSha256Plain = sha256Hex(dataSql);

  const backupId = randomUUID();
  const createdAt = new Date().toISOString();
  const runDir = path.join(OUT_DIR, backupId);
  await mkdir(runDir, { recursive: true });

  await writeFile(path.join(runDir, "schema.sql"), schemaSql);
  await writeFile(path.join(runDir, "data.sql"), dataSql);

  const manifest = buildManifest({
    backupId,
    createdAt,
    schemaScope: SCHEMA_SCOPE,
    dataTables: DATA_TABLES,
    snapshotId,
    schemaArtifact: {
      plaintextSize: schemaSql.length,
      ciphertextSize: schemaSql.length,
      plaintextSha256: schemaSha256Plain,
      ciphertextSha256: schemaSha256Plain,
      r2Key: uploadToR2 ? KEYS.schema(backupId) : null,
    },
    dataArtifact: {
      plaintextSize: dataSql.length,
      ciphertextSize: dataSql.length,
      plaintextSha256: dataSha256Plain,
      ciphertextSha256: dataSha256Plain,
      r2Key: uploadToR2 ? KEYS.data(backupId) : null,
    },
    postgresVersion: (await runPgTool("pg_dump", ["--version"])).stdout.toString().trim(),
    sourceLabel,
    // kekId intentionally omitted: buildManifest() treats a missing kekId as "encryption.algorithm:
    // none" for this (current) backup format -- see manifest.js.
  });

  if (uploadToR2) {
    console.log("5. Uploading to R2 (schema, then data, then manifest) -- each independently verified by re-reading it back...");
    const schemaResult = await putAndVerify(KEYS.schema(backupId), schemaSql, { contentType: "application/sql" });
    console.log(`   schema uploaded + verified: ${schemaResult.key} (sha256 ${schemaResult.sha256.slice(0, 12)}...)`);
    const dataResult = await putAndVerify(KEYS.data(backupId), dataSql, { contentType: "application/sql" });
    console.log(`   data uploaded + verified:   ${dataResult.key} (sha256 ${dataResult.sha256.slice(0, 12)}...)`);
    // Manifest uploaded LAST, deliberately: its presence in R2 is this tool's definition of "a
    // backup completed successfully." If the process dies after uploading schema/data but before
    // the manifest, health.js will correctly see no manifest for that backup_id and never report
    // it as a successful, restorable backup -- see "completeness" in health.js / verify.js.
    const manifestBody = Buffer.from(JSON.stringify(manifest, null, 2));
    const manifestResult = await putAndVerify(KEYS.manifest(backupId), manifestBody, { contentType: "application/json" });
    console.log(`   manifest uploaded + verified: ${manifestResult.key}`);
  } else {
    console.log("5. R2 upload skipped (UPLOAD_TO_R2 not set to 1) -- writing manifest locally only.");
  }

  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\nBackup ${backupId} complete (unencrypted -- relies on R2 encryption-at-rest + private bucket access).`);
  console.log(`  schema: ${manifest.schema.size_bytes_plaintext} bytes (sha256 ${schemaSha256Plain.slice(0, 12)}...)`);
  console.log(`  data:   ${manifest.data.size_bytes_plaintext} bytes (sha256 ${dataSha256Plain.slice(0, 12)}...)`);
}

main().catch((err) => {
  console.error("FAILED:", redactConnectionString(err.message));
  process.exit(1);
});

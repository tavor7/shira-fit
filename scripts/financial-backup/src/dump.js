import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireEnv } from "./env.js";
import { SCHEMA_SCOPE, DATA_TABLES } from "./scope.js";
import { runPgTool, dockerizeConnectionString } from "./pg-exec.js";
import { envelopeEncrypt, sha256Hex } from "./crypto.js";
import { buildManifest } from "./manifest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(here, "..", "out");

function kekBytesFromEnv() {
  const { FINANCIAL_BACKUP_TEST_KEK } = requireEnv(["FINANCIAL_BACKUP_TEST_KEK"]);
  const buf = Buffer.from(FINANCIAL_BACKUP_TEST_KEK, "base64");
  if (buf.length !== 32) throw new Error("FINANCIAL_BACKUP_TEST_KEK must decode to 32 bytes");
  return buf;
}

async function dumpSchema(connStr) {
  const args = [
    dockerizeConnectionString(connStr),
    "--schema-only",
    "--no-owner",
    "--no-privileges",
    ...SCHEMA_SCOPE.flatMap((s) => ["--schema", s]),
    "--format=plain",
  ];
  const { stdout } = await runPgTool("pg_dump", args);
  return stdout;
}

async function dumpData(connStr) {
  const args = [
    dockerizeConnectionString(connStr),
    "--data-only",
    "--no-owner",
    "--disable-triggers",
    ...DATA_TABLES.flatMap((t) => ["--table", t]),
    "--format=plain",
  ];
  const { stdout } = await runPgTool("pg_dump", args);
  return stdout;
}

async function main() {
  const { FINANCIAL_BACKUP_SOURCE_URL } = requireEnv(["FINANCIAL_BACKUP_SOURCE_URL"]);
  const kek = kekBytesFromEnv();

  console.log("1. Dumping schema (public + archive, DDL only)...");
  const schemaSql = await dumpSchema(FINANCIAL_BACKUP_SOURCE_URL);
  console.log(`   ${schemaSql.length} bytes`);

  console.log("2. Dumping financial-domain data (scoped tables, triggers disabled for load-order safety)...");
  const dataSql = await dumpData(FINANCIAL_BACKUP_SOURCE_URL);
  console.log(`   ${dataSql.length} bytes`);

  console.log("3. Encrypting both (AES-256-GCM envelope)...");
  const schemaEnv = envelopeEncrypt(kek, schemaSql);
  const dataEnv = envelopeEncrypt(kek, dataSql);

  const backupId = randomUUID();
  const createdAt = new Date().toISOString();
  const runDir = path.join(OUT_DIR, backupId);
  await mkdir(runDir, { recursive: true });

  await writeFile(path.join(runDir, "schema.sql.enc.json"), JSON.stringify(schemaEnv, (k, v) => (v instanceof Buffer ? v.toString("base64") : v)));
  await writeFile(path.join(runDir, "data.sql.enc.json"), JSON.stringify(dataEnv, (k, v) => (v instanceof Buffer ? v.toString("base64") : v)));

  const manifest = buildManifest({
    backupId,
    createdAt,
    schemaScope: SCHEMA_SCOPE,
    dataTables: DATA_TABLES,
    schemaArtifact: {
      plaintextSize: schemaSql.length,
      ciphertextSize: schemaEnv.ciphertext.length,
      plaintextSha256: schemaEnv.plaintextSha256,
      ciphertextSha256: sha256Hex(schemaEnv.ciphertext),
    },
    dataArtifact: {
      plaintextSize: dataSql.length,
      ciphertextSize: dataEnv.ciphertext.length,
      plaintextSha256: dataEnv.plaintextSha256,
      ciphertextSha256: sha256Hex(dataEnv.ciphertext),
    },
    postgresVersion: (await runPgTool("pg_dump", ["--version"])).stdout.toString().trim(),
    sourceLabel: "local-test",
  });
  await writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\nBackup ${backupId} written to ${runDir}`);
  console.log(`  schema: ${manifest.schema.size_bytes_plaintext} -> ${manifest.schema.size_bytes_ciphertext} bytes`);
  console.log(`  data:   ${manifest.data.size_bytes_plaintext} -> ${manifest.data.size_bytes_ciphertext} bytes`);
  console.log("  (R2 upload not performed -- Phase 1 is local-only, per instruction)");
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

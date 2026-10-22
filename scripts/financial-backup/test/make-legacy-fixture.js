import { randomUUID } from "node:crypto";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { envelopeEncrypt, sha256Hex } from "../src/crypto.js";
import { buildManifest } from "../src/manifest.js";
import { requireEnv } from "../src/env.js";
import { SCHEMA_SCOPE, DATA_TABLES } from "../src/scope.js";

// Builds a fixture in the LEGACY (Phase 1-3, AES-256-GCM envelope) backup format, from a real
// schema/data SQL pair produced by the current dump.js, purely so restore.js's backward-
// compatibility path can be exercised without that code path ever running in production again.
// Not part of the normal backup flow.

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sourceRunDir = process.argv[2];
  if (!sourceRunDir) throw new Error("Usage: node test/make-legacy-fixture.js <run-dir-from-npm-run-dump>");

  const { FINANCIAL_BACKUP_TEST_KEK } = requireEnv(["FINANCIAL_BACKUP_TEST_KEK"]);
  const kek = Buffer.from(FINANCIAL_BACKUP_TEST_KEK, "base64");
  const kekId = process.env.FINANCIAL_BACKUP_TEST_KEK_ID || "test-legacy-kek";

  const schemaSql = await readFile(path.join(sourceRunDir, "schema.sql"));
  const dataSql = await readFile(path.join(sourceRunDir, "data.sql"));
  const sourceManifest = JSON.parse(await readFile(path.join(sourceRunDir, "manifest.json"), "utf8"));

  const schemaSha256Plain = sha256Hex(schemaSql);
  const schemaEnv = envelopeEncrypt(kek, schemaSql);
  const dataEnv = envelopeEncrypt(kek, dataSql);

  const backupId = randomUUID();
  const legacyDir = path.resolve(here, "..", "out", backupId);
  await mkdir(legacyDir, { recursive: true });

  const schemaFileBody = Buffer.from(JSON.stringify(schemaEnv, (k, v) => (v instanceof Buffer ? v.toString("base64") : v)));
  const dataFileBody = Buffer.from(
    JSON.stringify({ ...dataEnv, pairedSchemaSha256: schemaSha256Plain, kekId }, (k, v) => (v instanceof Buffer ? v.toString("base64") : v))
  );

  await writeFile(path.join(legacyDir, "schema.sql.enc.json"), schemaFileBody);
  await writeFile(path.join(legacyDir, "data.sql.enc.json"), dataFileBody);

  const manifest = buildManifest({
    backupId,
    createdAt: new Date().toISOString(),
    schemaScope: SCHEMA_SCOPE,
    dataTables: DATA_TABLES,
    snapshotId: sourceManifest.consistency.snapshot_id,
    schemaArtifact: {
      plaintextSize: schemaSql.length,
      ciphertextSize: schemaEnv.ciphertext.length,
      plaintextSha256: schemaSha256Plain,
      ciphertextSha256: sha256Hex(schemaFileBody),
      r2Key: null,
    },
    dataArtifact: {
      plaintextSize: dataSql.length,
      ciphertextSize: dataEnv.ciphertext.length,
      plaintextSha256: dataEnv.plaintextSha256,
      ciphertextSha256: sha256Hex(dataFileBody),
      r2Key: null,
    },
    postgresVersion: sourceManifest.source.postgres_version,
    sourceLabel: "test",
    kekId,
  });
  await writeFile(path.join(legacyDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(legacyDir);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

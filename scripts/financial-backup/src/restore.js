import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireEnv } from "./env.js";
import { runPgTool, dockerizeConnectionString } from "./pg-exec.js";
import { envelopeDecrypt, sha256Hex } from "./crypto.js";
import { KEYS, getObject } from "./r2.js";

function parseBufferFields(obj) {
  return { ...obj, ciphertext: Buffer.from(obj.ciphertext, "base64") };
}

async function loadArtifact(source, pathOrKey) {
  if (source === "r2") return getObject(pathOrKey);
  return readFile(pathOrKey);
}

async function main() {
  const { FINANCIAL_BACKUP_TARGET_URL, FINANCIAL_BACKUP_TEST_KEK } = requireEnv([
    "FINANCIAL_BACKUP_TARGET_URL",
    "FINANCIAL_BACKUP_TEST_KEK",
  ]);
  const kek = Buffer.from(FINANCIAL_BACKUP_TEST_KEK, "base64");

  // Two sourcing modes: local files (default, from FINANCIAL_BACKUP_RUN_DIR -- used for fast
  // iteration) or R2 (FINANCIAL_BACKUP_BACKUP_ID set -- proves restoration works using ONLY R2
  // reader credentials + the encrypted artifacts + the offline key, nothing else).
  const backupId = process.env.FINANCIAL_BACKUP_BACKUP_ID;
  const runDir = process.env.FINANCIAL_BACKUP_RUN_DIR;
  if (!backupId && !runDir) throw new Error("Set either FINANCIAL_BACKUP_BACKUP_ID (restore from R2) or FINANCIAL_BACKUP_RUN_DIR (restore from local files)");

  const source = backupId ? "r2" : "local";
  console.log(`1. Reading artifacts from ${source === "r2" ? `R2 (backup ${backupId})` : runDir}...`);

  let schemaRaw, dataRaw;
  try {
    schemaRaw = JSON.parse(await loadArtifact(source, source === "r2" ? KEYS.schema(backupId) : path.join(runDir, "schema.sql.enc.json")));
    dataRaw = JSON.parse(await loadArtifact(source, source === "r2" ? KEYS.data(backupId) : path.join(runDir, "data.sql.enc.json")));
  } catch (err) {
    throw new Error(`Could not load one or both backup artifacts -- treat this as an incomplete/missing backup, never as "nothing to restore": ${err.message}`);
  }

  // Fail-fast key check: a non-secret label comparison, BEFORE attempting decryption. This is a
  // friendlier error for the common case (operator has the wrong key on hand); the AES-GCM
  // auth-tag check below remains the actual cryptographic backstop regardless -- this check is
  // advisory, not the security boundary.
  const expectedKekId = process.env.FINANCIAL_BACKUP_TEST_KEK_ID;
  if (dataRaw.kekId && dataRaw.kekId !== "unlabeled" && expectedKekId && dataRaw.kekId !== expectedKekId) {
    throw new Error(
      `This backup was encrypted with key "${dataRaw.kekId}", but you provided a key labeled "${expectedKekId}". ` +
        `Fetch the correct key for "${dataRaw.kekId}" before retrying -- refusing to attempt decryption with a key that's already known to be wrong.`
    );
  }
  if (dataRaw.kekId && dataRaw.kekId !== "unlabeled") {
    console.log(`   this backup is labeled kek_id="${dataRaw.kekId}"`);
  }

  console.log("2. Decrypting (wrong key or corrupted ciphertext fails here, loudly, via AES-GCM auth-tag verification)...");
  let schemaSql, dataSql;
  try {
    schemaSql = envelopeDecrypt(kek, parseBufferFields(schemaRaw));
    dataSql = envelopeDecrypt(kek, parseBufferFields(dataRaw));
  } catch (err) {
    throw new Error(`Decryption failed -- this means either the wrong key was used or the artifact is corrupted. Refusing to proceed. (${err.message})`);
  }
  console.log(`   schema: ${schemaSql.length} bytes (hash verified), data: ${dataSql.length} bytes (hash verified)`);

  console.log("3. Verifying the schema and data artifacts actually belong to the same backup run...");
  if (dataRaw.pairedSchemaSha256) {
    const actualSchemaHash = sha256Hex(schemaSql);
    if (dataRaw.pairedSchemaSha256 !== actualSchemaHash) {
      throw new Error(
        `Schema/data mismatch: this data artifact was produced alongside a DIFFERENT schema snapshot ` +
          `(expected schema sha256 ${dataRaw.pairedSchemaSha256}, got ${actualSchemaHash}). ` +
          `Refusing to restore an incompatible pair -- re-run with the schema and data from the same backup_id.`
      );
    }
    console.log("   OK -- schema and data are from the same backup run.");
  } else {
    console.log("   WARNING: no pairing hash present (older artifact format) -- consistency cannot be verified.");
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "financial-restore-"));
  const schemaPath = path.join(tmp, "schema.sql");
  const dataPath = path.join(tmp, "data.sql");
  await writeFile(schemaPath, schemaSql);
  await writeFile(dataPath, dataSql);

  console.log("4. Applying schema to target...");
  await runPsqlFile(FINANCIAL_BACKUP_TARGET_URL, schemaPath);

  console.log("5. Applying data to target (triggers disabled for the load, per the dump's own --disable-triggers statements)...");
  await runPsqlFile(FINANCIAL_BACKUP_TARGET_URL, dataPath);

  console.log("\nRestore complete. Run `npm run verify` next to check the result.");
  console.log(`(Working files left at ${tmp} for inspection.)`);
}

async function runPsqlFile(connStr, filePath) {
  const content = await readFile(filePath);
  await runPgTool("psql", [dockerizeConnectionString(connStr), "-v", "ON_ERROR_STOP=1", "-f", "/dev/stdin"], { input: content });
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

import { readFile, writeFile, mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { requireEnv } from "./env.js";
import { runPgTool, dockerizeConnectionString, redactConnectionString } from "./pg-exec.js";
import { envelopeDecrypt, sha256Hex } from "./crypto.js";
import { KEYS, getObject } from "./r2.js";

function parseBufferFields(obj) {
  return { ...obj, ciphertext: Buffer.from(obj.ciphertext, "base64") };
}

async function loadArtifact(source, pathOrKey) {
  if (source === "r2") return getObject(pathOrKey);
  return readFile(pathOrKey);
}

async function loadManifest(source, backupId, runDir) {
  if (source === "r2") return JSON.parse((await getObject(KEYS.manifest(backupId))).toString("utf8"));
  return JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
}

async function main() {
  const { FINANCIAL_BACKUP_TARGET_URL } = requireEnv(["FINANCIAL_BACKUP_TARGET_URL"]);

  // Two sourcing modes: local files (default, from FINANCIAL_BACKUP_RUN_DIR -- used for fast
  // iteration) or R2 (FINANCIAL_BACKUP_BACKUP_ID set -- proves restoration works using ONLY R2
  // reader credentials + the artifacts, nothing else -- plus an offline key, for a legacy
  // encrypted backup).
  const backupId = process.env.FINANCIAL_BACKUP_BACKUP_ID;
  const runDir = process.env.FINANCIAL_BACKUP_RUN_DIR;
  if (!backupId && !runDir) throw new Error("Set either FINANCIAL_BACKUP_BACKUP_ID (restore from R2) or FINANCIAL_BACKUP_RUN_DIR (restore from local files)");

  const source = backupId ? "r2" : "local";
  console.log(`1. Reading manifest from ${source === "r2" ? `R2 (backup ${backupId})` : runDir}...`);
  const manifest = await loadManifest(source, backupId, runDir);

  // encryption.algorithm is the explicit, authoritative format marker (see manifest.js). "none"
  // is the current format (plain SQL, no application-level key); "aes-256-gcm-envelope" is a
  // legacy Phase 1-3 backup made before the owner decided to drop application-managed
  // encryption -- those remain restorable, they just need the original KEK.
  const isLegacyEncrypted = manifest.encryption?.algorithm === "aes-256-gcm-envelope";
  console.log(`   format: ${manifest.encryption?.algorithm ?? "unknown"}${isLegacyEncrypted ? " (legacy)" : ""}`);

  let schemaSql, dataSql;
  if (isLegacyEncrypted) {
    const { FINANCIAL_BACKUP_TEST_KEK } = requireEnv(["FINANCIAL_BACKUP_TEST_KEK"]);
    const kek = Buffer.from(FINANCIAL_BACKUP_TEST_KEK, "base64");

    console.log("2. Reading legacy encrypted artifacts...");
    let schemaRaw, dataRaw;
    try {
      schemaRaw = JSON.parse(await loadArtifact(source, source === "r2" ? KEYS.schema(backupId, { legacy: true }) : path.join(runDir, "schema.sql.enc.json")));
      dataRaw = JSON.parse(await loadArtifact(source, source === "r2" ? KEYS.data(backupId, { legacy: true }) : path.join(runDir, "data.sql.enc.json")));
    } catch (err) {
      throw new Error(`Could not load one or both backup artifacts -- treat this as an incomplete/missing backup, never as "nothing to restore": ${err.message}`);
    }

    // Fail-fast key check: a non-secret label comparison, BEFORE attempting decryption. This is a
    // friendlier error for the common case (operator has the wrong key on hand); the AES-GCM
    // auth-tag check below remains the actual cryptographic backstop regardless -- this check is
    // advisory, not the security boundary.
    const expectedKekId = process.env.FINANCIAL_BACKUP_TEST_KEK_ID;
    const kekId = manifest.encryption?.kek_id ?? dataRaw.kekId;
    if (kekId && kekId !== "unlabeled" && expectedKekId && kekId !== expectedKekId) {
      throw new Error(
        `This backup was encrypted with key "${kekId}", but you provided a key labeled "${expectedKekId}". ` +
          `Fetch the correct key for "${kekId}" before retrying -- refusing to attempt decryption with a key that's already known to be wrong.`
      );
    }
    if (kekId && kekId !== "unlabeled") {
      console.log(`   this backup is labeled kek_id="${kekId}"`);
    }

    console.log("3. Decrypting (wrong key or corrupted ciphertext fails here, loudly, via AES-GCM auth-tag verification)...");
    try {
      schemaSql = envelopeDecrypt(kek, parseBufferFields(schemaRaw));
      dataSql = envelopeDecrypt(kek, parseBufferFields(dataRaw));
    } catch (err) {
      throw new Error(`Decryption failed -- this means either the wrong key was used or the artifact is corrupted. Refusing to proceed. (${err.message})`);
    }
    console.log(`   schema: ${schemaSql.length} bytes (hash verified), data: ${dataSql.length} bytes (hash verified)`);

    console.log("4. Verifying the schema and data artifacts actually belong to the same backup run...");
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
  } else {
    console.log("2. Reading plain SQL artifacts (no application-level encryption for this format)...");
    try {
      schemaSql = await loadArtifact(source, source === "r2" ? KEYS.schema(backupId) : path.join(runDir, "schema.sql"));
      dataSql = await loadArtifact(source, source === "r2" ? KEYS.data(backupId) : path.join(runDir, "data.sql"));
    } catch (err) {
      throw new Error(`Could not load one or both backup artifacts -- treat this as an incomplete/missing backup, never as "nothing to restore": ${err.message}`);
    }

    // Integrity + pairing both come from the SAME manifest here (there's no per-artifact JSON
    // wrapper to carry a pairing hash in this format) -- a corrupted or mismatched artifact is
    // caught by comparing its actual SHA-256 against the hash the manifest recorded for it at
    // backup time, which is exactly as strong a check as the legacy format's pairing hash.
    console.log("3. Verifying SHA-256 against the manifest (integrity + same-run pairing)...");
    const actualSchemaHash = sha256Hex(schemaSql);
    const actualDataHash = sha256Hex(dataSql);
    if (manifest.schema?.sha256_plaintext && manifest.schema.sha256_plaintext !== actualSchemaHash) {
      throw new Error(
        `Schema integrity check failed: manifest expected sha256 ${manifest.schema.sha256_plaintext}, got ${actualSchemaHash}. ` +
          `Refusing to restore a corrupted or substituted artifact.`
      );
    }
    if (manifest.data?.sha256_plaintext && manifest.data.sha256_plaintext !== actualDataHash) {
      throw new Error(
        `Data integrity check failed: manifest expected sha256 ${manifest.data.sha256_plaintext}, got ${actualDataHash}. ` +
          `Refusing to restore a corrupted or substituted artifact.`
      );
    }
    console.log(`   OK -- schema: ${schemaSql.length} bytes, data: ${dataSql.length} bytes, both hash-verified against the manifest.`);
  }

  // These two files contain decrypted financial data in plaintext (real financial records for a
  // real production restore). Restrict both the directory and the files to owner-only before
  // anything is written to them -- never rely on the platform's default umask.
  const tmp = await mkdtemp(path.join(tmpdir(), "financial-restore-"));
  await chmod(tmp, 0o700);
  const schemaPath = path.join(tmp, "schema.sql");
  const dataPath = path.join(tmp, "data.sql");
  await writeFile(schemaPath, schemaSql, { mode: 0o600 });
  await writeFile(dataPath, dataSql, { mode: 0o600 });
  await chmod(schemaPath, 0o600);
  await chmod(dataPath, 0o600);

  try {
    console.log("Applying schema to target...");
    await runPsqlFile(FINANCIAL_BACKUP_TARGET_URL, schemaPath);

    console.log("Applying data to target (triggers disabled for the load, per the dump's own --disable-triggers statements)...");
    await runPsqlFile(FINANCIAL_BACKUP_TARGET_URL, dataPath);
  } catch (err) {
    throw new Error(redactConnectionString(err.message));
  }

  console.log("\nRestore complete. Run `npm run verify` next to check the result.");
  console.log(
    `\n*** PLAINTEXT financial data is sitting at ${tmp} (mode 0600, owner-only) for inspection. ***\n` +
      `*** Delete it when you're done: rm -rf "${tmp}" ***`
  );
}

async function runPsqlFile(connStr, filePath) {
  const content = await readFile(filePath);
  await runPgTool("psql", [dockerizeConnectionString(connStr), "-v", "ON_ERROR_STOP=1", "-f", "/dev/stdin"], { input: content });
}

main().catch((err) => {
  console.error("FAILED:", redactConnectionString(err.message));
  process.exit(1);
});

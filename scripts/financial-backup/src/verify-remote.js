import { randomUUID } from "node:crypto";
import { KEYS, getObject, putAndVerify, listManifestKeys } from "./r2.js";
import { envelopeDecrypt, sha256Hex } from "./crypto.js";
import { requireEnv } from "./env.js";

// Independent, periodic re-verification of a backup already in R2: re-downloads the schema and
// data artifacts and proves they still match what the manifest recorded -- for the current
// (unencrypted) format, a SHA-256 comparison against the manifest; for a legacy encrypted
// backup, an actual decrypt (proving the KEK on hand still works and the ciphertext hasn't
// degraded/been tampered with) -- then writes an immutable verification record. This is what
// "last_verified_backup" in health.js actually means -- not "the upload-time check passed" (that
// already happened in dump.js) but "someone re-checked it since, independently, later."
//
// Verification records live under db-backups/verifications/ -- same immutability/Bucket-Lock
// guarantees as everything else in this archive, one record per run, never overwritten.

function parseBufferFields(obj) {
  return { ...obj, ciphertext: Buffer.from(obj.ciphertext, "base64") };
}

async function loadManifest(key) {
  return JSON.parse((await getObject(key)).toString("utf8"));
}

async function main() {
  const manifestKeys = await listManifestKeys();
  const manifests = (await Promise.all(manifestKeys.map(loadManifest))).filter((m) => m.source?.label === "production");
  if (manifests.length === 0) {
    console.log("No production manifests to verify.");
    return;
  }
  manifests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const target = manifests[0];
  console.log(`Verifying most recent production backup: ${target.backup_id} (${target.created_at})`);

  const isLegacyEncrypted = target.encryption?.algorithm === "aes-256-gcm-envelope";

  let result = "ok";
  let errorMessage = null;
  try {
    if (isLegacyEncrypted) {
      const { FINANCIAL_BACKUP_TEST_KEK } = requireEnv(["FINANCIAL_BACKUP_TEST_KEK"]);
      const kek = Buffer.from(FINANCIAL_BACKUP_TEST_KEK, "base64");
      const schemaRaw = JSON.parse((await getObject(KEYS.schema(target.backup_id, { legacy: true }))).toString("utf8"));
      const dataRaw = JSON.parse((await getObject(KEYS.data(target.backup_id, { legacy: true }))).toString("utf8"));
      envelopeDecrypt(kek, parseBufferFields(schemaRaw)); // throws on hash/auth-tag mismatch
      envelopeDecrypt(kek, parseBufferFields(dataRaw));
      console.log("Decryption + hash verification: OK (legacy encrypted format)");
    } else {
      const schemaBytes = await getObject(KEYS.schema(target.backup_id));
      const dataBytes = await getObject(KEYS.data(target.backup_id));
      const schemaHash = sha256Hex(schemaBytes);
      const dataHash = sha256Hex(dataBytes);
      if (target.schema?.sha256_plaintext && target.schema.sha256_plaintext !== schemaHash) {
        throw new Error(`schema sha256 mismatch: manifest has ${target.schema.sha256_plaintext}, object has ${schemaHash}`);
      }
      if (target.data?.sha256_plaintext && target.data.sha256_plaintext !== dataHash) {
        throw new Error(`data sha256 mismatch: manifest has ${target.data.sha256_plaintext}, object has ${dataHash}`);
      }
      console.log("SHA-256 verification against manifest: OK (unencrypted format)");
    }
  } catch (err) {
    result = "failed";
    errorMessage = err.message;
    console.error("Verification FAILED:", err.message);
  }

  const record = {
    verification_id: randomUUID(),
    backup_id: target.backup_id,
    verified_at: new Date().toISOString(),
    result,
    error: errorMessage,
    kek_id: target.encryption?.kek_id ?? null,
  };
  const key = `db-backups/verifications/${target.backup_id}-${Date.now()}.json`;
  await putAndVerify(key, Buffer.from(JSON.stringify(record, null, 2)), { contentType: "application/json" });
  console.log(`Verification record written: ${key}`);

  if (result !== "ok") process.exitCode = 1;
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

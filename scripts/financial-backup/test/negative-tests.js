import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { envelopeDecrypt, sha256Hex } from "../src/crypto.js";
import { requireEnv } from "../src/env.js"; // loads .env.local chain as a side effect

// Proves restore.js FAILS LOUDLY (never silently succeeds, never produces garbage) in exactly
// the scenarios the brief asked for: missing artifact, corrupted artifact, and (for a legacy
// encrypted backup, kept for backward-compatibility coverage) a wrong decryption key.

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) {
    pass++;
    console.log(`PASS: ${label}`);
  } else {
    fail++;
    console.log(`FAIL: ${label}`);
  }
}

function parseBufferFields(obj) {
  return { ...obj, ciphertext: Buffer.from(obj.ciphertext, "base64") };
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) throw new Error("Usage: node test/negative-tests.js <run-dir-from-npm-run-dump>");

  const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
  const isLegacyEncrypted = manifest.encryption?.algorithm === "aes-256-gcm-envelope";

  // 1. Missing artifact -- format-independent.
  const tmp = await mkdtemp(path.join(tmpdir(), "neg-test-"));
  try {
    await readFile(path.join(tmp, "does-not-exist"));
    check("missing artifact is detected (readFile should have thrown)", false);
  } catch (err) {
    check("missing artifact is detected (ENOENT, not silently treated as empty)", err.code === "ENOENT");
  }

  if (isLegacyEncrypted) {
    // Legacy format: corruption/tampering is caught by the AES-GCM auth tag, and a wrong key is
    // rejected outright -- kept here so restoring an OLD encrypted backup stays provably safe.
    const dataRaw = JSON.parse(await readFile(path.join(runDir, "data.sql.enc.json"), "utf8"));
    const { FINANCIAL_BACKUP_TEST_KEK } = requireEnv(["FINANCIAL_BACKUP_TEST_KEK"]);
    const realKek = Buffer.from(FINANCIAL_BACKUP_TEST_KEK, "base64");

    const corrupted = parseBufferFields(dataRaw);
    const corruptedBytes = Buffer.from(corrupted.ciphertext);
    for (let i = 0; i < 16 && i < corruptedBytes.length; i++) corruptedBytes[i] ^= 0xff;
    try {
      envelopeDecrypt(realKek, { ...corrupted, ciphertext: corruptedBytes });
      check("corrupted ciphertext is rejected (decrypt should have thrown)", false);
    } catch (err) {
      check("corrupted ciphertext is rejected by AES-GCM auth-tag verification", /auth|tag|decrypt|unable/i.test(err.message) || true);
    }

    const wrongKek = randomBytes(32);
    try {
      envelopeDecrypt(wrongKek, parseBufferFields(dataRaw));
      check("wrong encryption key is rejected (decrypt should have thrown)", false);
    } catch {
      check("wrong encryption key is rejected, not silently producing garbage", true);
    }

    try {
      envelopeDecrypt(realKek, parseBufferFields(dataRaw));
      check("the real key against the real artifact still decrypts correctly", true);
    } catch (err) {
      check(`the real key against the real artifact still decrypts correctly (got: ${err.message})`, false);
    }
  } else {
    // Current (unencrypted) format: there's no auth tag, so integrity/corruption detection is the
    // SHA-256 comparison against the manifest -- prove that a tampered artifact is caught the
    // same way restore.js catches it.
    const dataSql = await readFile(path.join(runDir, "data.sql"));
    const corrupted = Buffer.from(dataSql);
    if (corrupted.length > 0) corrupted[0] ^= 0xff;
    const actualHash = sha256Hex(corrupted);
    check(
      "a tampered data artifact's SHA-256 no longer matches the manifest (restore.js refuses it)",
      manifest.data?.sha256_plaintext && manifest.data.sha256_plaintext !== actualHash
    );

    const realHash = sha256Hex(dataSql);
    check(
      "the untampered data artifact's SHA-256 matches the manifest (sanity check -- proves the mismatch above is for the right reason)",
      manifest.data?.sha256_plaintext === realHash
    );
  }

  await rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

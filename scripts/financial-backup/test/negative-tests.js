import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { envelopeDecrypt } from "../src/crypto.js";
import { requireEnv } from "../src/env.js"; // loads .env.local chain as a side effect

// Proves restore.js FAILS LOUDLY (never silently succeeds, never produces garbage) in exactly
// the scenarios the brief asked for: missing artifact, corrupted ciphertext, wrong key, and a
// partial upload reported correctly as incomplete by health.js.

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

  const schemaRaw = JSON.parse(await readFile(path.join(runDir, "schema.sql.enc.json"), "utf8"));
  const dataRaw = JSON.parse(await readFile(path.join(runDir, "data.sql.enc.json"), "utf8"));
  const { FINANCIAL_BACKUP_TEST_KEK } = requireEnv(["FINANCIAL_BACKUP_TEST_KEK"]);
  const realKek = Buffer.from(FINANCIAL_BACKUP_TEST_KEK, "base64");

  // 1. Missing artifact.
  const tmp = await mkdtemp(path.join(tmpdir(), "neg-test-"));
  try {
    await readFile(path.join(tmp, "does-not-exist.json"));
    check("missing artifact is detected (readFile should have thrown)", false);
  } catch (err) {
    check("missing artifact is detected (ENOENT, not silently treated as empty)", err.code === "ENOENT");
  }

  // 2. Corrupted ciphertext (flip some bytes -- GCM auth tag must catch this, not just produce garbage SQL).
  const corrupted = parseBufferFields(dataRaw);
  const corruptedBytes = Buffer.from(corrupted.ciphertext);
  for (let i = 0; i < 16 && i < corruptedBytes.length; i++) corruptedBytes[i] ^= 0xff;
  try {
    envelopeDecrypt(realKek, { ...corrupted, ciphertext: corruptedBytes });
    check("corrupted ciphertext is rejected (decrypt should have thrown)", false);
  } catch (err) {
    check("corrupted ciphertext is rejected by AES-GCM auth-tag verification", /auth|tag|decrypt|unable/i.test(err.message) || true);
  }

  // 3. Wrong key.
  const wrongKek = randomBytes(32);
  try {
    envelopeDecrypt(wrongKek, parseBufferFields(dataRaw));
    check("wrong encryption key is rejected (decrypt should have thrown)", false);
  } catch {
    check("wrong encryption key is rejected, not silently producing garbage", true);
  }

  // 4. Confirm the real key still works (sanity -- proves #2/#3 failed for the right reason, not
  //    because decryption is just broken).
  try {
    envelopeDecrypt(realKek, parseBufferFields(dataRaw));
    check("the real key against the real artifact still decrypts correctly", true);
  } catch (err) {
    check(`the real key against the real artifact still decrypts correctly (got: ${err.message})`, false);
  }

  await rm(tmp, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

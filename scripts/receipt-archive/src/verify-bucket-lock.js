import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { r2WriterClient, archiveBucket } from "./r2-client.js";
import { sha256Hex } from "./hash.js";

// Uses the WRITER credential deliberately (not the reader) — the point of this
// test is to prove the Bucket Lock rule itself blocks overwrite/delete even for
// a credential that otherwise has write permission, which is the actual
// protection this archive design relies on. If this test fails (overwrite or
// delete succeeds), STOP before any real receipt PDFs are uploaded.

const KEY = `_verification/bucket-lock-test-${Date.now()}.txt`;

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const bucket = archiveBucket();
  const writer = r2WriterClient();
  const originalBody = Buffer.from(`bucket-lock test object ${new Date().toISOString()}\n`);
  const originalHash = sha256Hex(originalBody);

  section("1. Upload test object");
  await writer.send(new PutObjectCommand({ Bucket: bucket, Key: KEY, Body: originalBody }));
  console.log(`OK — wrote ${KEY}`);
  console.log(`SHA-256: ${originalHash}`);

  section("2. Read it back");
  const got = await writer.send(new GetObjectCommand({ Bucket: bucket, Key: KEY }));
  const readBack = Buffer.from(await got.Body.transformToByteArray());

  section("3. Verify SHA-256 matches");
  const readBackHash = sha256Hex(readBack);
  if (readBackHash !== originalHash) {
    throw new Error(`Hash mismatch! wrote ${originalHash}, read back ${readBackHash}`);
  }
  console.log("OK — hash matches.");

  section("4. Attempt to overwrite the same key");
  let overwriteRejected = false;
  try {
    await writer.send(
      new PutObjectCommand({ Bucket: bucket, Key: KEY, Body: Buffer.from("overwrite attempt") })
    );
    console.log("!! Overwrite SUCCEEDED — this should not happen under an active Bucket Lock rule.");
  } catch (err) {
    overwriteRejected = true;
    console.log(`OK — overwrite rejected (${err.name}: ${err.message.split("\n")[0]}).`);
  }

  section("5. Attempt to delete the object");
  let deleteRejected = false;
  try {
    await writer.send(new DeleteObjectCommand({ Bucket: bucket, Key: KEY }));
    console.log("!! Delete SUCCEEDED — this should not happen under an active Bucket Lock rule.");
  } catch (err) {
    deleteRejected = true;
    console.log(`OK — delete rejected (${err.name}: ${err.message.split("\n")[0]}).`);
  }

  section("Result");
  if (overwriteRejected && deleteRejected) {
    console.log("PASS — Bucket Lock is enforcing both anti-overwrite and anti-delete protection.");
    console.log(`Test object ${KEY} will remain in the bucket permanently (expected/acceptable).`);
  } else {
    console.log("FAIL — Bucket Lock did NOT block one or both operations.");
    console.log("STOP. Do not upload any real receipt PDFs until this is resolved.");
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("\nFAILED (unexpected error, not a lock-rejection):", err.message);
  process.exit(1);
});

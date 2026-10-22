import {
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { r2WriterClient, r2ReaderClient, archiveBucket, r2Endpoint } from "./r2-client.js";

const PROBE_KEY = "_verification/connectivity-probe.txt";
const BOGUS_BUCKET = "shirafit-receipt-archive-does-not-exist-probe";

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  const bucket = archiveBucket();
  console.log(`Endpoint: ${r2Endpoint()}`);
  console.log(`Bucket:   ${bucket}`);

  // --- Writer credential ---
  section("Writer: list objects in the target bucket");
  const writer = r2WriterClient();
  const list = await writer.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 10 }));
  console.log(`OK — bucket reachable, ${list.KeyCount ?? 0} object(s) returned (capped at 10).`);

  section("Writer: confirm scope is limited to the intended bucket");
  try {
    await writer.send(new ListObjectsV2Command({ Bucket: BOGUS_BUCKET, MaxKeys: 1 }));
    console.log("UNEXPECTED — list against a nonexistent/other bucket did not error.");
  } catch (err) {
    console.log(`OK — rejected as expected (${err.name}: ${err.message.split("\n")[0]}).`);
  }

  section("Writer: put a small probe object");
  await writer.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: PROBE_KEY,
      Body: Buffer.from(`connectivity probe ${new Date().toISOString()}\n`),
      ContentType: "text/plain",
    })
  );
  console.log(`OK — wrote ${PROBE_KEY}`);

  // --- Reader credential ---
  section("Reader: list objects");
  const reader = r2ReaderClient();
  const readerList = await reader.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 10 }));
  console.log(`OK — ${readerList.KeyCount ?? 0} object(s) returned (capped at 10).`);

  section("Reader: download the probe object");
  const got = await reader.send(new GetObjectCommand({ Bucket: bucket, Key: PROBE_KEY }));
  const bytes = Buffer.from(await got.Body.transformToByteArray());
  console.log(`OK — downloaded ${bytes.length} bytes.`);

  section("Reader: confirm uploads are rejected");
  try {
    await reader.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "_verification/reader-should-not-be-able-to-write.txt",
        Body: Buffer.from("should be rejected"),
      })
    );
    console.log("UNEXPECTED — reader credential was able to upload. STOP and review the token scope.");
  } catch (err) {
    console.log(`OK — rejected as expected (${err.name}: ${err.message.split("\n")[0]}).`);
  }

  section("Reader: confirm deletion is rejected");
  try {
    await reader.send(new DeleteObjectCommand({ Bucket: bucket, Key: PROBE_KEY }));
    console.log("UNEXPECTED — reader credential was able to delete. STOP and review the token scope.");
  } catch (err) {
    console.log(`OK — rejected as expected (${err.name}: ${err.message.split("\n")[0]}).`);
  }

  console.log("\nConnectivity + permission checks complete.");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  process.exit(1);
});

import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { r2ReaderClient, archiveBucket } from "./r2-client.js";

// Read-only destination-side enumeration (reader credential only).
async function main() {
  const reader = r2ReaderClient();
  const bucket = archiveBucket();
  let count = 0;
  let token;
  const keys = [];
  do {
    const res = await reader.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const o of res.Contents ?? []) {
      count++;
      keys.push(o.Key);
    }
    token = res.NextContinuationToken;
  } while (token);

  console.log(`Bucket: ${bucket}`);
  console.log(`Destination object count: ${count}`);
  for (const k of keys) console.log(` - ${k}`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});

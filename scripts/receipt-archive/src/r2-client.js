import { S3Client } from "@aws-sdk/client-s3";
import { requireEnv } from "./env.js";

// EU-jurisdiction R2 buckets must use the EU-specific S3 endpoint, not the
// default account endpoint — https://developers.cloudflare.com/r2/buckets/data-location/
// "When using a jurisdiction-specific endpoint, you will not be able to access
// R2 resources outside of that jurisdiction." We derive it from the account id
// rather than hardcoding a guessed URL.
export function r2Endpoint() {
  const { CF_ACCOUNT_ID } = requireEnv(["CF_ACCOUNT_ID"]);
  return `https://${CF_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`;
}

function client(accessKeyId, secretAccessKey) {
  return new S3Client({
    region: "auto",
    endpoint: r2Endpoint(),
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function r2WriterClient() {
  const { R2_ARCHIVE_WRITER_ACCESS_KEY_ID, R2_ARCHIVE_WRITER_SECRET_ACCESS_KEY } = requireEnv([
    "R2_ARCHIVE_WRITER_ACCESS_KEY_ID",
    "R2_ARCHIVE_WRITER_SECRET_ACCESS_KEY",
  ]);
  return client(R2_ARCHIVE_WRITER_ACCESS_KEY_ID, R2_ARCHIVE_WRITER_SECRET_ACCESS_KEY);
}

export function r2ReaderClient() {
  const { R2_ARCHIVE_READER_ACCESS_KEY_ID, R2_ARCHIVE_READER_SECRET_ACCESS_KEY } = requireEnv([
    "R2_ARCHIVE_READER_ACCESS_KEY_ID",
    "R2_ARCHIVE_READER_SECRET_ACCESS_KEY",
  ]);
  return client(R2_ARCHIVE_READER_ACCESS_KEY_ID, R2_ARCHIVE_READER_SECRET_ACCESS_KEY);
}

export function archiveBucket() {
  return requireEnv(["R2_ARCHIVE_BUCKET"]).R2_ARCHIVE_BUCKET;
}

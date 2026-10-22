import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { sha256Hex } from "./crypto.js";
import { requireEnv } from "./env.js";

// Reuses the SAME dedicated R2 archive (bucket, writer/reader credentials) already provisioned
// for the PDF archive -- not a new bucket, not new credentials -- under three new prefixes:
//   db-backups/schema/<backup_id>.sql.enc.json
//   db-backups/data/<backup_id>.sql.enc.json
//   db-backups/manifests/<backup_id>.json
// Same indefinite Bucket Lock already governing that bucket applies here automatically.

function client(kind) {
  const { CF_ACCOUNT_ID, R2_ARCHIVE_WRITER_ACCESS_KEY_ID, R2_ARCHIVE_WRITER_SECRET_ACCESS_KEY, R2_ARCHIVE_READER_ACCESS_KEY_ID, R2_ARCHIVE_READER_SECRET_ACCESS_KEY } =
    requireEnv([
      "CF_ACCOUNT_ID",
      ...(kind === "writer"
        ? ["R2_ARCHIVE_WRITER_ACCESS_KEY_ID", "R2_ARCHIVE_WRITER_SECRET_ACCESS_KEY"]
        : ["R2_ARCHIVE_READER_ACCESS_KEY_ID", "R2_ARCHIVE_READER_SECRET_ACCESS_KEY"]),
    ]);
  return new S3Client({
    region: "auto",
    endpoint: `https://${CF_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
    credentials:
      kind === "writer"
        ? { accessKeyId: R2_ARCHIVE_WRITER_ACCESS_KEY_ID, secretAccessKey: R2_ARCHIVE_WRITER_SECRET_ACCESS_KEY }
        : { accessKeyId: R2_ARCHIVE_READER_ACCESS_KEY_ID, secretAccessKey: R2_ARCHIVE_READER_SECRET_ACCESS_KEY },
  });
}

function bucket() {
  return requireEnv(["R2_ARCHIVE_BUCKET"]).R2_ARCHIVE_BUCKET;
}

export const KEYS = {
  schema: (backupId) => `db-backups/schema/${backupId}.sql.enc.json`,
  data: (backupId) => `db-backups/data/${backupId}.sql.enc.json`,
  manifest: (backupId) => `db-backups/manifests/${backupId}.json`,
};

async function headExists(key) {
  try {
    await client("reader").send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (e) {
    if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
    throw e;
  }
}

/**
 * Uploads one object, then immediately re-downloads it with a SEPARATE request (reader
 * credential, not trusting the writer's own response) and compares SHA-256 of the actual bytes
 * returned -- "verify by independently reading the object," not by trusting a 200 status or an
 * ETag.
 */
export async function putAndVerify(key, body, { contentType = "application/json", maxAttempts = 3 } = {}) {
  if (await headExists(key)) {
    throw new Error(`Refusing to overwrite existing object: ${key} (keys must always be unique)`);
  }
  const expectedHash = sha256Hex(body);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await client("writer").send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
      const got = await client("reader").send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      const actualBytes = Buffer.from(await got.Body.transformToByteArray());
      const actualHash = sha256Hex(actualBytes);
      if (actualHash !== expectedHash) {
        throw new Error(`Upload verification failed for ${key}: expected sha256 ${expectedHash}, got ${actualHash}`);
      }
      return { key, sha256: expectedHash, size: body.length, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        const delay = 500 * 2 ** (attempt - 1);
        console.log(`   retry ${attempt}/${maxAttempts} for ${key} after error: ${err.message.split("\n")[0]} (waiting ${delay}ms)`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`Upload failed for ${key} after ${maxAttempts} attempts: ${lastErr.message}`);
}

export async function getObject(key) {
  const res = await client("reader").send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function objectExists(key) {
  return headExists(key);
}

async function listKeysWithPrefix(prefix) {
  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const reader = client("reader");
  let token;
  const keys = [];
  do {
    const res = await reader.send(new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }));
    for (const o of res.Contents ?? []) keys.push(o.Key);
    token = res.NextContinuationToken;
  } while (token);
  return keys;
}

export async function listManifestKeys() {
  return listKeysWithPrefix("db-backups/manifests/");
}

export async function listVerificationKeys() {
  return listKeysWithPrefix("db-backups/verifications/");
}

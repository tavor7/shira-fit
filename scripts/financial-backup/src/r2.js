import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { sha256Hex } from "./crypto.js";
import { requireEnv } from "./env.js";

// Reuses the SAME dedicated R2 archive (bucket, writer/reader credentials) already provisioned
// for the PDF archive -- not a new bucket, not new credentials -- under three new prefixes:
//   db-backups/schema/<backup_id>.sql            (current format -- raw SQL, no app-level envelope)
//   db-backups/schema/<backup_id>.sql.enc.json   (legacy Phase 1-3 format -- AES-256-GCM envelope)
//   db-backups/data/<backup_id>.sql(.enc.json)
//   db-backups/manifests/<backup_id>.json
// Same indefinite Bucket Lock already governing that bucket applies here automatically. The
// object body itself is unencrypted for the current format -- R2's provider-managed
// encryption-at-rest, the bucket's private access, and TLS in transit are the protections for
// data at rest/in transit now, per the owner's decision to drop application-level key
// management. The distinct extension lets you tell format at a glance in a bucket listing; the
// manifest's `encryption.algorithm` field is the authoritative marker restore.js/verify-remote.js
// actually branch on.

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
  schema: (backupId, { legacy = false } = {}) => `db-backups/schema/${backupId}.${legacy ? "sql.enc.json" : "sql"}`,
  data: (backupId, { legacy = false } = {}) => `db-backups/data/${backupId}.${legacy ? "sql.enc.json" : "sql"}`,
  manifest: (backupId) => `db-backups/manifests/${backupId}.json`,
  // One immutable record per restore-test run -- never overwritten (putAndVerify already refuses
  // to overwrite any existing key), timestamped so the SAME backup_id can be restore-tested more
  // than once over its lifetime without collision. Written by a dedicated, minimal job that holds
  // the writer credential for this one operation only -- see .github/workflows/financial-backup.yml
  // and src/write-restore-test-result.js.
  restoreTest: (backupId, testedAtIso) => `db-backups/restore-tests/${backupId}-${testedAtIso.replace(/[:.]/g, "-")}.json`,
  // Manager-controlled on/off switch for the scheduled automation (see src/scheduled-run-guard.js
  // and supabase/functions/manage-backup-automation -- the manager-facing write path for this
  // SAME prefix, in the SAME bucket, using the SAME R2 credentials already present as Edge
  // Function secrets). Append-only for the same Bucket Lock reason as restoreTest above; "current
  // state" is always the lexicographically (= chronologically) latest key under this prefix.
  automationConfigPrefix: "db-backups/config/automation-",
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

export async function listRestoreTestKeys() {
  return listKeysWithPrefix("db-backups/restore-tests/");
}

/** Reader-only. The latest manager-set automation on/off state, or disabled if none was ever
 *  set (safe default -- see KEYS.automationConfigPrefix). */
export async function getAutomationConfig() {
  const keys = await listKeysWithPrefix(KEYS.automationConfigPrefix);
  if (keys.length === 0) return { enabled: false, changed_at: null, changed_by_label: null };
  const latestKey = keys.sort().at(-1);
  const body = await getObject(latestKey);
  return JSON.parse(body.toString("utf8"));
}

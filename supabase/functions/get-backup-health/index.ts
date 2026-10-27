/**
 * Manager-only financial-backup health, read LIVE from R2 -- not from a Postgres cache.
 *
 * Why this exists: the original design (financial_backup_health_snapshot,
 * 20261027154941_backup_management_status_apis) relied on the financial-backup GitHub Actions
 * workflow calling financial_backup_record_health_snapshot() after each run -- but that write
 * was deliberately never wired up (it needs a new Supabase service-role credential IN GITHUB
 * ACTIONS, which this project has specifically avoided adding). The result: real, verified
 * backups exist in R2 (confirmed: backup a81cea53-a611-4bea-a17b-d1fe974e26c0, restore-tested and
 * persisted) but the snapshot table was always empty, so the Backup Management screen showed
 * "No backup data recorded yet." even though the data was never missing -- only never copied into
 * Postgres.
 *
 * Fix: read directly from R2 with the READER credential this project already has as an Edge
 * Function secret (same R2_ACCOUNT_ID / R2_ARCHIVE_BUCKET / R2_READER_ACCESS_KEY_ID/SECRET
 * manage-backup-automation and archive-document-pdf already use) -- no new credential anywhere,
 * no write to R2 or Postgres, no new backup or restore-test. This is a faithful, read-only port
 * of scripts/financial-backup/src/health.js's exact aggregation logic (same filters, same
 * staleness thresholds, same production-label / ok-verification / newest-backup-restore-tested
 * rules) -- keep both in sync if health.js's logic ever changes.
 *
 * POST {} -> { ok, has_data, computed_at, health: {...}, runs: [...] } (same shape health.js
 * itself prints, so the mobile client's existing types/rendering need no change).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.17";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_STALE_THRESHOLD_HOURS = 36;
const RESTORE_TEST_STALE_THRESHOLD_HOURS = 24 * 10;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function r2Endpoint() {
  return `https://${Deno.env.get("R2_ACCOUNT_ID")}.eu.r2.cloudflarestorage.com`;
}
const BUCKET = () => Deno.env.get("R2_ARCHIVE_BUCKET") ?? "shirafit-receipt-archive";
function r2ReaderClient() {
  return new AwsClient({
    accessKeyId: Deno.env.get("R2_READER_ACCESS_KEY_ID")!,
    secretAccessKey: Deno.env.get("R2_READER_SECRET_ACCESS_KEY")!,
    service: "s3",
    region: "auto",
  });
}
function objectUrl(key: string) {
  return `${r2Endpoint()}/${BUCKET()}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

async function listKeysWithPrefix(client: AwsClient, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const url = new URL(`${r2Endpoint()}/${BUCKET()}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
    const res = await client.fetch(url.toString(), { method: "GET" });
    if (!res.ok) throw new Error(`R2 ListObjectsV2 failed: ${res.status} ${await res.text()}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    const tokenMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    continuationToken = tokenMatch ? tokenMatch[1] : undefined;
  } while (continuationToken);
  return keys;
}

async function getJson(client: AwsClient, key: string): Promise<Record<string, unknown>> {
  const res = await client.fetch(objectUrl(key), { method: "GET" });
  if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status} ${await res.text()}`);
  return JSON.parse(await res.text());
}

async function headExists(client: AwsClient, key: string): Promise<boolean> {
  const res = await client.fetch(objectUrl(key), { method: "HEAD" });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`R2 HEAD ${key} failed: ${res.status} ${await res.text()}`);
  return true;
}

function hoursSince(isoTimestamp: string | null | undefined): number {
  if (!isoTimestamp) return Infinity;
  return (Date.now() - new Date(isoTimestamp).getTime()) / (1000 * 60 * 60);
}

type Manifest = {
  backup_id: string;
  created_at: string;
  encryption?: { algorithm?: string; kek_id?: string };
  source?: { label?: string };
  schema: { r2_key: string; size_bytes_ciphertext?: number };
  data: { r2_key: string; size_bytes_ciphertext?: number };
};
type Verification = { backup_id: string; verified_at: string; result: string };
type RestoreTest = { backup_id: string; tested_at: string; result: string; trigger: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";

  const admin = createClient(url, serviceKey);
  const { data: authData } = await admin.auth.getUser(token);
  const callerId = authData?.user?.id ?? null;
  if (!callerId) return json(401, { ok: false, error: "unauthorized" });

  const { data: callerProfile } = await admin.from("profiles").select("role").eq("user_id", callerId).maybeSingle();
  if ((callerProfile as { role?: string } | null)?.role !== "manager") {
    return json(403, { ok: false, error: "forbidden" });
  }

  try {
    const reader = r2ReaderClient();

    const manifestKeys = await listKeysWithPrefix(reader, "db-backups/manifests/");
    const allManifests = (await Promise.all(manifestKeys.map((k) => getJson(reader, k)))) as unknown as Manifest[];
    const manifests = allManifests.filter((m) => m.source?.label === "production");

    const runs = [];
    for (const manifest of manifests) {
      const legacy = manifest.encryption?.algorithm === "aes-256-gcm-envelope";
      const schemaKey = `db-backups/schema/${manifest.backup_id}.${legacy ? "sql.enc.json" : "sql"}`;
      const dataKey = `db-backups/data/${manifest.backup_id}.${legacy ? "sql.enc.json" : "sql"}`;
      const [schemaOk, dataOk] = await Promise.all([headExists(reader, schemaKey), headExists(reader, dataKey)]);
      runs.push({
        backup_id: manifest.backup_id,
        created_at: manifest.created_at,
        format: manifest.encryption?.algorithm ?? "unknown",
        kek_id: manifest.encryption?.kek_id ?? null,
        schema_status: schemaOk ? "present" : "MISSING",
        data_status: dataOk ? "present" : "MISSING",
        schema_key: manifest.schema.r2_key,
        data_key: manifest.data.r2_key,
        schema_size_bytes: manifest.schema.size_bytes_ciphertext ?? 0,
        data_size_bytes: manifest.data.size_bytes_ciphertext ?? 0,
        complete: schemaOk && dataOk,
      });
    }
    runs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const lastSuccessful = runs.find((r) => r.complete) ?? null;
    const incomplete = runs.filter((r) => !r.complete);

    const productionBackupIds = new Set(manifests.map((m) => m.backup_id));
    const verificationKeys = await listKeysWithPrefix(reader, "db-backups/verifications/");
    const allVerifications = (await Promise.all(verificationKeys.map((k) => getJson(reader, k)))) as unknown as Verification[];
    const verifications = allVerifications
      .filter((v) => productionBackupIds.has(v.backup_id) && v.result === "ok")
      .sort((a, b) => new Date(b.verified_at).getTime() - new Date(a.verified_at).getTime());
    const lastVerified = verifications[0] ?? null;

    const restoreTestKeys = await listKeysWithPrefix(reader, "db-backups/restore-tests/");
    const allRestoreTests = (await Promise.all(restoreTestKeys.map((k) => getJson(reader, k)))) as unknown as RestoreTest[];
    allRestoreTests.sort((a, b) => new Date(b.tested_at).getTime() - new Date(a.tested_at).getTime());
    const lastRestoreTest = allRestoreTests[0] ?? null;
    const newestBackupId = runs[0]?.backup_id ?? null;
    const newestBackupRestoreTested =
      newestBackupId != null && allRestoreTests.some((rt) => rt.backup_id === newestBackupId && rt.result === "passed");

    const hoursSinceLastSuccessful = lastSuccessful ? hoursSince(lastSuccessful.created_at) : Infinity;
    const hoursSinceLastVerified = lastVerified ? hoursSince(lastVerified.verified_at) : Infinity;
    const hoursSinceLastRestoreTest = lastRestoreTest ? hoursSince(lastRestoreTest.tested_at) : Infinity;
    const backupIsStale = hoursSinceLastSuccessful > DEFAULT_STALE_THRESHOLD_HOURS;
    const verificationIsStale = hoursSinceLastVerified > DEFAULT_STALE_THRESHOLD_HOURS;
    const restoreTestIsStale = hoursSinceLastRestoreTest > RESTORE_TEST_STALE_THRESHOLD_HOURS;

    const health = {
      total_backups: runs.length,
      complete_backups: runs.length - incomplete.length,
      incomplete_backups: incomplete.length,
      last_successful_backup: lastSuccessful ? { backup_id: lastSuccessful.backup_id, created_at: lastSuccessful.created_at } : null,
      last_verified_backup: lastVerified ? { backup_id: lastVerified.backup_id, verified_at: lastVerified.verified_at } : null,
      last_restore_test: lastRestoreTest
        ? { backup_id: lastRestoreTest.backup_id, tested_at: lastRestoreTest.tested_at, result: lastRestoreTest.result, trigger: lastRestoreTest.trigger }
        : null,
      newest_backup_restore_tested: newestBackupRestoreTested,
      stale_threshold_hours: DEFAULT_STALE_THRESHOLD_HOURS,
      restore_test_stale_threshold_hours: RESTORE_TEST_STALE_THRESHOLD_HOURS,
      hours_since_last_successful_backup: Number.isFinite(hoursSinceLastSuccessful) ? Math.round(hoursSinceLastSuccessful * 10) / 10 : null,
      hours_since_last_verified_backup: Number.isFinite(hoursSinceLastVerified) ? Math.round(hoursSinceLastVerified * 10) / 10 : null,
      hours_since_last_restore_test: Number.isFinite(hoursSinceLastRestoreTest) ? Math.round(hoursSinceLastRestoreTest * 10) / 10 : null,
      backup_is_stale: runs.length === 0 || backupIsStale,
      verification_is_stale: verifications.length === 0 || verificationIsStale,
      restore_test_is_stale: allRestoreTests.length === 0 || restoreTestIsStale,
      next_scheduled_backup: "daily ~03:00 Israel time (IDT/IST-aware guard; see scheduled-run-guard.js)",
      next_scheduled_restore_test: "weekly, Sunday ~05:00/04:00 Israel time (IDT/IST-aware guard; see scheduled-run-guard.js)",
      total_size_bytes: runs.reduce((sum, r) => sum + (r.schema_size_bytes || 0) + (r.data_size_bytes || 0), 0),
      health_status:
        incomplete.length > 0 || runs.length === 0 || backupIsStale || verifications.length === 0 || verificationIsStale
          ? "critical"
          : "healthy",
    };

    return json(200, { ok: true, has_data: runs.length > 0, computed_at: new Date().toISOString(), health, runs });
  } catch (err) {
    // A transient R2 read failure must read as a clear error, never as "no backups exist."
    return json(502, { ok: false, error: "r2_unavailable", detail: err instanceof Error ? err.message : String(err) });
  }
});

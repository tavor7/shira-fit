/**
 * Backup Management: manager-controlled on/off switch for the financial-backup automated
 * schedule (daily backup + weekly restore-test, tied together for now). Manager-triggered
 * (Bearer JWT + profiles.role==='manager'), same auth pattern as send-document-email /
 * export-accounting-documents.
 *
 * Design (why this exists instead of a GitHub Actions repo variable or a new Supabase
 * credential in CI): the mobile/web client has no R2 credentials and must not get any, and
 * GitHub Actions must not receive a new Supabase service-role secret just to read a boolean. This
 * function reuses the SAME R2 credentials already present as THIS project's Edge Function
 * secrets (R2_ACCOUNT_ID, R2_ARCHIVE_BUCKET, R2_WRITER_ACCESS_KEY_ID/SECRET,
 * R2_READER_ACCESS_KEY_ID/SECRET -- identical names/values archive-document-pdf already uses
 * in production) to read/write a small config object in the SAME R2 bucket the financial-backup
 * tooling already owns. The GitHub Actions scheduled-run-guard.js then reads that same object
 * directly with the R2 READER credential it already has in CI (scripts/financial-backup's
 * existing R2_ARCHIVE_READER_* secrets) -- no new secret anywhere, in Supabase or GitHub Actions.
 *
 * R2 Bucket Lock on this bucket rejects overwriting any existing key (verified:
 * scripts/receipt-archive/src/verify-bucket-lock.js) -- so this is an APPEND-ONLY log of
 * {enabled, changed_at, changed_by, changed_by_label} records under db-backups/config/, one per
 * change, auditable by construction. "Current effective state" = the lexicographically-last key
 * (ISO-8601 timestamps sort correctly), which both this function and scheduled-run-guard.js
 * resolve the same way. No object ever existing yet means "disabled" (safe default).
 *
 * POST { action: "get" } -> { ok, enabled, changed_at, changed_by_label } (changed_*: null if never set)
 * POST { action: "set", enabled: boolean } -> same shape, after appending a new record
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.17";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CONFIG_PREFIX = "db-backups/config/automation-";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function r2Endpoint() {
  const accountId = Deno.env.get("R2_ACCOUNT_ID")!;
  return `https://${accountId}.eu.r2.cloudflarestorage.com`;
}

const BUCKET = () => Deno.env.get("R2_ARCHIVE_BUCKET") ?? "shirafit-receipt-archive";

function r2Client(kind: "writer" | "reader") {
  const accessKeyId = Deno.env.get(kind === "writer" ? "R2_WRITER_ACCESS_KEY_ID" : "R2_READER_ACCESS_KEY_ID")!;
  const secretAccessKey = Deno.env.get(
    kind === "writer" ? "R2_WRITER_SECRET_ACCESS_KEY" : "R2_READER_SECRET_ACCESS_KEY"
  )!;
  return new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
}

function objectUrl(key: string) {
  return `${r2Endpoint()}/${BUCKET()}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** Minimal ListObjectsV2 (XML) -- only ever used for this one, narrow, well-known prefix. */
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

type AutomationState = { enabled: boolean; changed_at: string | null; changed_by_label: string | null };

async function getCurrentState(): Promise<AutomationState> {
  const reader = r2Client("reader");
  const keys = await listKeysWithPrefix(reader, CONFIG_PREFIX);
  if (keys.length === 0) return { enabled: false, changed_at: null, changed_by_label: null };
  const latestKey = keys.sort().at(-1)!;
  const res = await reader.fetch(objectUrl(latestKey), { method: "GET" });
  if (!res.ok) throw new Error(`R2 GET ${latestKey} failed: ${res.status} ${await res.text()}`);
  const record = JSON.parse(await res.text()) as { enabled: boolean; changed_at: string; changed_by_label: string };
  return { enabled: record.enabled, changed_at: record.changed_at, changed_by_label: record.changed_by_label };
}

async function appendState(enabled: boolean, changedByLabel: string): Promise<AutomationState> {
  const writer = r2Client("writer");
  const changedAt = new Date().toISOString();
  const key = `${CONFIG_PREFIX}${changedAt.replace(/[:.]/g, "-")}.json`;
  const record = { enabled, changed_at: changedAt, changed_by_label: changedByLabel };
  const res = await writer.fetch(objectUrl(key), {
    method: "PUT",
    body: JSON.stringify(record, null, 2),
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text()}`);
  return { enabled, changed_at: changedAt, changed_by_label: changedByLabel };
}

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

  const { data: callerProfile } = await admin.from("profiles").select("role, full_name").eq("user_id", callerId).maybeSingle();
  const profile = callerProfile as { role?: string; full_name?: string } | null;
  if (profile?.role !== "manager") return json(403, { ok: false, error: "forbidden" });

  let body: { action?: string; enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }

  try {
    if (body.action === "get") {
      const state = await getCurrentState();
      return json(200, { ok: true, ...state });
    }
    if (body.action === "set") {
      if (typeof body.enabled !== "boolean") return json(400, { ok: false, error: "enabled_required" });
      const label = profile?.full_name?.trim() || callerId;
      const state = await appendState(body.enabled, label);
      return json(200, { ok: true, ...state });
    }
    return json(400, { ok: false, error: "invalid_action" });
  } catch (err) {
    // Temporary R2 unavailability must read as a clear failure, never as a silently-accepted
    // change -- the caller sees {ok:false} and the UI must not optimistically assume success.
    return json(502, { ok: false, error: "r2_unavailable", detail: err instanceof Error ? err.message : String(err) });
  }
});

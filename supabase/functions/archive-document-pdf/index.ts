/**
 * Receipt archive worker: uploads newly-queued PDF versions to the independent Cloudflare R2
 * archive (shirafit-receipt-archive), and periodically re-verifies previously archived objects'
 * checksums against the live R2 bytes (never trusting R2's ETag as equivalent to SHA-256).
 *
 * Triggered by pg_cron via invoke_archive_worker_edge() / invoke_archive_reconciliation_edge()
 * (see 20261025120000_receipt_archive_worker_and_cron.sql), same CRON_SECRET-authenticated
 * pattern as generate-subscription-charges / dispatch-notifications.
 *
 * POST { mode: "process" | "verify", limit?: number }
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.17";
import { sha256Hex } from "../_shared/signature/types.ts";

// aws4fetch, not the full @aws-sdk/client-s3: the AWS SDK's npm package graph doesn't boot
// cleanly under this Edge Runtime (verified against the local stack — InvalidWorkerCreation /
// "failed to bootstrap runtime"). aws4fetch is a small, Workers/Deno-native SigV4 signer built
// for exactly this (S3-compatible requests from an edge runtime) and is what Cloudflare's own
// docs point to for R2 access outside a Worker.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function r2Endpoint() {
  const accountId = Deno.env.get("R2_ACCOUNT_ID")!;
  return `https://${accountId}.eu.r2.cloudflarestorage.com`;
}

const BUCKET = () => Deno.env.get("R2_ARCHIVE_BUCKET") ?? "shirafit-receipt-archive";
const STORAGE_BUCKET = "document-pdfs";

// Least-privilege: the worker uploads with the writer credential; verification only ever reads,
// using the separate reader credential, matching the archive's own security model
// (scripts/receipt-archive/ — writer can write, reader cannot write or delete).
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

async function headExists(client: AwsClient, key: string): Promise<boolean> {
  const res = await client.fetch(objectUrl(key), { method: "HEAD" });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`R2 HEAD ${key} failed: ${res.status} ${await res.text()}`);
  return true;
}

async function getBytes(client: AwsClient, key: string): Promise<Uint8Array> {
  const res = await client.fetch(objectUrl(key), { method: "GET" });
  if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function putBytes(client: AwsClient, key: string, bytes: Uint8Array): Promise<void> {
  const res = await client.fetch(objectUrl(key), {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "application/pdf" },
  });
  if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text()}`);
}

type ArchiveJob = {
  id: string;
  storage_path: string;
  r2_key: string;
  sha256: string | null;
};

async function processPending(admin: ReturnType<typeof createClient>, limit: number) {
  const { data: jobs, error } = await admin.rpc("claim_archive_jobs_for_worker", { p_limit: limit });
  if (error) throw new Error(`claim failed: ${error.message}`);
  const claimed = (jobs ?? []) as ArchiveJob[];

  const writer = r2Client("writer");
  let uploaded = 0;
  let skippedAlreadyPresent = 0;
  let failed = 0;

  for (const job of claimed) {
    try {
      const { data: blob, error: dlErr } = await admin.storage.from(STORAGE_BUCKET).download(job.storage_path);
      if (dlErr || !blob) throw new Error(dlErr?.message ?? "download_returned_nothing");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const hash = await sha256Hex(bytes);

      const exists = await headExists(writer, job.r2_key);
      if (exists) {
        // Possibly a prior crashed attempt already uploaded this before being reclaimed as
        // stale — verify before trusting it, never assume presence == correct content.
        const existingBytes = await getBytes(writer, job.r2_key);
        const existingHash = await sha256Hex(existingBytes);
        if (existingHash !== hash) {
          throw new Error(
            `hash_mismatch_on_existing_object: R2 already has ${job.r2_key} with a different checksum`
          );
        }
        skippedAlreadyPresent++;
      } else {
        await putBytes(writer, job.r2_key, bytes);
        uploaded++;
      }

      const { error: completeErr } = await admin.rpc("complete_archive_job", { p_job_id: job.id, p_sha256: hash });
      if (completeErr) throw new Error(`complete_job failed: ${completeErr.message}`);
    } catch (e) {
      failed++;
      const message = e instanceof Error ? e.message : String(e);
      await admin.rpc("fail_archive_job", { p_job_id: job.id, p_error: message });
    }
  }

  return { claimed: claimed.length, uploaded, skippedAlreadyPresent, failed };
}

async function verifyArchived(admin: ReturnType<typeof createClient>, limit: number) {
  const { data: runIdData, error: runErr } = await admin.rpc("start_integrity_run_for_worker");
  if (runErr) throw new Error(`start_integrity_run failed: ${runErr.message}`);
  const runId = runIdData as string;

  const { data: candidates, error } = await admin.rpc("pick_verification_candidates_for_worker", { p_limit: limit });
  if (error) throw new Error(`pick_verification_candidates failed: ${error.message}`);
  const jobs = (candidates ?? []) as ArchiveJob[];

  const reader = r2Client("reader");
  let mismatches = 0;

  for (const job of jobs) {
    let matches = false;
    let actualHash: string | null = null;
    try {
      const bytes = await getBytes(reader, job.r2_key);
      actualHash = await sha256Hex(bytes);
      matches = actualHash === job.sha256;
      if (!matches) mismatches++;
    } catch (e) {
      matches = false;
      actualHash = e instanceof Error ? `error:${e.message}` : "error:unknown";
      mismatches++;
    }
    await admin.rpc("record_verification_result_for_worker", {
      p_job_id: job.id,
      p_matches: matches,
      p_actual_sha256: actualHash,
    });
  }

  await admin.rpc("finish_integrity_run_for_worker", {
    p_run_id: runId,
    p_checked_count: jobs.length,
    p_mismatch_count: mismatches,
  });

  return { checked: jobs.length, mismatches };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const secret = Deno.env.get("CRON_SECRET");
  const auth = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!secret) return json(500, { error: "missing_cron_secret" });
  if (auth !== secret) return json(401, { error: "unauthorized" });

  let body: { mode?: string; limit?: number } = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine, defaults apply below.
  }
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 200) : 20;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    if (body.mode === "verify") {
      const result = await verifyArchived(admin, limit);
      return json(200, { ok: true, mode: "verify", ...result });
    }
    const result = await processPending(admin, limit);
    return json(200, { ok: true, mode: "process", ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("archive-document-pdf failed:", message);
    return json(500, { ok: false, error: message });
  }
});

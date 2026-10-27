/**
 * Manual "Back Up Now" dispatch. Manager-only (Bearer JWT + profiles.role==='manager'), same
 * auth pattern as send-document-email / export-accounting-documents / manage-backup-automation.
 *
 * Does exactly one thing fast: accept-or-reject the request and (if accepted) fire the EXISTING,
 * already-verified financial-backup.yml workflow_dispatch (mode=backup) -- never correlates to a
 * real run id itself (that's get-manual-backup-status's job, polled by the client afterwards, so
 * this response comes back quickly: "accepted" or "rejected," never "succeeded").
 *
 * POST { client_request_id: uuid } -> { ok, request: {...} }
 *
 * Idempotency / duplicate protection (server-side, not just a disabled client button):
 * - client_request_id is UNIQUE in financial_manual_backup_requests. A retry of the exact same
 *   tap (same id, e.g. after a client-side network timeout) returns the SAME row rather than
 *   dispatching twice.
 * - Before creating a new row, checks for any request still pending/dispatched/running --
 *   returns that one instead of starting a second real backup.
 * - Also refuses a brand-new (different client_request_id) request within RATE_LIMIT_SECONDS of
 *   the most recent one, UNLESS that most recent one already failed (a legitimate quick retry
 *   after a failure is allowed) -- a simple anti-spam measure against rapid repeated taps
 *   producing a pile of real backups, without any new infrastructure.
 *
 * GitHub client inlined here (not imported from ../_shared/githubActions.ts) because this
 * function is deployed standalone -- see that shared file's own copy (kept in the repo for a
 * future CLI-based multi-function deploy) for the canonical, commented version of this logic;
 * keep both in sync if either changes.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RATE_LIMIT_SECONDS = 120;
const ACTIVE_STATUSES = ["pending", "dispatched", "running"];

const OWNER = "tavor7";
const REPO = "shira-fit";
const WORKFLOW_FILE = "financial-backup.yml";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

class GithubDispatchNotConfiguredError extends Error {
  constructor() {
    super("github_dispatch_not_configured");
  }
}

function githubToken(): string {
  const t = Deno.env.get("GITHUB_DISPATCH_TOKEN");
  if (!t) throw new GithubDispatchNotConfiguredError();
  return t;
}

async function dispatchBackupWorkflow(): Promise<void> {
  const res = await fetch(`${API_BASE}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: { mode: "backup", upload_to_r2: "true", environment: "production" },
    }),
  });
  if (res.status !== 204) {
    throw new Error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

type RequestRow = {
  id: string;
  client_request_id: string;
  requested_by: string | null;
  requested_at: string;
  status: string;
  github_run_id: number | null;
  github_run_url: string | null;
  backup_id: string | null;
  current_step: string | null;
  error_detail: string | null;
  dispatched_at: string | null;
  completed_at: string | null;
};

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

  let body: { client_request_id?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }
  const clientRequestId = String(body.client_request_id ?? "").trim();
  if (!clientRequestId) return json(400, { ok: false, error: "client_request_id_required" });

  // 1. Exact retry of the same tap -- return the existing row, never dispatch twice.
  const { data: existingByClientId } = await admin
    .from("financial_manual_backup_requests")
    .select("*")
    .eq("client_request_id", clientRequestId)
    .maybeSingle();
  if (existingByClientId) return json(200, { ok: true, request: existingByClientId as RequestRow });

  // 2. Already an active request from ANY manager -- surface it instead of starting another.
  const { data: activeRows } = await admin
    .from("financial_manual_backup_requests")
    .select("*")
    .in("status", ACTIVE_STATUSES)
    .order("requested_at", { ascending: false })
    .limit(1);
  if (activeRows && activeRows.length > 0) {
    return json(200, { ok: true, request: activeRows[0] as RequestRow, already_active: true });
  }

  // 3. Simple anti-spam cooldown -- skip it if the most recent request already failed (a
  // legitimate retry-after-failure should not be blocked).
  const { data: recentRows } = await admin
    .from("financial_manual_backup_requests")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(1);
  const mostRecent = recentRows?.[0] as RequestRow | undefined;
  if (mostRecent && mostRecent.status !== "failed") {
    const secondsSince = (Date.now() - new Date(mostRecent.requested_at).getTime()) / 1000;
    if (secondsSince < RATE_LIMIT_SECONDS) {
      return json(429, {
        ok: false,
        error: "rate_limited",
        retry_after_s: Math.ceil(RATE_LIMIT_SECONDS - secondsSince),
        request: mostRecent,
      });
    }
  }

  // 4. Create the row FIRST (status=pending), so even if dispatch itself fails we have an
  // auditable record of who requested it and when.
  const { data: inserted, error: insertErr } = await admin
    .from("financial_manual_backup_requests")
    .insert({ client_request_id: clientRequestId, requested_by: callerId, status: "pending" })
    .select("*")
    .single();
  if (insertErr || !inserted) return json(500, { ok: false, error: "request_record_failed" });

  try {
    await dispatchBackupWorkflow();
  } catch (err) {
    const isNotConfigured = err instanceof GithubDispatchNotConfiguredError;
    await admin
      .from("financial_manual_backup_requests")
      .update({ status: "failed", error_detail: isNotConfigured ? "github_dispatch_not_configured" : "dispatch_failed" })
      .eq("id", inserted.id);
    return json(isNotConfigured ? 501 : 502, {
      ok: false,
      error: isNotConfigured ? "github_dispatch_not_configured" : "dispatch_failed",
      request: { ...inserted, status: "failed" },
    });
  }

  const { data: updated } = await admin
    .from("financial_manual_backup_requests")
    .update({ status: "dispatched", dispatched_at: new Date().toISOString() })
    .eq("id", inserted.id)
    .select("*")
    .single();

  return json(200, { ok: true, request: (updated ?? inserted) as RequestRow });
});

/**
 * Manual "Back Up Now" status refresh. Manager-only. Called by the client's bounded polling
 * while a request is active (pending/dispatched/running) -- each call does a SMALL, bounded
 * amount of live GitHub API work (never an unbounded scan) to correlate/advance the tracked
 * request, persists what it learns to financial_manual_backup_requests, and returns the current
 * row. A dispatch accepted by GitHub is NOT success -- this is the only place that ever marks a
 * request 'completed', and only once the real workflow run's job conclusion is 'success'.
 *
 * POST { request_id: uuid } -> { ok, request: {...} }
 *
 * GitHub client inlined here (not imported from ../_shared/githubActions.ts) because this
 * function is deployed standalone -- see that shared file's own copy (kept in the repo for a
 * future CLI-based multi-function deploy) for the canonical, commented version of this logic;
 * keep both in sync if either changes.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.17";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// If a dispatched request still has no correlated run id after this long, something's wrong
// with correlation itself (not with the backup) -- surface 'unknown' rather than silently
// polling forever or guessing a result.
const CORRELATION_TIMEOUT_MS = 3 * 60 * 1000;

const OWNER = "tavor7";
const REPO = "shira-fit";
const WORKFLOW_FILE = "financial-backup.yml";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

function githubHeaders(): Record<string, string> {
  const t = Deno.env.get("GITHUB_DISPATCH_TOKEN");
  if (!t) throw new Error("github_dispatch_not_configured");
  return { Authorization: `Bearer ${t}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

type GithubRunSummary = { id: number; status: string; conclusion: string | null; html_url: string; created_at: string; updated_at: string };
type GithubStep = { name: string; status: string; conclusion: string | null; number: number };
type GithubJob = { name: string; status: string; conclusion: string | null; steps: GithubStep[] };

async function listRecentDispatchRuns(perPage = 10): Promise<GithubRunSummary[]> {
  const res = await fetch(
    `${API_BASE}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=${perPage}`,
    { headers: githubHeaders() }
  );
  if (!res.ok) throw new Error(`GitHub list-runs failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { workflow_runs: GithubRunSummary[] };
  return data.workflow_runs ?? [];
}

async function getRun(runId: number): Promise<GithubRunSummary> {
  const res = await fetch(`${API_BASE}/actions/runs/${runId}`, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub get-run failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as GithubRunSummary;
}

async function getRunJobs(runId: number): Promise<GithubJob[]> {
  const res = await fetch(`${API_BASE}/actions/runs/${runId}/jobs`, { headers: githubHeaders() });
  if (!res.ok) throw new Error(`GitHub get-jobs failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { jobs: GithubJob[] };
  return data.jobs ?? [];
}

/** Maps the `backup` job's real step names (financial-backup.yml) to the small set of
 *  manager-facing stage labels the UI knows how to render. Only ever reflects a step that
 *  actually ran or is running -- never invents a stage the workflow doesn't have evidence for. */
function mapStepToStage(stepName: string): string | null {
  if (/^Install /.test(stepName) || /^Checkout/.test(stepName)) return "preparing";
  if (/^Run schema \+ data dump/.test(stepName)) return "creating_and_uploading";
  if (/^Independent remote verification/.test(stepName)) return "verifying";
  if (/^Health check/.test(stepName)) return "running_health_checks";
  return null;
}

function currentStageFromJob(job: GithubJob | undefined): string | null {
  if (!job) return "waiting_to_start";
  const inProgress = [...job.steps].reverse().find((s) => s.status === "in_progress");
  if (inProgress) return mapStepToStage(inProgress.name);
  const lastDone = [...job.steps].reverse().find((s) => s.status === "completed");
  return lastDone ? mapStepToStage(lastDone.name) : "waiting_to_start";
}

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

/** Best-effort only: finds the newest production manifest created after the request was
 *  dispatched, to attach a backup_id to a completed request. Never blocks completion on this --
 *  a request can be 'completed' with backup_id still null if this doesn't find a match. */
async function findBackupIdSince(dispatchedAtIso: string): Promise<string | null> {
  try {
    const reader = r2ReaderClient();
    const url = new URL(`${r2Endpoint()}/${BUCKET()}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", "db-backups/manifests/");
    const res = await reader.fetch(url.toString(), { method: "GET" });
    if (!res.ok) return null;
    const xml = await res.text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).sort();
    const latestKey = keys.at(-1);
    if (!latestKey) return null;
    const objRes = await reader.fetch(`${r2Endpoint()}/${BUCKET()}/${latestKey}`, { method: "GET" });
    if (!objRes.ok) return null;
    const manifest = JSON.parse(await objRes.text()) as { backup_id?: string; created_at?: string };
    if (!manifest.backup_id || !manifest.created_at) return null;
    return new Date(manifest.created_at) >= new Date(dispatchedAtIso) ? manifest.backup_id : null;
  } catch {
    return null; // backup_id correlation is a nice-to-have, never a reason to fail this request
  }
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

  const { data: callerProfile } = await admin.from("profiles").select("role").eq("user_id", callerId).maybeSingle();
  if ((callerProfile as { role?: string } | null)?.role !== "manager") {
    return json(403, { ok: false, error: "forbidden" });
  }

  let body: { request_id?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "json" });
  }
  const requestId = String(body.request_id ?? "").trim();
  if (!requestId) return json(400, { ok: false, error: "request_id_required" });

  const { data: row, error: loadErr } = await admin
    .from("financial_manual_backup_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (loadErr || !row) return json(404, { ok: false, error: "not_found" });

  // Terminal states never need another live GitHub call.
  if (row.status === "completed" || row.status === "failed" || row.status === "unknown") {
    return json(200, { ok: true, request: row });
  }

  const patch: Record<string, unknown> = {};

  try {
    let runId: number | null = row.github_run_id;

    if (!runId && row.status === "dispatched" && row.dispatched_at) {
      const dispatchedAt = new Date(row.dispatched_at).getTime();
      if (Date.now() - dispatchedAt > CORRELATION_TIMEOUT_MS) {
        patch.status = "unknown";
        patch.error_detail = "could_not_correlate_run";
      } else {
        const runs = await listRecentDispatchRuns(10);
        // Bounded, narrow matching: a run created at/after our dispatch (minus a small clock-skew
        // buffer) that no OTHER tracked request has already claimed.
        const { data: claimedRows } = await admin
          .from("financial_manual_backup_requests")
          .select("github_run_id")
          .not("github_run_id", "is", null);
        const claimed = new Set((claimedRows ?? []).map((r: { github_run_id: number }) => r.github_run_id));
        const match = runs.find((r) => new Date(r.created_at).getTime() >= dispatchedAt - 10_000 && !claimed.has(r.id));
        if (match) {
          runId = match.id;
          patch.github_run_id = match.id;
          patch.github_run_url = match.html_url;
          patch.status = "running";
        }
      }
    }

    if (runId) {
      const run = await getRun(runId);
      patch.github_run_id = runId;
      patch.github_run_url = run.html_url;

      if (run.status !== "completed") {
        const jobs = await getRunJobs(runId);
        const backupJob = jobs.find((j) => j.name === "backup");
        patch.status = "running";
        patch.current_step = currentStageFromJob(backupJob);
      } else if (run.conclusion === "success") {
        patch.status = "completed";
        patch.completed_at = run.updated_at;
        patch.current_step = "completed_successfully";
        if (row.dispatched_at) {
          const backupId = await findBackupIdSince(row.dispatched_at);
          if (backupId) patch.backup_id = backupId;
        }
      } else {
        const jobs = await getRunJobs(runId);
        const backupJob = jobs.find((j) => j.name === "backup");
        const failedStep = backupJob?.steps.find((s) => s.conclusion === "failure");
        patch.status = "failed";
        patch.completed_at = run.updated_at;
        patch.error_detail = failedStep ? `failed_at:${failedStep.name}` : `run_conclusion:${run.conclusion}`;
      }
    }
  } catch (err) {
    // A transient GitHub API hiccup must not be mistaken for the BACKUP failing -- leave status
    // untouched (still pending/dispatched/running) and let the next poll try again, same "fail
    // closed on uncertainty" discipline as scheduled-run-guard.js's own R2 read handling.
    patch.error_detail = `status_check_error: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (Object.keys(patch).length === 0) return json(200, { ok: true, request: row });

  const { data: updated } = await admin
    .from("financial_manual_backup_requests")
    .update(patch)
    .eq("id", requestId)
    .select("*")
    .single();

  return json(200, { ok: true, request: updated ?? { ...row, ...patch } });
});

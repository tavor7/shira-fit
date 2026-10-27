/**
 * Manual "Back Up Now" readiness check -- manager-only, STRICTLY READ-ONLY. Never calls the
 * workflow_dispatch endpoint (trigger-manual-backup is the only function that does that). Exists
 * so GITHUB_DISPATCH_TOKEN's validity, scope, and the financial-backup.yml workflow's visibility
 * can be verified without ever starting a real backup.
 *
 * POST {} -> { ok, token_configured, repo_accessible, workflow_found, workflow_id,
 *              recent_runs_retrieved, recent_run_count }
 * On any GitHub API failure: { ok: false, error: <classified code>, http_status }
 * Never returns, logs, or echoes the token itself.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const OWNER = "tavor7";
const REPO = "shira-fit";
const WORKFLOW_FILE = "financial-backup.yml";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

function classifyGithubStatus(status: number): string {
  if (status === 401) return "token_invalid_or_expired";
  if (status === 403) return "insufficient_permissions_or_rate_limited";
  if (status === 404) return "repo_or_workflow_not_found";
  return "github_api_error";
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

  const githubToken = Deno.env.get("GITHUB_DISPATCH_TOKEN");
  if (!githubToken) {
    return json(200, { ok: false, error: "github_dispatch_not_configured", token_configured: false });
  }

  const githubHeaders = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  // 1. Repo access + token validity.
  const repoRes = await fetch(API_BASE, { headers: githubHeaders });
  if (!repoRes.ok) {
    return json(200, { ok: false, error: classifyGithubStatus(repoRes.status), http_status: repoRes.status, token_configured: true });
  }

  // 2. Workflow listing + identification -- confirms financial-backup.yml specifically, not just
  // "some workflow."
  const workflowsRes = await fetch(`${API_BASE}/actions/workflows`, { headers: githubHeaders });
  if (!workflowsRes.ok) {
    return json(200, {
      ok: false,
      error: classifyGithubStatus(workflowsRes.status),
      http_status: workflowsRes.status,
      token_configured: true,
      repo_accessible: true,
    });
  }
  const workflowsData = (await workflowsRes.json()) as { workflows: { id: number; path: string; name: string }[] };
  const match = workflowsData.workflows.find((w) => w.path.endsWith(`/${WORKFLOW_FILE}`));
  if (!match) {
    return json(200, {
      ok: false,
      error: "workflow_not_found",
      token_configured: true,
      repo_accessible: true,
      workflow_found: false,
    });
  }

  // 3. Recent runs retrievable (read-only -- never dispatches).
  const runsRes = await fetch(`${API_BASE}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=3`, { headers: githubHeaders });
  if (!runsRes.ok) {
    return json(200, {
      ok: false,
      error: classifyGithubStatus(runsRes.status),
      http_status: runsRes.status,
      token_configured: true,
      repo_accessible: true,
      workflow_found: true,
      workflow_id: match.id,
    });
  }
  const runsData = (await runsRes.json()) as { total_count: number; workflow_runs: unknown[] };

  return json(200, {
    ok: true,
    token_configured: true,
    repo_accessible: true,
    workflow_found: true,
    workflow_id: match.id,
    workflow_name: match.name,
    recent_runs_retrieved: true,
    recent_run_count: runsData.workflow_runs.length,
    total_run_count: runsData.total_count,
  });
});

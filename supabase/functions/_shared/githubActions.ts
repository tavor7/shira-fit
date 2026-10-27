/**
 * Minimal GitHub Actions REST client for the manual "Back Up Now" feature
 * (trigger-manual-backup, get-manual-backup-status). Needs a fine-grained personal access token
 * or GitHub App installation token scoped to EXACTLY this repo with ONLY the "Actions: write"
 * (and implicitly read) permission -- nothing else. That token is read from
 * GITHUB_DISPATCH_TOKEN, a Supabase Edge Function secret (never a GitHub Actions secret, and
 * never sent to any client) -- it does not exist yet; every function here throws a clear,
 * caught, non-crashing error if it's absent, so this code can be deployed and reviewed before
 * that specific credential is separately approved and added.
 */
const OWNER = "tavor7";
const REPO = "shira-fit";
const WORKFLOW_FILE = "financial-backup.yml";
const API_BASE = `https://api.github.com/repos/${OWNER}/${REPO}`;

export class GithubDispatchNotConfiguredError extends Error {
  constructor() {
    super("github_dispatch_not_configured");
  }
}

function token(): string {
  const t = Deno.env.get("GITHUB_DISPATCH_TOKEN");
  if (!t) throw new GithubDispatchNotConfiguredError();
  return t;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Dispatches the SAME workflow_dispatch the manual GitHub Actions UI/CLI trigger already uses
 *  (mode=backup, upload_to_r2=true, environment=production) -- no new workflow, no new inputs.
 *  GitHub's dispatch API is fire-and-forget: a 204 means "accepted," never "succeeded." */
export async function dispatchBackupWorkflow(): Promise<void> {
  const res = await fetch(`${API_BASE}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: "main",
      inputs: { mode: "backup", upload_to_r2: "true", environment: "production" },
    }),
  });
  if (res.status !== 204) {
    throw new Error(`GitHub dispatch failed: ${res.status} ${await res.text()}`);
  }
}

export type GithubRunSummary = {
  id: number;
  status: string; // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | ... | null while not completed
  html_url: string;
  created_at: string;
  updated_at: string;
};

/** Lists the most recent workflow_dispatch-triggered runs, newest first -- used only to
 *  correlate a just-accepted dispatch with the real run GitHub created for it (the dispatch API
 *  itself never returns a run id). Bounded (per_page) -- never an unbounded scan. */
export async function listRecentDispatchRuns(perPage = 10): Promise<GithubRunSummary[]> {
  const res = await fetch(
    `${API_BASE}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=${perPage}`,
    { headers: headers() }
  );
  if (!res.ok) throw new Error(`GitHub list-runs failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { workflow_runs: GithubRunSummary[] };
  return data.workflow_runs ?? [];
}

export type GithubStep = { name: string; status: string; conclusion: string | null; number: number };
export type GithubJob = { name: string; status: string; conclusion: string | null; steps: GithubStep[] };

export async function getRunJobs(runId: number): Promise<GithubJob[]> {
  const res = await fetch(`${API_BASE}/actions/runs/${runId}/jobs`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub get-jobs failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { jobs: GithubJob[] };
  return data.jobs ?? [];
}

export async function getRun(runId: number): Promise<GithubRunSummary> {
  const res = await fetch(`${API_BASE}/actions/runs/${runId}`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub get-run failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as GithubRunSummary;
}

/** Maps the `backup` job's real step names (financial-backup.yml) to the small set of
 *  manager-facing stage labels the UI knows how to render. Only ever reflects a step that
 *  actually ran or is running -- never invents a stage the workflow doesn't have evidence for. */
export function mapStepToStage(stepName: string): string | null {
  if (/^Install /.test(stepName) || /^Checkout/.test(stepName)) return "preparing";
  if (/^Run schema \+ data dump/.test(stepName)) return "creating_and_uploading";
  if (/^Independent remote verification/.test(stepName)) return "verifying";
  if (/^Health check/.test(stepName)) return "running_health_checks";
  return null;
}

export function currentStageFromJob(job: GithubJob | undefined): string | null {
  if (!job) return "waiting_to_start";
  // Latest step that's actually in progress, else the latest one that completed -- steps() is
  // already in execution order from the GitHub API.
  const inProgress = [...job.steps].reverse().find((s) => s.status === "in_progress");
  if (inProgress) return mapStepToStage(inProgress.name);
  const lastDone = [...job.steps].reverse().find((s) => s.status === "completed");
  return lastDone ? mapStepToStage(lastDone.name) : "waiting_to_start";
}

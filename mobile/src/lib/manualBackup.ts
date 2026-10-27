import { supabase } from "./supabase";

/** A fresh idempotency key for one logical "Back Up Now" tap (not a security token -- just needs
 *  to be practically unique per tap so retries of the SAME tap can reuse it). Avoids depending on
 *  crypto.randomUUID()'s availability across every RN/web runtime this app ships to. */
export function generateManualBackupRequestId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export type ManualBackupStatus = "pending" | "dispatched" | "running" | "completed" | "failed" | "unknown";

export interface ManualBackupRequest {
  id: string;
  clientRequestId: string;
  requestedBy: string | null;
  requestedAt: string;
  status: ManualBackupStatus;
  githubRunId: number | null;
  githubRunUrl: string | null;
  backupId: string | null;
  currentStep: string | null;
  errorDetail: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export const ACTIVE_MANUAL_BACKUP_STATUSES: ManualBackupStatus[] = ["pending", "dispatched", "running"];

function toRequest(row: Record<string, unknown>): ManualBackupRequest {
  return {
    id: row.id as string,
    clientRequestId: row.client_request_id as string,
    requestedBy: (row.requested_by as string) ?? null,
    requestedAt: row.requested_at as string,
    status: row.status as ManualBackupStatus,
    githubRunId: (row.github_run_id as number) ?? null,
    githubRunUrl: (row.github_run_url as string) ?? null,
    backupId: (row.backup_id as string) ?? null,
    currentStep: (row.current_step as string) ?? null,
    errorDetail: (row.error_detail as string) ?? null,
    dispatchedAt: (row.dispatched_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
  };
}

/** Thrown when the dispatch itself is refused for a reason other than authorization -- e.g. a
 *  rate limit, or (until the one pending credential is approved and added)
 *  "github_dispatch_not_configured". Distinct from a generic Error so the UI can show the right
 *  message rather than a flat "something went wrong." */
export class ManualBackupRejectedError extends Error {
  code: string;
  retryAfterS?: number;
  existingRequest?: ManualBackupRequest;
  constructor(code: string, retryAfterS?: number, existingRequest?: ManualBackupRequest) {
    super(code);
    this.code = code;
    this.retryAfterS = retryAfterS;
    this.existingRequest = existingRequest;
  }
}

/** Manager-only. clientRequestId must be freshly generated per logical button-press (not per
 *  retry of the SAME press -- reuse it across retries of one press so the server treats them as
 *  the same request instead of creating two). */
export async function triggerManualBackup(clientRequestId: string): Promise<ManualBackupRequest> {
  const { data, error } = await supabase.functions.invoke("trigger-manual-backup", {
    body: { client_request_id: clientRequestId },
  });
  const row = data as { ok?: boolean; error?: string; retry_after_s?: number; request?: Record<string, unknown>; already_active?: boolean } | null;
  if (error && !row) throw new Error("trigger_manual_backup_failed");
  if (!row?.ok) {
    throw new ManualBackupRejectedError(
      row?.error ?? "unknown",
      row?.retry_after_s,
      row?.request ? toRequest(row.request) : undefined
    );
  }
  return toRequest(row.request!);
}

/** Manager-only. Pulls the latest known state for one request, doing a bounded amount of live
 *  GitHub-API correlation work server-side. Call this only while a request is in an active
 *  status -- polling a terminal (completed/failed/unknown) request wastes a round-trip since its
 *  state can never change again. */
export async function fetchManualBackupStatus(requestId: string): Promise<ManualBackupRequest> {
  const { data, error } = await supabase.functions.invoke("get-manual-backup-status", {
    body: { request_id: requestId },
  });
  const row = data as { ok?: boolean; error?: string; request?: Record<string, unknown> } | null;
  if (error || !row?.ok || !row.request) throw new Error(row?.error ?? "status_check_failed");
  return toRequest(row.request);
}

/** Manager-only. Recent manual backup requests, newest first -- the trusted backend source for
 *  "what's the latest known state," independent of any one client session. */
export async function fetchManualBackupHistory(limit = 20): Promise<ManualBackupRequest[]> {
  const { data, error } = await supabase.rpc("manager_list_manual_backup_requests", { p_limit: limit });
  if (error) throw error;
  const row = data as { ok?: boolean; requests?: Record<string, unknown>[] } | null;
  if (!row?.ok) return [];
  return (row.requests ?? []).map(toRequest);
}

import { supabase } from "./supabase";

export interface FinancialBackupHealth {
  total_backups?: number;
  complete_backups?: number;
  incomplete_backups?: number;
  last_successful_backup?: { backup_id: string; created_at: string } | null;
  last_verified_backup?: { backup_id: string; verified_at: string } | null;
  last_restore_test?: { backup_id: string; tested_at: string; result: "passed" | "failed"; trigger: "scheduled" | "manual" } | null;
  newest_backup_restore_tested?: boolean;
  hours_since_last_successful_backup?: number;
  hours_since_last_verified_backup?: number;
  hours_since_last_restore_test?: number;
  backup_is_stale?: boolean;
  verification_is_stale?: boolean;
  restore_test_is_stale?: boolean;
  total_size_bytes?: number;
  health_status?: "ok" | "critical" | string;
  next_scheduled_backup?: string;
  next_scheduled_restore_test?: string;
}

export interface BackupHealthSnapshot {
  has_data: boolean;
  computed_at?: string;
  health?: FinancialBackupHealth;
}

export interface ArchiveHealth {
  total_real_documents: number;
  archived_count: number;
  pending_count: number;
  failed_count: number;
  /** % of real documents with a successful UPLOAD -- distinct from integrity_checked_pct. */
  upload_coverage_pct: number | null;
  hash_verified_count: number;
  hash_mismatch_count: number;
  /** Archived but never yet sampled by a periodic integrity-verification pass. */
  never_integrity_checked_count: number;
  /** % of archived documents that have EVER been sampled (verified or mismatched) -- never the
   *  same question as upload_coverage_pct. */
  integrity_checked_pct: number | null;
  total_pdf_version_count: number;
  /** null (never 0) when no document_pdf_versions row has a recorded size -- show "unavailable",
   *  not "0 MB". */
  total_size_bytes: number | null;
  size_unknown_count: number;
  last_reconciliation: {
    started_at: string;
    finished_at: string | null;
    status: string;
    missing_count: number | null;
    newly_queued_count: number | null;
  } | null;
  last_integrity_verification: {
    started_at: string;
    finished_at: string | null;
    status: string;
    hash_mismatch_count: number | null;
    expected_count: number | null;
  } | null;
}

/** Manager-only. Reads LIVE from R2 (get-backup-health Edge Function) -- NOT from the
 *  financial_backup_health_snapshot table, which is never written (that write needs a new
 *  GitHub Actions credential this project has deliberately not added -- see that function's own
 *  header comment). Null if the caller isn't a manager or on error. */
export async function fetchBackupHealth(): Promise<BackupHealthSnapshot | null> {
  const { data, error } = await supabase.functions.invoke("get-backup-health", { body: {} });
  const row = data as { ok?: boolean; has_data?: boolean; computed_at?: string; health?: FinancialBackupHealth; error?: string } | null;
  if (error && !row) throw error;
  if (!row?.ok) {
    if (row?.error === "forbidden" || row?.error === "unauthorized") return null;
    throw new Error(row?.error ?? "backup_health_unavailable");
  }
  return { has_data: !!row.has_data, computed_at: row.computed_at, health: row.health };
}

/** Manager-only. Null if the caller isn't a manager (RPC returns {ok:false}) or on error. */
export async function fetchArchiveHealth(): Promise<ArchiveHealth | null> {
  const { data, error } = await supabase.rpc("manager_get_archive_health");
  if (error) throw error;
  const row = data as ({ ok: true } & ArchiveHealth) | { ok: false } | null;
  if (!row?.ok) return null;
  const { ok: _ok, ...rest } = row;
  return rest;
}

export interface BackupAutomationState {
  enabled: boolean;
  changedAt: string | null;
  changedByLabel: string | null;
}

/** Thrown when manage-backup-automation itself fails (e.g. R2 temporarily unreachable) --
 *  distinct from a normal {ok:false} authorization result, so the UI can tell "you can't do this"
 *  apart from "this failed, try again." */
export class BackupAutomationUnavailableError extends Error {
  constructor(detail?: string) {
    super(detail || "backup_automation_unavailable");
  }
}

async function callAutomationFunction(body: { action: "get" | "set"; enabled?: boolean }): Promise<BackupAutomationState> {
  const { data, error } = await supabase.functions.invoke("manage-backup-automation", { body });
  const row = data as { ok?: boolean; enabled?: boolean; changed_at?: string | null; changed_by_label?: string | null; error?: string } | null;
  if (error || !row?.ok) {
    const code = row?.error;
    if (code === "forbidden" || code === "unauthorized") throw new Error(code);
    throw new BackupAutomationUnavailableError(code);
  }
  return { enabled: !!row.enabled, changedAt: row.changed_at ?? null, changedByLabel: row.changed_by_label ?? null };
}

/** Manager-only. Current effective automation state (daily backup + weekly restore-test, tied
 *  together for now) -- read from the same R2-resident config the scheduled workflow itself
 *  reads, never a locally-cached UI preference. */
export function fetchBackupAutomationState(): Promise<BackupAutomationState> {
  return callAutomationFunction({ action: "get" });
}

/** Manager-only. Appends a new automation on/off record (never overwrites -- see
 *  manage-backup-automation's own comment on R2 Bucket Lock) and returns the new effective
 *  state. Throws BackupAutomationUnavailableError if the write itself couldn't be confirmed --
 *  the caller must treat that as "unknown, don't assume it changed," not as success. */
export function setBackupAutomationEnabled(enabled: boolean): Promise<BackupAutomationState> {
  return callAutomationFunction({ action: "set", enabled });
}

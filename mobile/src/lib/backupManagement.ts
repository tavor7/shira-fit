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
  coverage_pct: number | null;
  hash_verified_count: number;
  hash_mismatch_count: number;
  total_pdf_version_count: number;
  total_size_bytes: number;
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

/** Manager-only. Null if the caller isn't a manager (RPC returns {ok:false}) or on error. */
export async function fetchBackupHealth(): Promise<BackupHealthSnapshot | null> {
  const { data, error } = await supabase.rpc("manager_get_backup_health");
  if (error) throw error;
  const row = data as { ok?: boolean; has_data?: boolean; computed_at?: string; health?: FinancialBackupHealth } | null;
  if (!row?.ok) return null;
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

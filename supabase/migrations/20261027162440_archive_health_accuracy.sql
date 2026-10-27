-- Backup Management: fix two accuracy problems in manager_get_archive_health(), found during
-- live manager review of the deployed screen.
--
-- 1. total_size_bytes was `coalesce(sum(size_bytes), 0)` -- in production ALL 516
--    archive.document_pdf_versions rows have size_bytes = NULL (confirmed: not zero, genuinely
--    never recorded, from the historical backfill and the ongoing archive worker both never
--    populating it). coalesce-to-0 silently turned "unknown" into a misleading "0 MB" in the UI.
--    Now returns null (never 0) when size is unknown for every row, plus a size_unknown_count so
--    the client can show an explicit "unavailable" state instead of a number.
--
-- 2. "Archive coverage: 100%" and "Checksum-verified: 250" were both true and both correct, but
--    sitting next to each other with no distinguishing label reads as "100% verified" -- coverage
--    (archived_count/total_real_documents) measures UPLOAD success; hash_verified_count measures
--    how many archived documents have so far been SAMPLED by the periodic integrity-verification
--    pass (archive-document-pdf's `verify` mode) and passed. These are different questions.
--    Explicit new fields: upload_coverage_pct (renamed from coverage_pct, same computation),
--    integrity_checked_count (= hash_verified_count + hash_mismatch_count, i.e. how many have
--    EVER been sampled either way), integrity_checked_pct, never_integrity_checked_count.
create or replace function public.manager_get_archive_health()
returns json
language plpgsql
security definer
set search_path = public, archive, pg_temp
as $$
declare
  v_total_real integer;
  v_archived integer;
  v_pending integer;
  v_failed integer;
  v_verified integer;
  v_hash_mismatch integer;
  v_never_checked integer;
  v_total_size bigint;
  v_size_known_count integer;
  v_size_unknown_count integer;
  v_version_count integer;
  v_last_reconcile archive.reconciliation_runs;
  v_last_integrity archive.reconciliation_runs;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select count(*) into v_total_real from archive.r2_archive_jobs where is_historical = false and not is_ops_test;
  select count(*) into v_archived from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status = 'completed';
  select count(*) into v_pending from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status in ('pending', 'processing');
  select count(*) into v_failed from archive.r2_archive_jobs where is_historical = false and not is_ops_test and status = 'failed';
  select count(*) into v_verified from archive.r2_archive_jobs where not is_ops_test and hash_verified = true;
  select count(*) into v_hash_mismatch from archive.r2_archive_jobs where not is_ops_test and hash_verified = false;
  v_never_checked := greatest(v_archived - v_verified - v_hash_mismatch, 0);

  select count(*) filter (where size_bytes is not null), count(*) filter (where size_bytes is null),
         sum(size_bytes) filter (where size_bytes is not null)
    into v_size_known_count, v_size_unknown_count, v_total_size
  from archive.document_pdf_versions;

  select count(*) into v_version_count from archive.document_pdf_versions;

  select * into v_last_reconcile from archive.reconciliation_runs
  where kind = 'reconcile' order by started_at desc limit 1;
  select * into v_last_integrity from archive.reconciliation_runs
  where kind = 'integrity_verify' order by started_at desc limit 1;

  return json_build_object(
    'ok', true,
    'total_real_documents', v_total_real,
    'archived_count', v_archived,
    'pending_count', v_pending,
    'failed_count', v_failed,
    'upload_coverage_pct', case when v_total_real > 0 then round(100.0 * v_archived / v_total_real, 1) else null end,
    'hash_verified_count', v_verified,
    'hash_mismatch_count', v_hash_mismatch,
    'never_integrity_checked_count', v_never_checked,
    'integrity_checked_pct', case when v_archived > 0 then round(100.0 * (v_verified + v_hash_mismatch) / v_archived, 1) else null end,
    'total_pdf_version_count', v_version_count,
    -- null (never 0) when size is unknown for every row -- see migration header.
    'total_size_bytes', case when v_size_known_count = 0 then null else v_total_size end,
    'size_unknown_count', v_size_unknown_count,
    'last_reconciliation', case when v_last_reconcile.id is null then null else json_build_object(
      'started_at', v_last_reconcile.started_at,
      'finished_at', v_last_reconcile.finished_at,
      'status', v_last_reconcile.status,
      'missing_count', v_last_reconcile.missing_count,
      'newly_queued_count', v_last_reconcile.newly_queued_count
    ) end,
    'last_integrity_verification', case when v_last_integrity.id is null then null else json_build_object(
      'started_at', v_last_integrity.started_at,
      'finished_at', v_last_integrity.finished_at,
      'status', v_last_integrity.status,
      'hash_mismatch_count', v_last_integrity.hash_mismatch_count,
      'expected_count', v_last_integrity.expected_count
    ) end
  );
end;
$$;

comment on function public.manager_get_archive_health() is
  'Manager-only. Read-only aggregate over archive.* -- upload_coverage_pct (upload success) is '
  'explicitly distinct from integrity_checked_pct (how many archived docs have been SAMPLED by '
  'periodic integrity verification and passed/failed) -- never conflate the two. total_size_bytes '
  'is null (never 0) when no document_pdf_versions row has a recorded size. {ok:false, '
  'error:''forbidden''} for a non-manager. Never grants broader archive schema access -- reads '
  'happen inside this SECURITY DEFINER function only.';

revoke execute on function public.manager_get_archive_health() from public, anon;
grant execute on function public.manager_get_archive_health() to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.manager_get_archive_health()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager_get_archive_health must not be callable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.manager_get_archive_health()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager_get_archive_health missing EXECUTE for authenticated';
  end if;
end $$;

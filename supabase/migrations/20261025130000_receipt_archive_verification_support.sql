-- Independent receipt archive (R2): support for the Edge Function's R2-side checksum
-- verification pass (the half of reconciliation that needs the R2 API, not just storage.objects).

alter table archive.r2_archive_jobs
  add column if not exists hash_verified boolean;

comment on column archive.r2_archive_jobs.hash_verified is
  'Result of the most recent R2-side checksum re-verification (actual bytes downloaded from R2, '
  're-hashed, compared to the stored sha256) -- never inferred from R2''s ETag alone.';

create or replace function archive.start_integrity_run()
returns uuid
language sql
security definer
set search_path = archive, public
as $$
  insert into archive.reconciliation_runs (kind, status) values ('integrity_verify', 'running')
  returning id;
$$;

create or replace function archive.record_verification_result(p_job_id uuid, p_matches boolean, p_actual_sha256 text)
returns void
language plpgsql
security definer
set search_path = archive, public
as $$
declare
  v_job archive.r2_archive_jobs%rowtype;
begin
  select * into v_job from archive.r2_archive_jobs where id = p_job_id;
  if not found then return; end if;

  update archive.r2_archive_jobs set verified_at = now(), hash_verified = p_matches where id = p_job_id;

  if not p_matches then
    perform public._report_system_error(
      p_source := 'trusted',
      p_subsystem := 'receipt_archive',
      p_operation := 'archive_integrity_verify',
      p_error_class := 'archive_hash_mismatch',
      p_severity := 'critical',
      p_message := format('R2 object does not match stored checksum (expected %s, got %s)', v_job.sha256, p_actual_sha256),
      p_entities := jsonb_build_object('document_id', v_job.document_id, 'storage_path', v_job.storage_path, 'r2_key', v_job.r2_key),
      p_fingerprint_key := 'receipt_archive_hash_mismatch:' || v_job.storage_path
    );
  end if;
end;
$$;

create or replace function archive.finish_integrity_run(p_run_id uuid, p_checked_count integer, p_mismatch_count integer)
returns void
language sql
security definer
set search_path = archive, public
as $$
  update archive.reconciliation_runs
  set finished_at = now(), status = 'completed', expected_count = p_checked_count, hash_mismatch_count = p_mismatch_count
  where id = p_run_id;
$$;

revoke execute on function archive.start_integrity_run() from public, anon, authenticated;
revoke execute on function archive.record_verification_result(uuid, boolean, text) from public, anon, authenticated;
revoke execute on function archive.finish_integrity_run(uuid, integer, integer) from public, anon, authenticated;
grant execute on function archive.start_integrity_run() to service_role;
grant execute on function archive.record_verification_result(uuid, boolean, text) to service_role;
grant execute on function archive.finish_integrity_run(uuid, integer, integer) to service_role;

-- Pick candidates for the next verification pass: completed jobs that have never been verified,
-- or were last verified longest ago -- so repeated runs eventually cover the whole archive rather
-- than always re-checking the same recent handful.
create or replace function archive.pick_verification_candidates(p_limit integer default 50)
returns setof archive.r2_archive_jobs
language sql
security definer
set search_path = archive, public
as $$
  select * from archive.r2_archive_jobs
  where status = 'completed'
  order by verified_at asc nulls first
  limit p_limit;
$$;

revoke execute on function archive.pick_verification_candidates(integer) from public, anon, authenticated;
grant execute on function archive.pick_verification_candidates(integer) to service_role;

do $$
begin
  if has_function_privilege('authenticated', 'archive.record_verification_result(uuid, boolean, text)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: archive.record_verification_result must stay service_role-only';
  end if;
end $$;

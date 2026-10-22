-- Independent receipt archive (R2): public-schema RPC wrappers for the archive-document-pdf Edge
-- Function.
--
-- PostgREST (and therefore supabase-js's .rpc()) only exposes the `public` schema by default --
-- the `archive` schema's functions (archive.claim_jobs, archive.complete_job, etc.) are
-- deliberately unreachable over the API, as a defense-in-depth boundary for backend-only
-- infrastructure. These thin wrappers are the Edge Function's only entry point into that schema;
-- each one is service_role-only (never anon/authenticated), same as the archive.* functions they
-- delegate to.

create or replace function public.claim_archive_jobs_for_worker(p_limit integer default 20)
returns setof archive.r2_archive_jobs
language sql
security definer
set search_path = archive, public
as $$
  select * from archive.claim_jobs(p_limit, 'archive-document-pdf-edge');
$$;

create or replace function public.complete_archive_job(p_job_id uuid, p_sha256 text)
returns void
language sql
security definer
set search_path = archive, public
as $$
  select archive.complete_job(p_job_id, p_sha256);
$$;

create or replace function public.fail_archive_job(p_job_id uuid, p_error text)
returns void
language sql
security definer
set search_path = archive, public
as $$
  select archive.fail_job(p_job_id, p_error);
$$;

create or replace function public.start_integrity_run_for_worker()
returns uuid
language sql
security definer
set search_path = archive, public
as $$
  select archive.start_integrity_run();
$$;

create or replace function public.pick_verification_candidates_for_worker(p_limit integer default 50)
returns setof archive.r2_archive_jobs
language sql
security definer
set search_path = archive, public
as $$
  select * from archive.pick_verification_candidates(p_limit);
$$;

create or replace function public.record_verification_result_for_worker(p_job_id uuid, p_matches boolean, p_actual_sha256 text)
returns void
language sql
security definer
set search_path = archive, public
as $$
  select archive.record_verification_result(p_job_id, p_matches, p_actual_sha256);
$$;

create or replace function public.finish_integrity_run_for_worker(p_run_id uuid, p_checked_count integer, p_mismatch_count integer)
returns void
language sql
security definer
set search_path = archive, public
as $$
  select archive.finish_integrity_run(p_run_id, p_checked_count, p_mismatch_count);
$$;

revoke execute on function public.claim_archive_jobs_for_worker(integer) from public, anon, authenticated;
revoke execute on function public.complete_archive_job(uuid, text) from public, anon, authenticated;
revoke execute on function public.fail_archive_job(uuid, text) from public, anon, authenticated;
revoke execute on function public.start_integrity_run_for_worker() from public, anon, authenticated;
revoke execute on function public.pick_verification_candidates_for_worker(integer) from public, anon, authenticated;
revoke execute on function public.record_verification_result_for_worker(uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.finish_integrity_run_for_worker(uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.claim_archive_jobs_for_worker(integer) to service_role;
grant execute on function public.complete_archive_job(uuid, text) to service_role;
grant execute on function public.fail_archive_job(uuid, text) to service_role;
grant execute on function public.start_integrity_run_for_worker() to service_role;
grant execute on function public.pick_verification_candidates_for_worker(integer) to service_role;
grant execute on function public.record_verification_result_for_worker(uuid, boolean, text) to service_role;
grant execute on function public.finish_integrity_run_for_worker(uuid, integer, integer) to service_role;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.claim_archive_jobs_for_worker(integer)',
    'public.complete_archive_job(uuid, text)',
    'public.fail_archive_job(uuid, text)',
    'public.start_integrity_run_for_worker()',
    'public.pick_verification_candidates_for_worker(integer)',
    'public.record_verification_result_for_worker(uuid, boolean, text)',
    'public.finish_integrity_run_for_worker(uuid, integer, integer)'
  ]
  loop
    if has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: % must stay service_role-only', v_fn;
    end if;
  end loop;
end $$;

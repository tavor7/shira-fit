-- Backup Management Phase 9: bounded, read-only reconciliation between archive.r2_archive_jobs
-- rows and the actual R2 objects they claim to reference.
--
-- 20261025100000's own reconciliation_runs table already has a 'reconcile' kind in its check
-- constraint, intended for exactly this -- but until now nothing ever wrote one (only
-- 'integrity_verify', from start_integrity_run/finish_integrity_run, 20261025130000). This adds
-- the missing 'reconcile' counterpart, same shape and same service_role-only access model.
--
-- Deliberately READ-ONLY: this never re-queues, re-uploads, or deletes anything -- it only reports
-- what it finds (counts of DB rows claiming "completed" that a HEAD request against R2 confirms or
-- doesn't). Acting on a finding (e.g. re-queuing a job whose object is missing from R2) is a
-- separate, deliberate decision for an operator to make -- see docs/disaster-recovery.md.
--
-- Bounded by construction: pick_reconcile_candidates takes a p_limit (same idiom as
-- pick_verification_candidates) and orders by least-recently-reconciled first, so repeated bounded
-- runs eventually cover the whole archive without any single run's cost growing with archive size.

alter table archive.r2_archive_jobs add column if not exists last_reconciled_at timestamptz;

comment on column archive.r2_archive_jobs.last_reconciled_at is
  'When this row was last checked by the read-only reconcile.js script against a live R2 HEAD '
  'request (distinct from verified_at/hash_verified, which are about CONTENT correctness, not '
  'mere existence).';

create or replace function archive.start_reconcile_run()
returns uuid
language sql
security definer
set search_path = archive, public
as $$
  insert into archive.reconciliation_runs (kind, status) values ('reconcile', 'running')
  returning id;
$$;

-- Completed jobs never checked, or checked longest ago -- same "eventually cover everything"
-- ordering as pick_verification_candidates, applied to existence rather than content checks.
create or replace function archive.pick_reconcile_candidates(p_limit integer default 500)
returns setof archive.r2_archive_jobs
language sql
security definer
set search_path = archive, public
as $$
  select * from archive.r2_archive_jobs
  where status = 'completed'
  order by last_reconciled_at asc nulls first
  limit p_limit;
$$;

create or replace function archive.record_reconcile_check(p_job_id uuid, p_found_in_r2 boolean)
returns void
language plpgsql
security definer
set search_path = archive, public
as $$
declare
  v_job archive.r2_archive_jobs%rowtype;
begin
  update archive.r2_archive_jobs set last_reconciled_at = now() where id = p_job_id
  returning * into v_job;
  if not found then return; end if;

  if not p_found_in_r2 then
    perform public._report_system_error(
      p_source := 'trusted',
      p_subsystem := 'receipt_archive',
      p_operation := 'reconcile',
      p_error_class := 'archive_object_missing',
      p_severity := 'error', -- never 'critical' -- same no-push discipline as the financial-backup
                              -- monitoring wiring (20261027110000); this never triggers a push.
      p_message := 'A completed archive job''s R2 object could not be found by a HEAD request.',
      p_entities := jsonb_build_object('document_id', v_job.document_id, 'storage_path', v_job.storage_path, 'r2_key', v_job.r2_key),
      p_fingerprint_key := 'receipt_archive_object_missing:' || v_job.r2_key
    );
  end if;
end;
$$;

create or replace function archive.finish_reconcile_run(
  p_run_id uuid, p_checked_count integer, p_missing_count integer
)
returns void
language sql
security definer
set search_path = archive, public
as $$
  update archive.reconciliation_runs
  set finished_at = now(), status = 'completed', expected_count = p_checked_count, missing_count = p_missing_count
  where id = p_run_id;
$$;

revoke execute on function archive.start_reconcile_run() from public, anon, authenticated;
revoke execute on function archive.pick_reconcile_candidates(integer) from public, anon, authenticated;
revoke execute on function archive.record_reconcile_check(uuid, boolean) from public, anon, authenticated;
revoke execute on function archive.finish_reconcile_run(uuid, integer, integer) from public, anon, authenticated;
grant execute on function archive.start_reconcile_run() to service_role;
grant execute on function archive.pick_reconcile_candidates(integer) to service_role;
grant execute on function archive.record_reconcile_check(uuid, boolean) to service_role;
grant execute on function archive.finish_reconcile_run(uuid, integer, integer) to service_role;

-- Public-schema wrappers -- PostgREST (and therefore supabase-js's .rpc(), which
-- scripts/receipt-archive/src/reconcile.js uses) only exposes the `public` schema by default,
-- same reasoning and same naming convention as 20261025140000's existing *_for_worker wrappers.
create or replace function public.start_reconcile_run_for_worker()
returns uuid
language sql
security definer
set search_path = archive, public
as $$
  select archive.start_reconcile_run();
$$;

create or replace function public.pick_reconcile_candidates_for_worker(p_limit integer default 500)
returns setof archive.r2_archive_jobs
language sql
security definer
set search_path = archive, public
as $$
  select * from archive.pick_reconcile_candidates(p_limit);
$$;

create or replace function public.record_reconcile_check_for_worker(p_job_id uuid, p_found_in_r2 boolean)
returns void
language sql
security definer
set search_path = archive, public
as $$
  select archive.record_reconcile_check(p_job_id, p_found_in_r2);
$$;

create or replace function public.finish_reconcile_run_for_worker(p_run_id uuid, p_checked_count integer, p_missing_count integer)
returns void
language sql
security definer
set search_path = archive, public
as $$
  select archive.finish_reconcile_run(p_run_id, p_checked_count, p_missing_count);
$$;

revoke execute on function public.start_reconcile_run_for_worker() from public, anon, authenticated;
revoke execute on function public.pick_reconcile_candidates_for_worker(integer) from public, anon, authenticated;
revoke execute on function public.record_reconcile_check_for_worker(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.finish_reconcile_run_for_worker(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.start_reconcile_run_for_worker() to service_role;
grant execute on function public.pick_reconcile_candidates_for_worker(integer) to service_role;
grant execute on function public.record_reconcile_check_for_worker(uuid, boolean) to service_role;
grant execute on function public.finish_reconcile_run_for_worker(uuid, integer, integer) to service_role;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'archive.pick_reconcile_candidates(integer)',
    'archive.record_reconcile_check(uuid, boolean)',
    'public.start_reconcile_run_for_worker()',
    'public.pick_reconcile_candidates_for_worker(integer)',
    'public.record_reconcile_check_for_worker(uuid, boolean)',
    'public.finish_reconcile_run_for_worker(uuid, integer, integer)'
  ]
  loop
    if has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE')
       or has_function_privilege('anon', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'self-check: % must stay service_role-only', v_fn;
    end if;
  end loop;
end $$;

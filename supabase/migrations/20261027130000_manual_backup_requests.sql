-- Backup Management: manual "Back Up Now" request tracking.
--
-- Postgres is the trusted, persistent source of truth for "what is the manager-visible state of
-- a manual backup request" -- survives app navigation/restart, independent of any one client
-- session. The actual backup still runs entirely through the existing, already-verified
-- financial-backup.yml GitHub Actions workflow (mode=backup); this table only tracks the
-- request/dispatch/correlation/outcome of each manual trigger, written by two new service-role-
-- only Edge Functions (trigger-manual-backup, get-manual-backup-status).

create table public.financial_manual_backup_requests (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid not null unique,
  requested_by uuid references public.profiles(user_id),
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'running', 'completed', 'failed', 'unknown')),
  github_run_id bigint,
  github_run_url text,
  backup_id uuid,
  current_step text,
  error_detail text,
  dispatched_at timestamptz,
  completed_at timestamptz
);

comment on table public.financial_manual_backup_requests is
  'One row per manager-initiated "Back Up Now" tap. client_request_id (generated fresh by the UI '
  'per logical tap, reused on a client-side retry of the SAME tap) is the idempotency key -- '
  'trigger-manual-backup upserts on it rather than ever creating two rows for one tap. status '
  'progresses pending -> dispatched -> running -> completed|failed, or -> unknown if a dispatched '
  'run could never be correlated to a real GitHub Actions run within a bounded window. Written '
  'only by service-role Edge Functions; read by managers only through '
  'manager_list_manual_backup_requests() below, never direct table access.';

create index financial_manual_backup_requests_requested_at_idx on public.financial_manual_backup_requests(requested_at desc);
create index financial_manual_backup_requests_active_idx on public.financial_manual_backup_requests(status)
  where status in ('pending', 'dispatched', 'running');

alter table public.financial_manual_backup_requests enable row level security;
revoke all on table public.financial_manual_backup_requests from public, anon, authenticated;
grant select, insert, update on table public.financial_manual_backup_requests to service_role;
-- No policies -- RLS enabled with zero policies + no anon/authenticated grants means those roles
-- have no path to this table at all, same belt-and-suspenders idiom used throughout this project.

create or replace function public.manager_list_manual_backup_requests(p_limit integer default 20)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows json;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    p_limit := 20;
  end if;

  select coalesce(json_agg(row_to_json(r)), '[]'::json) into v_rows
  from (
    select id, client_request_id, requested_by, requested_at, status, github_run_id,
           github_run_url, backup_id, current_step, error_detail, dispatched_at, completed_at
    from public.financial_manual_backup_requests
    order by requested_at desc
    limit p_limit
  ) r;

  return json_build_object('ok', true, 'requests', v_rows);
end;
$$;

comment on function public.manager_list_manual_backup_requests(integer) is
  'Manager-only. Recent manual backup requests, newest first (default/max limit 20/100). The '
  'Backup Management screen uses this both for the "history" list and to detect an already-'
  'active request (status in pending/dispatched/running) client-side -- the authoritative check '
  'happens server-side in trigger-manual-backup regardless.';

revoke execute on function public.manager_list_manual_backup_requests(integer) from public, anon;
grant execute on function public.manager_list_manual_backup_requests(integer) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.manager_list_manual_backup_requests(integer)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: manager_list_manual_backup_requests must not be callable by anon';
  end if;
  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'financial_manual_backup_requests'
      and grantee in ('anon', 'authenticated', 'public')
  ) then
    raise exception 'self-check: financial_manual_backup_requests must not be reachable by anon/authenticated/public';
  end if;
end $$;

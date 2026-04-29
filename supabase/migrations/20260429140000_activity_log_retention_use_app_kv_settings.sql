-- Fix schema collision: `app_settings` is a singleton table for registration opening.
-- Activity-log retention should use a separate key/value settings table.

create table if not exists public.app_kv_settings (
  key text primary key,
  value_json jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_kv_settings enable row level security;

drop policy if exists "app_kv_settings_manager_all" on public.app_kv_settings;
create policy "app_kv_settings_manager_all"
  on public.app_kv_settings
  for all
  to authenticated
  using (public.is_manager(auth.uid()))
  with check (public.is_manager(auth.uid()));

-- Migrate existing value if an older environment created a key/value `app_settings`.
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_settings'
      and column_name = 'key'
  ) then
    insert into public.app_kv_settings (key, value_json, updated_at)
    select s.key, s.value_json, coalesce(s.updated_at, now())
    from public.app_settings s
    where s.key = 'activity_log_retention_days'
    on conflict (key) do update
      set value_json = excluded.value_json,
          updated_at = excluded.updated_at;
  end if;
end $$;

insert into public.app_kv_settings (key, value_json)
values ('activity_log_retention_days', '14'::jsonb)
on conflict (key) do nothing;

-- Current retention (days). Managers only; others get default 14.
create or replace function public.get_activity_log_retention_days()
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_manager(auth.uid()) then
    return 14;
  end if;
  return coalesce(
    (
      select case
        when jsonb_typeof(value_json) = 'number' then (value_json::text)::integer
        else null
      end
      from public.app_kv_settings
      where key = 'activity_log_retention_days'
    ),
    14
  );
end;
$$;

grant execute on function public.get_activity_log_retention_days() to authenticated;

-- Delete events older than configured retention (managers only).
create or replace function public.manager_prune_activity_logs()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer;
  v_n integer := 0;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select coalesce(
    case
      when jsonb_typeof(value_json) = 'number' then (value_json::text)::integer
      else null
    end,
    14
  )
  into v_days
  from public.app_kv_settings
  where key = 'activity_log_retention_days';

  if v_days is null then
    v_days := 14;
  end if;

  v_days := greatest(1, least(v_days, 730));

  delete from public.user_activity_events
  where created_at < (now() - (v_days || ' days')::interval);

  get diagnostics v_n = row_count;

  return json_build_object('ok', true, 'deleted', v_n, 'retention_days', v_days);
end;
$$;

grant execute on function public.manager_prune_activity_logs() to authenticated;

-- Update retention, then purge by new window.
create or replace function public.set_activity_log_retention_days(p_days integer)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_days integer;
  v_n integer := 0;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_days := greatest(1, least(coalesce(p_days, 14), 730));

  insert into public.app_kv_settings (key, value_json, updated_at)
  values ('activity_log_retention_days', to_jsonb(v_days), now())
  on conflict (key) do update
    set value_json = excluded.value_json,
        updated_at = now();

  delete from public.user_activity_events
  where created_at < (now() - (v_days || ' days')::interval);

  get diagnostics v_n = row_count;

  return json_build_object('ok', true, 'retention_days', v_days, 'deleted', v_n);
end;
$$;

grant execute on function public.set_activity_log_retention_days(integer) to authenticated;


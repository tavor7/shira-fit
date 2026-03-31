-- Registration opening schedule (manager configurable) + helper RPCs.

create table if not exists public.app_settings (
  id int primary key,
  registration_open_weekday int not null default 4, -- 0=Sun ... 6=Sat; default Thu (4)
  registration_open_time time not null default '08:00'::time,
  updated_at timestamptz not null default now()
);

-- singleton row
insert into public.app_settings (id)
values (1)
on conflict (id) do nothing;

alter table public.app_settings enable row level security;

drop policy if exists app_settings_select_all on public.app_settings;
create policy app_settings_select_all on public.app_settings
for select using (true);

drop policy if exists app_settings_manager_update on public.app_settings;
create policy app_settings_manager_update on public.app_settings
for update using (public.is_manager(auth.uid()))
with check (public.is_manager(auth.uid()));

create or replace function public.set_registration_opening_schedule(
  p_weekday int,
  p_time text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_t time;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_weekday is null or p_weekday < 0 or p_weekday > 6 then
    return json_build_object('ok', false, 'error', 'invalid_weekday');
  end if;
  begin
    v_t := p_time::time;
  exception when others then
    return json_build_object('ok', false, 'error', 'invalid_time');
  end;

  update public.app_settings
  set registration_open_weekday = p_weekday,
      registration_open_time = v_t,
      updated_at = now()
  where id = 1;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_registration_opening_schedule(int, text) to authenticated;

create or replace function public.get_registration_opening_schedule()
returns table (weekday int, time_str text)
language sql
stable
security definer
set search_path = public
as $$
  select s.registration_open_weekday, to_char(s.registration_open_time, 'HH24:MI')
  from public.app_settings s
  where s.id = 1;
$$;

grant execute on function public.get_registration_opening_schedule() to authenticated;


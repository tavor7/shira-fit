-- Manual participants (no auth account) + session association + attendance.
-- Supports quick-add (name+phone) and later completion/edit by staff.

create table if not exists public.manual_participants (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  gender text null,
  date_of_birth date null,
  notes text null,
  linked_user_id uuid null references public.profiles (user_id) on delete set null,
  created_by uuid null references public.profiles (user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phone)
);

create index if not exists manual_participants_phone_idx on public.manual_participants (phone);
create index if not exists manual_participants_name_idx on public.manual_participants (full_name);

drop trigger if exists manual_participants_updated on public.manual_participants;
create trigger manual_participants_updated before update on public.manual_participants
  for each row execute function public.set_updated_at();

create table if not exists public.session_manual_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  manual_participant_id uuid not null references public.manual_participants (id) on delete cascade,
  added_at timestamptz not null default now(),
  attended boolean null,
  unique (session_id, manual_participant_id)
);

create index if not exists session_manual_participants_session_idx on public.session_manual_participants (session_id);

alter table public.manual_participants enable row level security;
alter table public.session_manual_participants enable row level security;

-- Staff can read manual participants.
drop policy if exists manual_participants_select_staff on public.manual_participants;
create policy manual_participants_select_staff on public.manual_participants
for select using (public.is_coach_or_manager(auth.uid()));

-- Staff can edit manual participants (coaches cannot edit managers because these rows are not managers).
drop policy if exists manual_participants_update_staff on public.manual_participants;
create policy manual_participants_update_staff on public.manual_participants
for update using (public.is_coach_or_manager(auth.uid()))
with check (public.is_coach_or_manager(auth.uid()));

drop policy if exists manual_participants_insert_staff on public.manual_participants;
create policy manual_participants_insert_staff on public.manual_participants
for insert with check (public.is_coach_or_manager(auth.uid()));

-- Staff can create session associations only for sessions they own (coach) or any (manager) via RPC.
-- Table policy is kept broad for service role / future admin tooling.

-- Staff can read manual session participants.
drop policy if exists session_manual_participants_select_staff on public.session_manual_participants;
create policy session_manual_participants_select_staff on public.session_manual_participants
for select using (public.is_coach_or_manager(auth.uid()));

drop policy if exists session_manual_participants_insert_staff on public.session_manual_participants;
create policy session_manual_participants_insert_staff on public.session_manual_participants
for insert with check (public.is_coach_or_manager(auth.uid()));

drop policy if exists session_manual_participants_update_staff on public.session_manual_participants;
create policy session_manual_participants_update_staff on public.session_manual_participants
for update using (public.is_coach_or_manager(auth.uid()))
with check (public.is_coach_or_manager(auth.uid()));

drop policy if exists session_manual_participants_delete_manager on public.session_manual_participants;
create policy session_manual_participants_delete_manager on public.session_manual_participants
for delete using (public.is_manager(auth.uid()));

-- RPC: upsert manual participant by phone (quick-add)
create or replace function public.upsert_manual_participant(
  p_full_name text,
  p_phone text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_full_name is null or length(trim(p_full_name)) < 2 then
    return json_build_object('ok', false, 'error', 'name_required');
  end if;
  if p_phone is null or length(trim(p_phone)) < 3 then
    return json_build_object('ok', false, 'error', 'phone_required');
  end if;

  insert into public.manual_participants (full_name, phone, created_by)
  values (trim(p_full_name), trim(p_phone), v_uid)
  on conflict (phone) do update
    set full_name = excluded.full_name,
        updated_at = now()
  returning id into v_id;

  return json_build_object('ok', true, 'manual_participant_id', v_id);
end;
$$;

grant execute on function public.upsert_manual_participant(text, text) to authenticated;

-- RPC: add manual participant to session (coach own session or manager)
create or replace function public.add_manual_participant_to_session(
  p_session_id uuid,
  p_manual_participant_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  insert into public.session_manual_participants (session_id, manual_participant_id)
  values (p_session_id, p_manual_participant_id)
  on conflict (session_id, manual_participant_id) do nothing;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.add_manual_participant_to_session(uuid, uuid) to authenticated;

-- RPC: set attendance for manual participant
create or replace function public.set_manual_participant_attendance(
  p_session_id uuid,
  p_manual_participant_id uuid,
  p_status text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_att boolean;
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_status = 'unset' then v_att := null;
  elsif p_status = 'arrived' then v_att := true;
  else v_att := false;
  end if;

  update public.session_manual_participants
  set attended = v_att
  where session_id = p_session_id and manual_participant_id = p_manual_participant_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'not_in_session');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_manual_participant_attendance(uuid, uuid, text) to authenticated;

-- RPC: staff update profile fields (non-managers only; coaches limited to athletes).
create or replace function public.staff_update_profile(
  p_user_id uuid,
  p_full_name text default null,
  p_phone text default null,
  p_gender text default null,
  p_date_of_birth date default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target public.profiles%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_target from public.profiles where user_id = p_user_id;
  if not found then return json_build_object('ok', false, 'error', 'user_not_found'); end if;

  if v_target.role = 'manager' then
    return json_build_object('ok', false, 'error', 'cannot_edit_manager');
  end if;

  if not public.is_manager(v_uid) then
    -- coaches can only edit athletes
    if v_target.role <> 'athlete' then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
  end if;

  update public.profiles
  set
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    gender = coalesce(nullif(trim(p_gender), ''), gender),
    date_of_birth = coalesce(p_date_of_birth, date_of_birth)
  where user_id = p_user_id;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.staff_update_profile(uuid, text, text, text, date) to authenticated;

-- RPC: staff update manual participant fields
create or replace function public.staff_update_manual_participant(
  p_manual_participant_id uuid,
  p_full_name text default null,
  p_phone text default null,
  p_gender text default null,
  p_date_of_birth date default null,
  p_notes text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  update public.manual_participants
  set
    full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
    phone = coalesce(nullif(trim(p_phone), ''), phone),
    gender = coalesce(nullif(trim(p_gender), ''), gender),
    date_of_birth = coalesce(p_date_of_birth, date_of_birth),
    notes = coalesce(p_notes, notes)
  where id = p_manual_participant_id;

  if not found then
    return json_build_object('ok', false, 'error', 'manual_participant_not_found');
  end if;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.staff_update_manual_participant(uuid, text, text, text, date, text) to authenticated;


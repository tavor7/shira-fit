-- Disable quick-add (manual) participants: block new session adds and payments on/after disable date.

alter table public.manual_participants
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid references public.profiles (user_id) on delete set null;

create index if not exists manual_participants_disabled_at_idx
  on public.manual_participants (disabled_at)
  where disabled_at is not null;

comment on column public.manual_participants.disabled_at is
  'When set, staff cannot add this quick-add person to sessions or record new payments on/after this studio-local date.';
comment on column public.manual_participants.disabled_by is
  'Staff user who disabled the quick-add participant.';

create or replace function public.manual_participant_disabled_on_date(p_manual_id uuid, p_on date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.manual_participants mp
    where mp.id = p_manual_id
      and mp.disabled_at is not null
      and p_on >= (timezone('Asia/Jerusalem', mp.disabled_at))::date
  );
$$;

comment on function public.manual_participant_disabled_on_date(uuid, date) is
  'True when quick-add participant is disabled and p_on is on/after the disable date (studio TZ).';

grant execute on function public.manual_participant_disabled_on_date(uuid, date) to authenticated;

create or replace function public.staff_set_manual_participant_disabled(
  p_manual_participant_id uuid,
  p_disabled boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target public.manual_participants%rowtype;
  v_fn text;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_target from public.manual_participants where id = p_manual_participant_id;
  if not found then
    return json_build_object('ok', false, 'error', 'manual_participant_not_found');
  end if;

  v_fn := coalesce(v_target.full_name, '');

  if coalesce(p_disabled, false) then
    if v_target.disabled_at is not null then
      return json_build_object('ok', true);
    end if;
    update public.manual_participants
    set disabled_at = now(), disabled_by = v_uid
    where id = p_manual_participant_id;

    perform public._insert_activity_event(
      v_uid,
      'manual_participant_disabled',
      'manual_participant',
      p_manual_participant_id::text,
      jsonb_build_object(
        'manual_participant_id', p_manual_participant_id::text,
        'full_name', v_fn,
        'phone', coalesce(v_target.phone, '')
      )
    );
  else
    if v_target.disabled_at is null then
      return json_build_object('ok', true);
    end if;
    update public.manual_participants
    set disabled_at = null, disabled_by = null
    where id = p_manual_participant_id;

    perform public._insert_activity_event(
      v_uid,
      'manual_participant_enabled',
      'manual_participant',
      p_manual_participant_id::text,
      jsonb_build_object(
        'manual_participant_id', p_manual_participant_id::text,
        'full_name', v_fn,
        'phone', coalesce(v_target.phone, '')
      )
    );
  end if;

  return json_build_object('ok', true);
exception
  when others then
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.staff_set_manual_participant_disabled(uuid, boolean) to authenticated;

create or replace function public.staff_get_manual_participant_meta(p_manual_participant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_last_session_date date;
  v_last_added_at timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not exists (select 1 from public.manual_participants mp where mp.id = p_manual_participant_id) then
    return jsonb_build_object('ok', false, 'error', 'manual_participant_not_found');
  end if;

  select ts.session_date, smp.added_at
  into v_last_session_date, v_last_added_at
  from public.session_manual_participants smp
  join public.training_sessions ts on ts.id = smp.session_id
  where smp.manual_participant_id = p_manual_participant_id
  order by ts.session_date desc, smp.added_at desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'last_session_date', v_last_session_date,
    'last_session_added_at', v_last_added_at
  );
end;
$$;

grant execute on function public.staff_get_manual_participant_meta(uuid) to authenticated;

create or replace function public.add_manual_participant_to_session(
  p_session_id uuid,
  p_manual_participant_id uuid,
  p_allow_over_capacity boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_count int;
  v_n int;
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

  if public.manual_participant_disabled_on_date(p_manual_participant_id, v_sess.session_date) then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;

  v_count := public.active_registration_count(p_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  insert into public.session_manual_participants (session_id, manual_participant_id)
  values (p_session_id, p_manual_participant_id)
  on conflict (session_id, manual_participant_id) do nothing;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'already_in_session');
  end if;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.add_manual_participant_to_session(uuid, uuid, boolean) to authenticated;

create or replace function public._validate_athlete_account_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payee_is_manual then
    if not exists (select 1 from public.manual_participants mp where mp.id = new.payee_id) then
      raise exception 'invalid_manual_payee';
    end if;
    if tg_op = 'INSERT' and public.manual_participant_disabled_on_date(new.payee_id, new.paid_at) then
      raise exception 'account_disabled_payee';
    end if;
  else
    if not exists (
      select 1 from public.profiles p
      where p.user_id = new.payee_id and p.role = 'athlete'
    ) then
      raise exception 'invalid_athlete_payee';
    end if;
    if tg_op = 'INSERT' and public.athlete_disabled_on_date(new.payee_id, new.paid_at) then
      raise exception 'account_disabled_payee';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

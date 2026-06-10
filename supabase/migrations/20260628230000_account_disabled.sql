-- Disable athlete accounts: block login usage, post-disable session signup, post-disable new payments.

alter table public.profiles
  add column if not exists disabled_at timestamptz,
  add column if not exists disabled_by uuid references public.profiles (user_id) on delete set null;

create index if not exists profiles_disabled_at_idx
  on public.profiles (disabled_at)
  where disabled_at is not null;

comment on column public.profiles.disabled_at is
  'When set, athlete cannot use the app; staff cannot add them to sessions or record payments on/after this studio-local date.';
comment on column public.profiles.disabled_by is
  'Staff user who disabled the account.';

create or replace function public.athlete_disabled_on_date(p_user_id uuid, p_on date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = p_user_id
      and p.disabled_at is not null
      and p_on >= (timezone('Asia/Jerusalem', p.disabled_at))::date
  );
$$;

comment on function public.athlete_disabled_on_date(uuid, date) is
  'True when athlete account is disabled and p_on is on/after the disable date (studio TZ).';

grant execute on function public.athlete_disabled_on_date(uuid, date) to authenticated;

create or replace function public.staff_set_account_disabled(p_user_id uuid, p_disabled boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_target public.profiles%rowtype;
  v_fn text;
  v_un text;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_target from public.profiles where user_id = p_user_id;
  if not found then
    return json_build_object('ok', false, 'error', 'user_not_found');
  end if;

  if v_target.role = 'manager' then
    return json_build_object('ok', false, 'error', 'cannot_edit_manager');
  end if;

  if not public.is_manager(v_uid) and v_target.role <> 'athlete' then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select p.full_name, p.username into v_fn, v_un from public.profiles p where p.user_id = p_user_id;

  if coalesce(p_disabled, false) then
    if v_target.disabled_at is not null then
      return json_build_object('ok', true);
    end if;
    update public.profiles
    set disabled_at = now(), disabled_by = v_uid
    where user_id = p_user_id;

    perform public._insert_activity_event(
      v_uid,
      'account_disabled',
      p_user_id,
      jsonb_build_object(
        'target_user_id', p_user_id::text,
        'target_full_name', coalesce(v_fn, ''),
        'target_username', coalesce(v_un, '')
      )
    );
  else
    if v_target.disabled_at is null then
      return json_build_object('ok', true);
    end if;
    update public.profiles
    set disabled_at = null, disabled_by = null
    where user_id = p_user_id;

    perform public._insert_activity_event(
      v_uid,
      'account_enabled',
      p_user_id,
      jsonb_build_object(
        'target_user_id', p_user_id::text,
        'target_full_name', coalesce(v_fn, ''),
        'target_username', coalesce(v_un, '')
      )
    );
  end if;

  return json_build_object('ok', true);
exception
  when others then
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.staff_set_account_disabled(uuid, boolean) to authenticated;

-- Athlete self-service: block disabled accounts entirely.
create or replace function public.register_for_session(p_session_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile profiles%rowtype;
  v_sess training_sessions%rowtype;
  v_count int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from profiles where user_id = v_uid;
  if not found then return json_build_object('ok', false, 'error', 'no_profile'); end if;
  if v_profile.disabled_at is not null then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;
  if v_profile.role <> 'athlete' or v_profile.approval_status <> 'approved' then
    return json_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public._session_has_ended(v_sess) then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;
  if coalesce(v_sess.is_hidden, false) then
    return json_build_object('ok', false, 'error', 'session_not_available');
  end if;
  if not v_sess.is_open_for_registration then
    return json_build_object('ok', false, 'error', 'registration_closed');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;
  if exists (
    select 1 from session_registrations
    where session_id = p_session_id and user_id = v_uid and status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'already_registered');
  end if;

  insert into session_registrations (session_id, user_id, status, registered_at)
  values (p_session_id, v_uid, 'active', now())
  on conflict (session_id, user_id) do update
  set
    status = 'active',
    registered_at = now(),
    attended = null,
    payment_method = null,
    amount_paid = null
  where session_registrations.status = 'cancelled';

  insert into registration_history (session_id, user_id, event_type) values (p_session_id, v_uid, 'registered');
  delete from waitlist_requests where session_id = p_session_id and user_id = v_uid;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.request_waitlist(p_session_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile profiles%rowtype;
  v_count int;
  v_sess training_sessions%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select * into v_profile from profiles where user_id = v_uid;
  if v_profile.disabled_at is not null then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;
  if v_profile.approval_status <> 'approved' or v_profile.role <> 'athlete' then
    return json_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;
  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if public._session_has_ended(v_sess) then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;
  if coalesce(v_sess.is_hidden, false) then
    return json_build_object('ok', false, 'error', 'session_not_available');
  end if;
  v_count := public.active_registration_count(p_session_id);
  if v_count < v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'not_full');
  end if;
  insert into waitlist_requests (session_id, user_id) values (p_session_id, v_uid)
  on conflict (session_id, user_id) do nothing;
  return json_build_object('ok', true);
end;
$$;

-- Staff add athlete: approved athlete required; block sessions on/after disable date.
create or replace function public.coach_add_athlete(
  p_session_id uuid,
  p_user_id uuid,
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
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid and exists (select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach') then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if not exists (
    select 1 from public.profiles
    where user_id = p_user_id and approval_status = 'approved' and role = 'athlete'
  ) then
    return json_build_object('ok', false, 'error', 'invalid_athlete');
  end if;

  if public.athlete_disabled_on_date(p_user_id, v_sess.session_date) then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;

  v_count := public.active_registration_count(p_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  insert into public.session_registrations (session_id, user_id, status)
  values (p_session_id, p_user_id, 'active')
  on conflict (session_id, user_id) do update
    set status = 'active', registered_at = now();

  insert into public.registration_history (session_id, user_id, event_type)
  values (p_session_id, p_user_id, 'registered');

  delete from public.waitlist_requests where session_id = p_session_id and user_id = p_user_id;
  return json_build_object('ok', true);
exception when others then
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

-- Block new account payments on/after disable date; updates remain allowed.
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

drop trigger if exists athlete_account_payments_validate on public.athlete_account_payments;
create trigger athlete_account_payments_validate
  before insert on public.athlete_account_payments
  for each row execute function public._validate_athlete_account_payment();

-- Weekly registration banner: disabled athletes excluded.
create or replace function public.get_next_weekly_registration_banner_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_today date := public._studio_today_date();
  v_this_week_start date;
  v_open_weekday int;
  v_open_time time;
  v_open_at timestamptz;
  v_next_open timestamptz;
  v_next_unlock_start date;
  v_next_unlock_end date;
  v_current_unlock_start date;
  v_current_unlock_end date;
  v_eligible_next int;
  v_open_next int;
  v_eligible_current int;
  v_open_current int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.user_id = v_uid
      and p.role = 'athlete'
      and p.approval_status = 'approved'
      and p.disabled_at is null
  ) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_this_week_start := public._week_start_sunday(v_today);

  select s.registration_open_weekday, s.registration_open_time
  into v_open_weekday, v_open_time
  from public.app_settings s
  where s.id = 1;

  v_open_weekday := coalesce(least(6, greatest(0, v_open_weekday)), 4);
  v_open_time := coalesce(v_open_time, time '08:00'::time);

  v_open_at := public._registration_open_at(v_this_week_start, v_open_weekday, v_open_time);

  v_current_unlock_start := v_this_week_start + 7;
  v_current_unlock_end := v_current_unlock_start + 6;

  if v_now < v_open_at then
    v_next_open := v_open_at;
    v_next_unlock_start := v_this_week_start + 7;
  else
    v_next_open := v_open_at + interval '7 days';
    v_next_unlock_start := v_this_week_start + 14;
  end if;
  v_next_unlock_end := v_next_unlock_start + 6;

  select count(*)::int into v_eligible_next
  from public.training_sessions s
  where s.session_date between v_next_unlock_start and v_next_unlock_end
    and coalesce(s.is_hidden, false) = false;

  select count(*)::int into v_open_next
  from public.training_sessions s
  where s.session_date between v_next_unlock_start and v_next_unlock_end
    and coalesce(s.is_hidden, false) = false
    and s.is_open_for_registration = true;

  select count(*)::int into v_eligible_current
  from public.training_sessions s
  where s.session_date between v_current_unlock_start and v_current_unlock_end
    and coalesce(s.is_hidden, false) = false;

  select count(*)::int into v_open_current
  from public.training_sessions s
  where s.session_date between v_current_unlock_start and v_current_unlock_end
    and coalesce(s.is_hidden, false) = false
    and s.is_open_for_registration = true;

  return jsonb_build_object(
    'ok', true,
    'next_open_at_utc', to_char(v_next_open, 'YYYY-MM-DD"T"HH24:MI:SSOF'),
    'next_unlock_week_start', to_char(v_next_unlock_start, 'YYYY-MM-DD'),
    'next_unlock_week_end', to_char(v_next_unlock_end, 'YYYY-MM-DD'),
    'current_unlock_week_start', to_char(v_current_unlock_start, 'YYYY-MM-DD'),
    'current_unlock_week_end', to_char(v_current_unlock_end, 'YYYY-MM-DD'),
    'eligible_next_week_count', v_eligible_next,
    'open_next_week_count', v_open_next,
    'eligible_current_week_count', v_eligible_current,
    'open_current_week_count', v_open_current,
    'show_registration_countdown', (v_eligible_next > 0 and v_now < v_next_open),
    'show_registration_still_pending', (
      v_eligible_current > 0
      and v_now >= v_open_at
      and v_open_current < v_eligible_current
    ),
    'timezone', 'Asia/Jerusalem'
  );
end;
$$;

grant execute on function public.get_next_weekly_registration_banner_state() to authenticated;

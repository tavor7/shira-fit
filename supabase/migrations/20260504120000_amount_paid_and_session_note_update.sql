-- Amount paid when marking attendance (optional, after payment method).
-- Session notes: allow staff to edit notes they may delete (author or manager).

alter table public.session_registrations
  add column if not exists amount_paid numeric(12, 2) null;

alter table public.session_manual_participants
  add column if not exists amount_paid numeric(12, 2) null;

comment on column public.session_registrations.amount_paid is 'Optional amount collected when status is arrived and payment_method is set.';
comment on column public.session_manual_participants.amount_paid is 'Optional amount collected when status is arrived and payment_method is set.';

-- Replace 4-arg attendance RPCs with 5-arg versions (p_amount_paid).
drop function if exists public.set_registration_attendance(uuid, uuid, text, text);
drop function if exists public.set_manual_participant_attendance(uuid, uuid, text, text);

create or replace function public.set_registration_attendance(
  p_session_id uuid,
  p_user_id uuid,
  p_status text,
  p_payment_method text default null,
  p_amount_paid numeric default null
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_att boolean;
  v_n int;
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_amt numeric(12, 2) := null;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid
    and exists (select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach') then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
    v_amt := null;
  elsif p_status = 'arrived' then
    v_att := true;
    if v_pay is null then
      v_amt := null;
    else
      if p_amount_paid is not null and p_amount_paid < 0 then
        return json_build_object('ok', false, 'error', 'invalid_amount');
      end if;
      v_amt := case
        when p_amount_paid is null then null
        else round(p_amount_paid::numeric, 2)::numeric(12, 2)
      end;
    end if;
  else
    v_att := false;
    v_pay := null;
    v_amt := null;
  end if;

  update public.session_registrations
  set attended = v_att,
      payment_method = v_pay,
      amount_paid = v_amt
  where session_id = p_session_id and user_id = p_user_id and status = 'active';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'not_active_registration');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_registration_attendance(uuid, uuid, text, text, numeric) to authenticated;

create or replace function public.set_manual_participant_attendance(
  p_session_id uuid,
  p_manual_participant_id uuid,
  p_status text,
  p_payment_method text default null,
  p_amount_paid numeric default null
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
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_amt numeric(12, 2) := null;
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

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
    v_amt := null;
  elsif p_status = 'arrived' then
    v_att := true;
    if v_pay is null then
      v_amt := null;
    else
      if p_amount_paid is not null and p_amount_paid < 0 then
        return json_build_object('ok', false, 'error', 'invalid_amount');
      end if;
      v_amt := case
        when p_amount_paid is null then null
        else round(p_amount_paid::numeric, 2)::numeric(12, 2)
      end;
    end if;
  else
    v_att := false;
    v_pay := null;
    v_amt := null;
  end if;

  update public.session_manual_participants
  set attended = v_att,
      payment_method = v_pay,
      amount_paid = v_amt
  where session_id = p_session_id and manual_participant_id = p_manual_participant_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'not_in_session');
  end if;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.set_manual_participant_attendance(uuid, uuid, text, text, numeric) to authenticated;

-- Athlete history: expose amount paid.
drop function if exists public.participant_registration_history(date, date, text, uuid);

create or replace function public.participant_registration_history(
  p_start date,
  p_end date,
  p_phone_search text default null,
  p_athlete_key uuid default null
)
returns table (
  registration_id uuid,
  athlete_user_id uuid,
  athlete_name text,
  athlete_phone text,
  session_id uuid,
  session_date date,
  start_time time,
  duration_minutes int,
  max_participants int,
  reg_status public.registration_status,
  registered_at timestamptz,
  attended boolean,
  payment_method text,
  amount_paid numeric,
  cancellation_reason text,
  cancellation_within_24h boolean,
  cancelled_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_coach_or_manager(auth.uid()) then
    return;
  end if;

  if p_start > p_end then
    return;
  end if;

  return query
  select
    u.registration_id,
    u.athlete_user_id,
    u.athlete_name,
    u.athlete_phone,
    u.session_id,
    u.session_date,
    u.start_time,
    u.duration_minutes,
    u.max_participants,
    u.reg_status,
    u.registered_at,
    u.attended,
    u.payment_method,
    u.amount_paid,
    u.cancellation_reason,
    u.cancellation_within_24h,
    u.cancelled_at
  from (
    select
      r.id as registration_id,
      r.user_id as athlete_user_id,
      p.full_name as athlete_name,
      p.phone as athlete_phone,
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      s.max_participants as max_participants,
      r.status as reg_status,
      r.registered_at,
      r.attended,
      r.payment_method,
      r.amount_paid,
      c.reason as cancellation_reason,
      case
        when c.cancelled_at is not null then c.charged_full_price
        else null
      end as cancellation_within_24h,
      c.cancelled_at
    from public.session_registrations r
    join public.profiles p on p.user_id = r.user_id
    join public.training_sessions s on s.id = r.session_id
    left join lateral (
      select c2.reason, c2.cancelled_at, c2.charged_full_price
      from public.cancellations c2
      where c2.session_id = r.session_id
        and c2.user_id = r.user_id
      order by c2.cancelled_at desc
      limit 1
    ) c on true
    where p.role = 'athlete'
      and s.session_date >= p_start
      and s.session_date <= p_end
      and (
        p_phone_search is null
        or length(trim(p_phone_search)) = 0
        or p.phone ilike '%' || trim(p_phone_search) || '%'
      )
      and (
        p_athlete_key is null
        or r.user_id = p_athlete_key
      )

    union all

    select
      smp.id as registration_id,
      smp.manual_participant_id as athlete_user_id,
      mp.full_name as athlete_name,
      mp.phone as athlete_phone,
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      s.max_participants as max_participants,
      'active'::public.registration_status as reg_status,
      smp.added_at as registered_at,
      smp.attended,
      smp.payment_method,
      smp.amount_paid,
      cm.reason as cancellation_reason,
      case
        when cm.cancelled_at is not null then cm.charged_full_price
        else null
      end as cancellation_within_24h,
      cm.cancelled_at
    from public.session_manual_participants smp
    join public.manual_participants mp on mp.id = smp.manual_participant_id
    join public.training_sessions s on s.id = smp.session_id
    left join lateral (
      select c2.reason, c2.cancelled_at, c2.charged_full_price
      from public.cancellations c2
      where mp.linked_user_id is not null
        and c2.session_id = smp.session_id
        and c2.user_id = mp.linked_user_id
      order by c2.cancelled_at desc
      limit 1
    ) cm on true
    where s.session_date >= p_start
      and s.session_date <= p_end
      and (
        p_phone_search is null
        or length(trim(p_phone_search)) = 0
        or mp.phone ilike '%' || trim(p_phone_search) || '%'
      )
      and (
        p_athlete_key is null
        or smp.manual_participant_id = p_athlete_key
        or mp.linked_user_id = p_athlete_key
      )
  ) u
  order by u.athlete_name asc, u.session_date desc, u.start_time desc;
end;
$$;

grant execute on function public.participant_registration_history(date, date, text, uuid) to authenticated;

-- Session notes: update policy + RPC (same permission as delete).
drop policy if exists session_notes_update_author_or_manager on public.session_notes;
create policy session_notes_update_author_or_manager on public.session_notes for update using (
  public.is_coach_or_manager(auth.uid())
  and (public.is_manager(auth.uid()) or author_id = auth.uid())
) with check (
  public.is_coach_or_manager(auth.uid())
  and (public.is_manager(auth.uid()) or author_id = auth.uid())
  and body is not null
  and length(trim(body)) >= 1
);

create or replace function public.update_session_note(p_note_id uuid, p_body text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_note public.session_notes%rowtype;
  v_sess public.training_sessions%rowtype;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_body is null or length(trim(p_body)) < 1 then return json_build_object('ok', false, 'error', 'empty'); end if;

  select * into v_note from public.session_notes where id = p_note_id;
  if not found then return json_build_object('ok', false, 'error', 'not_found'); end if;

  if not (public.is_manager(v_uid) or v_note.author_id = v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_sess from public.training_sessions where id = v_note.session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  if not (public.is_manager(v_uid) or v_sess.coach_id = v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  update public.session_notes set body = trim(p_body) where id = p_note_id;
  return json_build_object('ok', true);
end;
$$;

grant execute on function public.update_session_note(uuid, text) to authenticated;

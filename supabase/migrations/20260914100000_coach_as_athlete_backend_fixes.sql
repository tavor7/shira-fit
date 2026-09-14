-- Coaches registered as session athletes (see 20260911100000_coach_add_athlete_allow_coach_role.sql)
-- were still silently dropped or rejected by several downstream functions that hard-checked
-- role = 'athlete'. This migration brings those in line: payments/receipts, the participant
-- history report, family linking, and push/WhatsApp session reminders now treat a coach
-- registered into a session the same as an athlete.

-- Payments: allow recording a payment against a coach payee.
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
      where p.user_id = new.payee_id and p.role in ('athlete', 'coach')
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

-- Receipts: coaches are eligible for address/consent collection, same as athletes and managers.
create or replace function public._is_receipt_existing_user_profile(p public.profiles)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    p.user_id is not null
    and p.disabled_at is null
    and (
      p.role = 'manager'
      or p.role = 'coach'
      or (p.role = 'athlete' and p.approval_status = 'approved')
    );
$$;

comment on function public._is_receipt_existing_user_profile(public.profiles) is
  'Active athletes (approved), coaches, and managers eligible for receipt address/consent collection.';

create or replace function public._is_receipt_go_live_profile(p public.profiles)
returns boolean
language sql
stable
set search_path = public
as $$
  select
    p.user_id is not null
    and p.disabled_at is null
    and (
      p.role = 'manager'
      or p.role = 'coach'
      or (p.role = 'athlete' and p.approval_status in ('pending', 'approved'))
    );
$$;

-- Family linking: allow a coach to be added as an athlete-family member.
create or replace function public.upsert_athlete_family(
  p_family_id uuid,
  p_name text,
  p_members jsonb default '[]'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_family_id uuid;
  v_name text;
  v_member jsonb;
  v_kind text;
  v_id uuid;
  v_other_family uuid;
  v_is_create boolean := false;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  v_name := trim(coalesce(p_name, ''));
  if char_length(v_name) = 0 then
    return json_build_object('ok', false, 'error', 'name_required');
  end if;

  if p_family_id is null then
    insert into public.athlete_families(name) values (v_name) returning id into v_family_id;
    v_is_create := true;
  else
    update public.athlete_families
    set name = v_name, updated_at = now()
    where id = p_family_id
    returning id into v_family_id;
    if v_family_id is null then
      return json_build_object('ok', false, 'error', 'not_found');
    end if;
    delete from public.athlete_family_members where family_id = v_family_id;
  end if;

  if jsonb_typeof(p_members) <> 'array' then
    return json_build_object('ok', false, 'error', 'invalid_members');
  end if;

  for v_member in select value from jsonb_array_elements(p_members)
  loop
    v_kind := lower(trim(coalesce(v_member->>'kind', '')));
    v_id := nullif(trim(v_member->>'id'), '')::uuid;

    if v_id is null or v_kind not in ('app', 'manual') then
      return json_build_object('ok', false, 'error', 'invalid_member');
    end if;

    if v_kind = 'app' then
      if not exists (
        select 1 from public.profiles pr where pr.user_id = v_id and pr.role in ('athlete', 'coach')
      ) then
        return json_build_object('ok', false, 'error', 'invalid_athlete');
      end if;

      select fm.family_id into v_other_family
      from public.athlete_family_members fm
      where fm.user_id = v_id and fm.family_id <> v_family_id
      limit 1;
      if v_other_family is not null then
        return json_build_object('ok', false, 'error', 'member_in_other_family');
      end if;

      insert into public.athlete_family_members(family_id, user_id)
      values (v_family_id, v_id);
    else
      if not exists (select 1 from public.manual_participants mp where mp.id = v_id) then
        return json_build_object('ok', false, 'error', 'invalid_manual');
      end if;

      select fm.family_id into v_other_family
      from public.athlete_family_members fm
      where fm.manual_participant_id = v_id and fm.family_id <> v_family_id
      limit 1;
      if v_other_family is not null then
        return json_build_object('ok', false, 'error', 'member_in_other_family');
      end if;

      insert into public.athlete_family_members(family_id, manual_participant_id)
      values (v_family_id, v_id);
    end if;
  end loop;

  perform public._insert_activity_event(
    v_uid,
    case when v_is_create then 'athlete_family_created' else 'athlete_family_updated' end,
    'athlete_family',
    v_family_id::text,
    jsonb_build_object('name', v_name, 'members', p_members)
  );

  return json_build_object('ok', true, 'family_id', v_family_id);
end;
$$;

-- Participant history report: include a coach's own registrations.
create or replace function public.participant_registration_history(
  p_start date,
  p_end date,
  p_phone_search text default null,
  p_athlete_key uuid default null,
  p_family_id uuid default null
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
  payment_recorded_by_name text,
  payment_recorded_at timestamptz,
  cancellation_reason text,
  cancellation_within_24h boolean,
  cancellation_within_12h boolean,
  cancelled_at timestamptz,
  charge_no_show boolean,
  cancellation_charged boolean,
  cancellation_penalty_collected numeric,
  cancellation_id uuid
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_is_super boolean;
  v_is_manager boolean;
  v_is_coach boolean;
begin
  if not public.is_coach_or_manager(v_uid) then
    return;
  end if;

  if p_start > p_end then
    return;
  end if;

  v_is_super := public.is_super_user(v_uid);
  v_is_manager := public.is_manager(v_uid);
  v_is_coach := public.is_coach(v_uid);

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
    u.payment_recorded_by_name,
    u.payment_recorded_at,
    u.cancellation_reason,
    u.cancellation_within_24h,
    u.cancellation_within_12h,
    u.cancelled_at,
    u.charge_no_show,
    u.cancellation_charged,
    u.cancellation_penalty_collected,
    u.cancellation_id
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
      pr.full_name as payment_recorded_by_name,
      r.payment_recorded_at,
      c.reason as cancellation_reason,
      case
        when c.cancelled_at is not null then
          ((s.session_date + s.start_time)::timestamptz - c.cancelled_at) <= interval '24 hours'
          and c.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        else null
      end as cancellation_within_24h,
      case
        when c.cancelled_at is not null then
          ((s.session_date + s.start_time)::timestamptz - c.cancelled_at) <= interval '12 hours'
          and c.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        else null
      end as cancellation_within_12h,
      c.cancelled_at,
      case when r.status = 'active' then r.charge_no_show else null end as charge_no_show,
      case when c.cancelled_at is not null then c.charged_full_price else null end as cancellation_charged,
      case when c.cancelled_at is not null then c.penalty_collected_ils else null end as cancellation_penalty_collected,
      c.cancellation_id
    from public.session_registrations r
    join public.profiles p on p.user_id = r.user_id
    join public.training_sessions s on s.id = r.session_id
    left join public.profiles pr on pr.user_id = r.payment_recorded_by
    left join lateral (
      select
        c2.id as cancellation_id,
        c2.reason,
        c2.cancelled_at,
        c2.charged_full_price,
        c2.penalty_collected_ils
      from public.cancellations c2
      where c2.session_id = r.session_id
        and c2.user_id = r.user_id
      order by c2.cancelled_at desc
      limit 1
    ) c on true
    where p.role in ('athlete', 'coach')
      and s.session_date >= p_start
      and s.session_date <= p_end
      and (
        v_is_super
        or (v_is_manager and not public.is_registration_hidden_from_manager(s.id, r.user_id))
        or (v_is_coach and not public.is_registration_hidden_from_coach(s.id, r.user_id))
      )
      and (
        p_family_id is not null
        or p_phone_search is null
        or length(trim(p_phone_search)) = 0
        or p.phone ilike '%' || trim(p_phone_search) || '%'
      )
      and (
        case
          when p_family_id is not null then
            r.user_id in (
              select fm.user_id
              from public.athlete_family_members fm
              where fm.family_id = p_family_id and fm.user_id is not null
              union
              select mp.linked_user_id
              from public.athlete_family_members fm
              join public.manual_participants mp on mp.id = fm.manual_participant_id
              where fm.family_id = p_family_id
                and fm.manual_participant_id is not null
                and mp.linked_user_id is not null
            )
          else
            p_athlete_key is null or r.user_id = p_athlete_key
        end
      )
      and (
        r.status <> 'cancelled'
        or (
          c.cancelled_at is not null
          and ((s.session_date + s.start_time)::timestamptz - c.cancelled_at) <= interval '12 hours'
          and c.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        )
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
      pr.full_name as payment_recorded_by_name,
      smp.payment_recorded_at,
      cm.reason as cancellation_reason,
      case
        when cm.cancelled_at is not null then
          ((s.session_date + s.start_time)::timestamptz - cm.cancelled_at) <= interval '24 hours'
          and cm.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        else null
      end as cancellation_within_24h,
      case
        when cm.cancelled_at is not null then
          ((s.session_date + s.start_time)::timestamptz - cm.cancelled_at) <= interval '12 hours'
          and cm.cancelled_at <= ((s.session_date + s.start_time)::timestamptz)
        else null
      end as cancellation_within_12h,
      cm.cancelled_at,
      smp.charge_no_show as charge_no_show,
      case when cm.cancelled_at is not null then cm.charged_full_price else null end as cancellation_charged,
      case when cm.cancelled_at is not null then cm.penalty_collected_ils else null end as cancellation_penalty_collected,
      cm.cancellation_id
    from public.session_manual_participants smp
    join public.manual_participants mp on mp.id = smp.manual_participant_id
    join public.training_sessions s on s.id = smp.session_id
    left join public.profiles pr on pr.user_id = smp.payment_recorded_by
    left join lateral (
      select
        c2.id as cancellation_id,
        c2.reason,
        c2.cancelled_at,
        c2.charged_full_price,
        c2.penalty_collected_ils
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
        p_family_id is not null
        or p_phone_search is null
        or length(trim(p_phone_search)) = 0
        or mp.phone ilike '%' || trim(p_phone_search) || '%'
      )
      and (
        case
          when p_family_id is not null then
            smp.manual_participant_id in (
              select fm.manual_participant_id
              from public.athlete_family_members fm
              where fm.family_id = p_family_id and fm.manual_participant_id is not null
            )
            or mp.linked_user_id in (
              select fm.user_id
              from public.athlete_family_members fm
              where fm.family_id = p_family_id and fm.user_id is not null
            )
          else
            p_athlete_key is null
            or smp.manual_participant_id = p_athlete_key
            or mp.linked_user_id = p_athlete_key
        end
      )
  ) u
  order by u.athlete_name asc, u.session_date desc, u.start_time desc;
end;
$$;

-- Push reminders: a coach registered into a session gets the same day-before/hour-before
-- reminders as an athlete (coaches have no approval_status gate, so they always qualify).
create or replace function public.dispatch_due_session_push_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public._studio_today_date();
  v_time_now time := (now() at time zone 'Asia/Jerusalem')::time;
  v_row record;
  v_count int := 0;
  v_title text;
  v_body text;
  v_claimed boolean;
begin
  if not public._push_notifications_enabled() then
    return 0;
  end if;

  if v_time_now >= time '20:00' and v_time_now < time '20:15' then
    v_title := 'תזכורת לאימון מחר';
    for v_row in
      select r.user_id, s.id as session_id, s.start_time, p.expo_push_token
      from public.session_registrations r
      join public.training_sessions s on s.id = r.session_id
      join public.profiles p on p.user_id = r.user_id
      where r.status = 'active'
        and coalesce(s.is_hidden, false) = false
        and (p.role = 'coach' or (p.role = 'athlete' and p.approval_status = 'approved'))
        and p.disabled_at is null
        and s.session_date = v_today + 1
    loop
      v_claimed := true;
      begin
        insert into public.push_reminder_dispatched (session_id, user_id, reminder_type)
        values (v_row.session_id, v_row.user_id, 'day_before_20h');
      exception when unique_violation then
        v_claimed := false;
      end;
      if not v_claimed then
        continue;
      end if;

      v_body := 'תזכורת: האימון שלך מחר בשעה ' || to_char(v_row.start_time, 'HH24:MI') || '. מצפים לראותך!';

      if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
        begin
          perform net.http_post(
            url := 'https://exp.host/--/api/v2/push/send',
            headers := jsonb_build_object('Content-Type', 'application/json'),
            body := jsonb_build_object(
              'to', v_row.expo_push_token,
              'title', v_title,
              'body', v_body,
              'data', jsonb_build_object('session_id', v_row.session_id)
            )
          );
        exception when others then
          null;
        end;
      end if;

      begin
        perform public.invoke_send_web_push_edge(
          v_row.user_id,
          v_title,
          v_body,
          jsonb_build_object('session_id', v_row.session_id::text)
        );
      exception when others then
        null;
      end;

      v_count := v_count + 1;
    end loop;
  end if;

  v_title := 'האימון מתחיל בקרוב';
  for v_row in
    select r.user_id, s.id as session_id, s.start_time, p.expo_push_token
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles p on p.user_id = r.user_id
    where r.status = 'active'
      and coalesce(s.is_hidden, false) = false
      and (p.role = 'coach' or (p.role = 'athlete' and p.approval_status = 'approved'))
      and p.disabled_at is null
      and public._session_start_at_studio(s.session_date, s.start_time)
          between now() + interval '50 minutes' and now() + interval '70 minutes'
  loop
    v_claimed := true;
    begin
      insert into public.push_reminder_dispatched (session_id, user_id, reminder_type)
      values (v_row.session_id, v_row.user_id, 'hour_before');
    exception when unique_violation then
      v_claimed := false;
    end;
    if not v_claimed then
      continue;
    end if;

    v_body := 'האימון שלך מתחיל בעוד כשעה, בשעה ' || to_char(v_row.start_time, 'HH24:MI') || '.';

    if v_row.expo_push_token is not null and length(trim(v_row.expo_push_token)) > 0 then
      begin
        perform net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object(
            'to', v_row.expo_push_token,
            'title', v_title,
            'body', v_body,
            'data', jsonb_build_object('session_id', v_row.session_id)
          )
        );
      exception when others then
        null;
      end;
    end if;

    begin
      perform public.invoke_send_web_push_edge(
        v_row.user_id,
        v_title,
        v_body,
        jsonb_build_object('session_id', v_row.session_id::text)
      );
    exception when others then
      null;
    end;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- WhatsApp reminders: same coach-inclusive gate as the push reminders above.
create or replace function public.enqueue_due_session_reminder_whatsapp()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count int := 0;
  v_dedupe text;
  v_id uuid;
begin
  if public._whatsapp_rollout_mode() = 'off' then
    return 0;
  end if;

  for v_row in
    select r.user_id, s.id as session_id, s.session_date, s.start_time
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles p on p.user_id = r.user_id
    where r.status = 'active'
      and coalesce(s.is_hidden, false) = false
      and (p.role = 'coach' or (p.role = 'athlete' and p.approval_status = 'approved'))
      and p.disabled_at is null
      and public._session_start_at_studio(s.session_date, s.start_time)
          between now() + interval '23 hours' and now() + interval '25 hours'
  loop
    v_dedupe := 'session_reminder_24h:' || v_row.session_id::text || ':' || v_row.user_id::text;

    v_id := public.enqueue_whatsapp_notification(
      v_row.user_id,
      'session_reminder_24h',
      v_dedupe,
      jsonb_build_object(
        'session_id', v_row.session_id,
        'session_date', v_row.session_date,
        'start_time', to_char(v_row.start_time, 'HH24:MI'),
        'template', 'session_reminder_24h'
      )
    );

    if v_id is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  for v_row in
    select r.user_id, s.id as session_id, s.session_date, s.start_time
    from public.session_registrations r
    join public.training_sessions s on s.id = r.session_id
    join public.profiles p on p.user_id = r.user_id
    where r.status = 'active'
      and coalesce(s.is_hidden, false) = false
      and (p.role = 'coach' or (p.role = 'athlete' and p.approval_status = 'approved'))
      and p.disabled_at is null
      and public._session_start_at_studio(s.session_date, s.start_time)
          between now() + interval '2 hours 45 minutes' and now() + interval '3 hours 15 minutes'
  loop
    v_dedupe := 'session_reminder_3h:' || v_row.session_id::text || ':' || v_row.user_id::text;

    v_id := public.enqueue_whatsapp_notification(
      v_row.user_id,
      'session_reminder_3h',
      v_dedupe,
      jsonb_build_object(
        'session_id', v_row.session_id,
        'session_date', v_row.session_date,
        'start_time', to_char(v_row.start_time, 'HH24:MI'),
        'template', 'session_reminder_3h'
      )
    );

    if v_id is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  if v_count > 0 then
    perform public.invoke_dispatch_notifications_edge();
  end if;

  return v_count;
end;
$$;

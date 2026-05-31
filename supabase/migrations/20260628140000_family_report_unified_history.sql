-- Family activity reports: same data for every member (ignore phone filter; resolve linked Quick Add).

create or replace function public.get_athlete_family(p_payee_id uuid, p_payee_is_manual boolean default false)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_family_id uuid;
  v_name text;
begin
  if not public.is_coach_or_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_payee_id is null then
    return json_build_object('ok', true, 'family', null);
  end if;

  select fm.family_id, f.name
  into v_family_id, v_name
  from public.athlete_family_members fm
  join public.athlete_families f on f.id = fm.family_id
  where (
    (not p_payee_is_manual and fm.user_id = p_payee_id)
    or (p_payee_is_manual and fm.manual_participant_id = p_payee_id)
    or (
      not p_payee_is_manual
      and fm.manual_participant_id in (
        select mp.id
        from public.manual_participants mp
        where mp.linked_user_id = p_payee_id
      )
    )
    or (
      p_payee_is_manual
      and fm.user_id in (
        select mp.linked_user_id
        from public.manual_participants mp
        where mp.id = p_payee_id and mp.linked_user_id is not null
      )
    )
  )
  limit 1;

  if v_family_id is null then
    return json_build_object('ok', true, 'family', null);
  end if;

  return json_build_object(
    'ok', true,
    'family', json_build_object(
      'id', v_family_id,
      'name', v_name,
      'members', coalesce((
        select json_agg(
          json_build_object(
            'kind', case when fm.user_id is not null then 'app' else 'manual' end,
            'id', coalesce(fm.user_id, fm.manual_participant_id),
            'name', case
              when fm.user_id is not null then (select pr.full_name from public.profiles pr where pr.user_id = fm.user_id)
              else (select mp.full_name from public.manual_participants mp where mp.id = fm.manual_participant_id)
            end,
            'phone', case
              when fm.user_id is not null then (select pr.phone from public.profiles pr where pr.user_id = fm.user_id)
              else (select mp.phone from public.manual_participants mp where mp.id = fm.manual_participant_id)
            end,
            'payee_is_manual', fm.manual_participant_id is not null
          )
          order by 4 nulls last
        )
        from public.athlete_family_members fm
        where fm.family_id = v_family_id
      ), '[]'::json)
    )
  );
end;
$$;

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
    where p.role = 'athlete'
      and s.session_date >= p_start
      and s.session_date <= p_end
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

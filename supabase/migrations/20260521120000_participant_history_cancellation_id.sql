-- Expose cancellations.id on participant_registration_history for manager actions in athlete activity UI.

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
        p_phone_search is null
        or length(trim(p_phone_search)) = 0
        or p.phone ilike '%' || trim(p_phone_search) || '%'
      )
      and (
        p_athlete_key is null
        or r.user_id = p_athlete_key
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

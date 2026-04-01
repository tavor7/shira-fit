-- Manager dashboard: weekly utilization, cancellations, no-shows, payment-method counts.

create or replace function public.manager_weekly_stats(p_week_start date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_end date := p_week_start + 6;
  v_sessions int := 0;
  v_util_sum numeric := 0;
  v_cancels int := 0;
  v_no_show int := 0;
  rec record;
  v_pay jsonb := '{}'::jsonb;
  v_key text;
  v_n int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  for rec in
    select s.id, s.max_participants, s.session_date
    from public.training_sessions s
    where s.session_date >= p_week_start and s.session_date <= v_end
  loop
    v_sessions := v_sessions + 1;
    v_util_sum := v_util_sum + (least(1.0, greatest(0.0,
      (public.active_registration_count(rec.id)::numeric / nullif(rec.max_participants, 0)::numeric)
    )));
  end loop;

  select count(*)::int into v_cancels
  from public.cancellations c
  join public.training_sessions s on s.id = c.session_id
  where s.session_date >= p_week_start and s.session_date <= v_end;

  -- No-show: active registration, session already started, explicitly marked absent.
  select count(*)::int into v_no_show
  from public.session_registrations reg
  join public.training_sessions s on s.id = reg.session_id
  where s.session_date >= p_week_start and s.session_date <= v_end
    and reg.status = 'active'
    and reg.attended = false
    and (s.session_date + s.start_time) < now();

  -- Payment method counts (arrived + recorded method) for regs + manual in range.
  for rec in
    select coalesce(nullif(trim(reg.payment_method), ''), '(none)') as k, count(*)::int as n
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    where s.session_date >= p_week_start and s.session_date <= v_end
      and reg.status = 'active'
      and reg.attended = true
    group by 1
  loop
    v_pay := jsonb_set(v_pay, array[rec.k], to_jsonb(rec.n), true);
  end loop;

  for rec in
    select coalesce(nullif(trim(m.payment_method), ''), '(none)') as k, count(*)::int as n
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    where s.session_date >= p_week_start and s.session_date <= v_end
      and m.attended = true
    group by 1
  loop
    v_key := rec.k;
    v_n := coalesce((v_pay->>v_key)::int, 0) + rec.n;
    v_pay := jsonb_set(v_pay, array[v_key], to_jsonb(v_n), true);
  end loop;

  return json_build_object(
    'ok', true,
    'week_start', p_week_start,
    'week_end', v_end,
    'session_count', v_sessions,
    'utilization_avg_pct', case when v_sessions > 0 then round((v_util_sum / v_sessions) * 100, 1) else 0 end,
    'cancellations', v_cancels,
    'no_shows', v_no_show,
    'payments_by_method', v_pay
  );
end;
$$;

grant execute on function public.manager_weekly_stats(date) to authenticated;

-- Coach payouts in manager_weekly_stats respect date-effective coach_capacity_pricing.

-- Pass manual_participant_id into session_billing_price_ils for Quick Add roster billing.

create or replace function public.manager_weekly_stats(p_anchor date, p_mode text default 'week')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_start date;
  v_end date;
  v_sessions int := 0;
  v_util_avg numeric := 0;
  v_cancels int := 0;
  v_no_show int := 0;
  v_wait int := 0;
  v_checked_in int := 0;
  v_pay jsonb := '{}'::jsonb;
  v_finance json;
  v_collections_by_day json := '[]'::json;
  v_expected_by_day json := '[]'::json;
  v_missing_attendance json := json_build_object('count', 0, 'sessions', '[]'::json);
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  v_mode := lower(trim(coalesce(p_mode, 'week')));
  if v_mode not in ('week', 'month') then
    v_mode := 'week';
  end if;

  if v_mode = 'month' then
    v_start := date_trunc('month', p_anchor::timestamp)::date;
    v_end := (v_start + interval '1 month - 1 day')::date;
  else
    v_start := public._week_start_sunday(p_anchor);
    v_end := v_start + 6;
  end if;

  with sess as (
    select s.id, s.max_participants, s.session_date, s.start_time
    from public.training_sessions s
    where s.session_date between v_start and v_end
  ),
  reg as (
    select r.session_id, count(*)::int as n
    from public.session_registrations r
    join sess s on s.id = r.session_id
    where r.status = 'active'
    group by r.session_id
  ),
  man as (
    select m.session_id, count(*)::int as n
    from public.session_manual_participants m
    join sess s on s.id = m.session_id
    group by m.session_id
  ),
  counts as (
    select
      s.id,
      s.max_participants,
      coalesce(reg.n, 0) + coalesce(man.n, 0) as participants
    from sess s
    left join reg on reg.session_id = s.id
    left join man on man.session_id = s.id
  )
  select
    count(*)::int,
    coalesce(
      round(
        avg(
          least(
            1.0,
            greatest(
              0.0,
              (participants::numeric / nullif(max_participants, 0)::numeric)
            )
          )
        ) * 100,
        1
      ),
      0
    )
  into v_sessions, v_util_avg
  from counts;

  select count(*)::int into v_cancels
  from public.cancellations c
  join public.training_sessions s on s.id = c.session_id
  where s.session_date between v_start and v_end;

  select count(*)::int into v_no_show
  from public.session_registrations reg
  join public.training_sessions s on s.id = reg.session_id
  where s.session_date between v_start and v_end
    and reg.status = 'active'
    and reg.attended = false
    and (s.session_date + s.start_time) < now();

  select count(*)::int into v_wait
  from public.waitlist_requests w
  join public.training_sessions s on s.id = w.session_id
  where s.session_date between v_start and v_end;

  select
    (select count(*)::int
     from public.session_registrations reg
     join public.training_sessions s on s.id = reg.session_id
     where s.session_date between v_start and v_end
       and reg.status = 'active'
       and reg.attended = true)
    +
    (select count(*)::int
     from public.session_manual_participants m
     join public.training_sessions s on s.id = m.session_id
     where s.session_date between v_start and v_end
       and m.attended = true)
  into v_checked_in;

  select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) into v_pay
  from (
    select k, sum(n)::int as n
    from (
      select
        public.normalize_payment_method_key(reg.payment_method) as k,
        count(*)::int as n
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
      group by 1

      union all

      select
        public.normalize_payment_method_key(m.payment_method) as k,
        count(*)::int as n
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
      group by 1
    ) x
    group by k
  ) y;

  select json_build_object(
    'coaches', coalesce(z.coaches, '[]'::json),
    'athlete_totals', coalesce(z.t, '{}'::json),
    'athletes', coalesce(z.j, '[]'::json),
    'amounts_by_method', coalesce(z.j_amt::json, '{}'::json)
  )
  into v_finance
  from (
    with week_sess as (
      select
        s.id,
        s.coach_id,
        s.session_date,
        s.start_time,
        s.max_participants,
        coalesce(s.duration_minutes, 60)::int as duration_minutes
      from public.training_sessions s
      where s.session_date between v_start and v_end
    ),
    coach_lines as (
      select
        ws.coach_id,
        ws.id as session_id,
        ws.session_date,
        ws.start_time,
        ws.duration_minutes,
        (t.reg_n + t.man_n)::int as registered_count,
        ws.max_participants as group_capacity,
        public.coach_capacity_price_ils(ws.coach_id, (t.reg_n + t.man_n), ws.session_date) as rate_ils,
        (
          case
            when (t.reg_n + t.man_n) > 0 then
              public.coach_capacity_price_ils(ws.coach_id, (t.reg_n + t.man_n), ws.session_date)
            else 0::numeric
          end
        ) as payout_ils,
        (
          (t.reg_n + t.man_n) > 0
          and public.coach_capacity_price_ils(ws.coach_id, (t.reg_n + t.man_n), ws.session_date) = 0
        ) as rate_missing
      from week_sess ws
      cross join lateral (
        select
          coalesce((
            select count(*)::int
            from public.session_registrations r
            where r.session_id = ws.id and r.status = 'active'
          ), 0) as reg_n,
          coalesce((
            select count(*)::int
            from public.session_manual_participants smp
            where smp.session_id = ws.id
          ), 0) as man_n
      ) t
    ),
    coach_block as (
      select coalesce(
        json_agg(
          json_build_object(
            'coach_id', q.coach_id,
            'name', q.coach_name,
            'payout_ils', q.payout_sum,
            'has_rate_gap', q.has_rate_gap,
            'sessions', q.sessions_json
          )
          order by q.coach_name nulls last, q.coach_id::text
        ),
        '[]'::json
      ) as coaches
      from (
        select
          cl.coach_id,
          pr.full_name as coach_name,
          round(sum(cl.payout_ils)::numeric, 2) as payout_sum,
          bool_or(cl.rate_missing) as has_rate_gap,
          json_agg(
            json_build_object(
              'session_id', cl.session_id,
              'session_date', cl.session_date,
              'start_time', cl.start_time::text,
              'duration_minutes', cl.duration_minutes,
              'registered_count', cl.registered_count,
              'group_capacity', cl.group_capacity,
              'tier_registered', cl.registered_count,
              'rate_ils', cl.rate_ils,
              'payout_ils', round(cl.payout_ils::numeric, 2),
              'rate_missing', cl.rate_missing
            )
            order by cl.session_date, cl.start_time
          ) as sessions_json
        from coach_lines cl
        left join public.profiles pr on pr.user_id = cl.coach_id
        group by cl.coach_id, pr.full_name
      ) q
    ),
    arrived_money as (
      select
        coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)::numeric as expected,
        coalesce(reg.amount_paid, 0)::numeric as collected,
        public.normalize_payment_method_key(reg.payment_method) as pay_method
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is true
      union all
      select
        coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)::numeric,
        coalesce(m.amount_paid, 0)::numeric,
        public.normalize_payment_method_key(m.payment_method)
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is true
      union all
      select
        coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)::numeric,
        coalesce(reg.amount_paid, 0)::numeric,
        public.normalize_payment_method_key(reg.payment_method)
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is false
        and reg.charge_no_show is true
      union all
      select
        coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)::numeric,
        coalesce(m.amount_paid, 0)::numeric,
        public.normalize_payment_method_key(m.payment_method)
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is false
        and m.charge_no_show is true
    ),
    amt_m as (
      select coalesce(
        (
          select jsonb_object_agg(x.k, x.v)
          from (
            select
              am.pay_method as k,
              round(sum(am.collected)::numeric, 2) as v
            from arrived_money am
            group by am.pay_method
          ) x
        ),
        '{}'::jsonb
      ) as j
    ),
    per_slot as (
      select
        'app'::text as kind,
        reg.user_id::text as pid,
        coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)::numeric as exp_amt,
        coalesce(reg.amount_paid, 0)::numeric as coll_amt
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is true
      union all
      select
        'manual'::text,
        m.manual_participant_id::text,
        coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)::numeric,
        coalesce(m.amount_paid, 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is true
      union all
      select
        'app'::text,
        reg.user_id::text,
        coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)::numeric,
        coalesce(reg.amount_paid, 0)::numeric
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is false
        and reg.charge_no_show is true
      union all
      select
        'manual'::text,
        m.manual_participant_id::text,
        coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)::numeric,
        coalesce(m.amount_paid, 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is false
        and m.charge_no_show is true
      union all
      select
        'app'::text,
        c.user_id::text,
        coalesce(public.session_billing_price_ils(s.id, c.user_id), 0)::numeric,
        coalesce(c.penalty_collected_ils, 0)::numeric
      from public.cancellations c
      join public.training_sessions s on s.id = c.session_id
      where s.session_date between v_start and v_end
        and c.charged_full_price is true
    ),
    sess_by_ath as (
      select
        ps.kind,
        ps.pid,
        round(sum(ps.exp_amt)::numeric, 2) as expected_ils,
        round(sum(ps.coll_amt)::numeric, 2) as collected_sessions_ils
      from per_slot ps
      group by ps.kind, ps.pid
    ),
    acct_by_ath as (
      select
        case when a.payee_is_manual then 'manual' else 'app' end as kind,
        a.payee_id::text as pid,
        round(sum(a.amount_ils)::numeric, 2) as collected_account_ils
      from public.athlete_account_payments a
      where a.paid_at between v_start and v_end
      group by 1, 2
    ),
    ath_keys as (
      select kind, pid from sess_by_ath
      union
      select kind, pid from acct_by_ath
    ),
    merged_ath as (
      select
        k.kind,
        k.pid,
        coalesce(s.expected_ils, 0)::numeric as expected_ils,
        coalesce(s.collected_sessions_ils, 0)::numeric as collected_sessions_ils,
        coalesce(a.collected_account_ils, 0)::numeric as collected_account_ils,
        (
          coalesce(s.collected_sessions_ils, 0) + coalesce(a.collected_account_ils, 0)
        )::numeric as collected_total_ils
      from ath_keys k
      left join sess_by_ath s on s.kind = k.kind and s.pid = k.pid
      left join acct_by_ath a on a.kind = k.kind and a.pid = k.pid
    ),
    ath_tot as (
      select json_build_object(
        'expected_ils', round(coalesce(sum(m.expected_ils), 0)::numeric, 2),
        'collected_sessions_ils', round(coalesce(sum(m.collected_sessions_ils), 0)::numeric, 2),
        'collected_account_ils', round(coalesce(sum(m.collected_account_ils), 0)::numeric, 2),
        'collected_total_ils', round(coalesce(sum(m.collected_total_ils), 0)::numeric, 2),
        'outstanding_ils', round((
          coalesce(sum(m.expected_ils), 0)
          - coalesce(sum(m.collected_sessions_ils), 0)
          - coalesce(sum(m.collected_account_ils), 0)
        )::numeric, 2)
      ) as t
      from merged_ath m
    ),
    ath_list as (
      select coalesce(
        json_agg(
          json_build_object(
            'kind', x.kind,
            'id', x.pid,
            'name', x.disp_name,
            'expected_ils', x.expected_ils,
            'collected_sessions_ils', x.collected_sessions_ils,
            'collected_account_ils', x.collected_account_ils,
            'collected_total_ils', x.collected_total_ils,
            'outstanding_ils', x.outstanding_ils
          )
          order by x.outstanding_ils desc nulls last, x.disp_name nulls last
        ),
        '[]'::json
      ) as j
      from (
        select
          m.kind,
          m.pid,
          case
            when m.kind = 'app' then (select pr.full_name from public.profiles pr where pr.user_id = m.pid::uuid)
            else (select mp.full_name from public.manual_participants mp where mp.id = m.pid::uuid)
          end as disp_name,
          round(m.expected_ils::numeric, 2) as expected_ils,
          round(m.collected_sessions_ils::numeric, 2) as collected_sessions_ils,
          round(m.collected_account_ils::numeric, 2) as collected_account_ils,
          round(m.collected_total_ils::numeric, 2) as collected_total_ils,
          round((
            m.expected_ils - m.collected_sessions_ils - m.collected_account_ils
          )::numeric, 2) as outstanding_ils
        from merged_ath m
        where m.expected_ils > 0
          or m.collected_sessions_ils > 0
          or m.collected_account_ils > 0
        order by (m.expected_ils - m.collected_sessions_ils - m.collected_account_ils) desc nulls last
        limit 200
      ) x
    )
    select cb.coaches, at.t, al.j, am.j
    from coach_block cb
    cross join ath_tot at
    cross join ath_list al
    cross join amt_m am
  ) z(coaches, t, j, j_amt);

  select coalesce(
    json_agg(
      json_build_object(
        'date', d.day_date,
        'collected_ils', d.day_total,
        'sessions_ils', d.sessions_total,
        'account_ils', d.account_total,
        'sessions', d.sessions_json
      )
      order by d.day_date
    ),
    '[]'::json
  )
  into v_collections_by_day
  from (
    with session_slot_money as (
      select reg.session_id, coalesce(reg.amount_paid, 0)::numeric as amt
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and (
          reg.attended is true
          or (reg.attended is false and reg.charge_no_show is true)
        )
      union all
      select m.session_id, coalesce(m.amount_paid, 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and (
          m.attended is true
          or (m.attended is false and m.charge_no_show is true)
        )
      union all
      select c.session_id, coalesce(c.penalty_collected_ils, 0)::numeric
      from public.cancellations c
      join public.training_sessions s on s.id = c.session_id
      where s.session_date between v_start and v_end
        and c.charged_full_price is true
    ),
    per_session as (
      select
        s.id as session_id,
        s.session_date,
        s.start_time,
        s.max_participants,
        pr.full_name as coach_name,
        round(sum(ssm.amt)::numeric, 2) as collected_ils,
        (
          coalesce((
            select count(*)::int
            from public.session_registrations r
            where r.session_id = s.id and r.status = 'active'
          ), 0)
          + coalesce((
            select count(*)::int
            from public.session_manual_participants m
            where m.session_id = s.id
          ), 0)
        ) as registered_count,
        (
          coalesce((
            select count(*)::int
            from public.session_registrations r
            where r.session_id = s.id and r.status = 'active' and r.attended is true
          ), 0)
          + coalesce((
            select count(*)::int
            from public.session_manual_participants m
            where m.session_id = s.id and m.attended is true
          ), 0)
        ) as arrived_count,
        coalesce((
          select count(*)::int
          from public.cancellations c
          where c.session_id = s.id and c.charged_full_price is true
        ), 0) as late_cancel_charged_count
      from session_slot_money ssm
      join public.training_sessions s on s.id = ssm.session_id
      left join public.profiles pr on pr.user_id = s.coach_id
      group by s.id, s.session_date, s.start_time, s.max_participants, pr.full_name
    ),
    account_by_day as (
      select
        (a.paid_at::date) as day_date,
        round(sum(a.amount_ils)::numeric, 2) as account_ils
      from public.athlete_account_payments a
      where a.paid_at::date between v_start and v_end
      group by 1
    ),
    day_keys as (
      select distinct session_date as day_date from per_session
      union
      select day_date from account_by_day
    ),
    day_sessions as (
      select
        dk.day_date,
        coalesce(
          json_agg(
            json_build_object(
              'session_id', ps.session_id,
              'start_time', ps.start_time::text,
              'coach_name', ps.coach_name,
              'collected_ils', ps.collected_ils,
              'max_participants', ps.max_participants,
              'registered_count', ps.registered_count,
              'arrived_count', ps.arrived_count,
              'late_cancel_charged_count', ps.late_cancel_charged_count
            )
            order by ps.start_time
          ),
          '[]'::json
        ) as sessions_json,
        round(coalesce(sum(ps.collected_ils), 0)::numeric, 2) as sessions_total
      from day_keys dk
      left join per_session ps on ps.session_date = dk.day_date
      group by dk.day_date
    )
    select
      ds.day_date,
      ds.sessions_json,
      ds.sessions_total,
      coalesce(ab.account_ils, 0)::numeric as account_total,
      round((ds.sessions_total + coalesce(ab.account_ils, 0))::numeric, 2) as day_total
    from day_sessions ds
    left join account_by_day ab on ab.day_date = ds.day_date
    where ds.sessions_total > 0 or coalesce(ab.account_ils, 0) > 0
  ) d;

  select coalesce(
    json_agg(
      json_build_object(
        'date', d.day_date,
        'expected_ils', d.day_total,
        'sessions', d.sessions_json
      )
      order by d.day_date
    ),
    '[]'::json
  )
  into v_expected_by_day
  from (
    with expected_slot_money as (
      select reg.session_id, coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)::numeric as exp_amt
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is true
      union all
      select m.session_id, coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is true
      union all
      select reg.session_id, coalesce(public.session_billing_price_ils(s.id, reg.user_id), 0)::numeric
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is false
        and reg.charge_no_show is true
      union all
      select m.session_id, coalesce(public.session_billing_price_ils(s.id, null, m.manual_participant_id), 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is false
        and m.charge_no_show is true
      union all
      select c.session_id, coalesce(public.session_billing_price_ils(s.id, c.user_id), 0)::numeric
      from public.cancellations c
      join public.training_sessions s on s.id = c.session_id
      where s.session_date between v_start and v_end
        and c.charged_full_price is true
    ),
    per_session_exp as (
      select
        s.id as session_id,
        s.session_date,
        s.start_time,
        s.max_participants,
        pr.full_name as coach_name,
        round(sum(esm.exp_amt)::numeric, 2) as expected_ils,
        (
          coalesce((
            select count(*)::int
            from public.session_registrations r
            where r.session_id = s.id and r.status = 'active'
          ), 0)
          + coalesce((
            select count(*)::int
            from public.session_manual_participants m
            where m.session_id = s.id
          ), 0)
        ) as registered_count,
        (
          coalesce((
            select count(*)::int
            from public.session_registrations r
            where r.session_id = s.id and r.status = 'active' and r.attended is true
          ), 0)
          + coalesce((
            select count(*)::int
            from public.session_manual_participants m
            where m.session_id = s.id and m.attended is true
          ), 0)
        ) as arrived_count,
        coalesce((
          select count(*)::int
          from public.cancellations c
          where c.session_id = s.id and c.charged_full_price is true
        ), 0) as late_cancel_charged_count
      from expected_slot_money esm
      join public.training_sessions s on s.id = esm.session_id
      left join public.profiles pr on pr.user_id = s.coach_id
      group by s.id, s.session_date, s.start_time, s.max_participants, pr.full_name
    ),
    exp_day_keys as (
      select distinct session_date as day_date from per_session_exp
    ),
    exp_day_sessions as (
      select
        dk.day_date,
        coalesce(
          json_agg(
            json_build_object(
              'session_id', ps.session_id,
              'start_time', ps.start_time::text,
              'coach_name', ps.coach_name,
              'expected_ils', ps.expected_ils,
              'max_participants', ps.max_participants,
              'registered_count', ps.registered_count,
              'arrived_count', ps.arrived_count,
              'late_cancel_charged_count', ps.late_cancel_charged_count
            )
            order by ps.start_time
          ),
          '[]'::json
        ) as sessions_json,
        round(coalesce(sum(ps.expected_ils), 0)::numeric, 2) as day_total
      from exp_day_keys dk
      left join per_session_exp ps on ps.session_date = dk.day_date
      group by dk.day_date
    )
    select day_date, sessions_json, day_total
    from exp_day_sessions
    where day_total > 0
  ) d;

  select json_build_object(
    'count', coalesce(count(*)::int, 0),
    'sessions', coalesce(
      json_agg(
        json_build_object(
          'session_id', x.session_id,
          'session_date', x.session_date,
          'start_time', x.start_time::text,
          'duration_minutes', x.duration_minutes,
          'coach_name', x.coach_name,
          'unset_count', x.unset_count
        )
        order by x.session_date desc, x.start_time desc
      ),
      '[]'::json
    )
  )
  into v_missing_attendance
  from (
    select
      s.id as session_id,
      s.session_date,
      s.start_time,
      coalesce(s.duration_minutes, 60)::int as duration_minutes,
      pr.full_name as coach_name,
      (
        coalesce((
          select count(*)::int
          from public.session_registrations r
          where r.session_id = s.id
            and r.status = 'active'
            and r.attended is null
        ), 0)
        + coalesce((
          select count(*)::int
          from public.session_manual_participants m
          where m.session_id = s.id
            and m.attended is null
        ), 0)
      ) as unset_count
    from public.training_sessions s
    left join public.profiles pr on pr.user_id = s.coach_id
    where s.session_date between v_start and v_end
      and (
        (s.session_date + s.start_time)::timestamptz
        + (coalesce(s.duration_minutes, 60) || ' minutes')::interval
      ) < now()
      and (
        exists (
          select 1
          from public.session_registrations r
          where r.session_id = s.id and r.status = 'active'
        )
        or exists (
          select 1 from public.session_manual_participants m where m.session_id = s.id
        )
      )
      and (
        exists (
          select 1
          from public.session_registrations r
          where r.session_id = s.id and r.status = 'active' and r.attended is null
        )
        or exists (
          select 1
          from public.session_manual_participants m
          where m.session_id = s.id and m.attended is null
        )
      )
  ) x;

  v_finance := (
    v_finance::jsonb
    || jsonb_build_object(
      'collections_by_day', v_collections_by_day::jsonb,
      'expected_by_day', v_expected_by_day::jsonb
    )
  )::json;

  return json_build_object(
    'ok', true,
    'period', v_mode,
    'week_start', v_start,
    'week_end', v_end,
    'session_count', v_sessions,
    'utilization_avg_pct', v_util_avg,
    'cancellations', v_cancels,
    'no_shows', v_no_show,
    'waitlist_count', v_wait,
    'checked_in_count', v_checked_in,
    'payments_by_method', v_pay,
    'finance', v_finance,
    'missing_attendance', v_missing_attendance
  );
end;
$$;


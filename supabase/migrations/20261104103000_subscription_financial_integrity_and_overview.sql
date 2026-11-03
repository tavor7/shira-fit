-- Financial integrity, reporting and the Overview's read side.
--
-- Changes no existing row. What changes at deploy: the numbers Reports shows per day (they stop charging covered sessions,
-- start including subscription charges and stop including reversed payments), family "expected"/"collected" (discounts
-- reduce expected instead of counting as cash; outstanding is unchanged, so payment reminders are unaffected), and who may
-- write to subscription tables.

-- ---------------------------------------------------------------------------
-- Subscription records are written only through their RPCs. Managers keep read access; the RPCs are SECURITY DEFINER.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'subscriptions', 'subscription_versions', 'subscription_version_allowances', 'subscription_billing_periods',
    'subscription_charges', 'subscription_freezes', 'subscription_registration_coverage',
    'subscription_impact_events', 'subscription_impact_event_registrations'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_manager_all', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_manager((select auth.uid())))', t || '_manager_select', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from authenticated', t);
  end loop;
end $$;

revoke all on public.subscription_group_price_defaults from anon;
revoke truncate, references, trigger on public.subscription_group_price_defaults from authenticated;
revoke all on public.athlete_account_payments from anon;
revoke truncate, references, trigger on public.athlete_account_payments from authenticated;

-- The charge ledger is append-only for everyone, owner connections included: corrections are new rows. created_by alone may
-- change, because its foreign key is ON DELETE SET NULL.
create or replace function public._subscription_charges_append_only()
returns trigger
language plpgsql
as $$
begin
  if (new.billing_period_id, new.subscription_id, new.payee_id, new.payee_is_manual, new.amount_ils, new.charge_type, new.reverses, new.source_event_id, new.created_at)
     is distinct from
     (old.billing_period_id, old.subscription_id, old.payee_id, old.payee_is_manual, old.amount_ils, old.charge_type, old.reverses, old.source_event_id, old.created_at) then
    raise exception 'subscription_ledger_append_only'
      using errcode = 'P0001', detail = 'Charges cannot be edited. Post a correction through the subscription RPCs.';
  end if;
  return new;
end;
$$;

drop trigger if exists subscription_charges_append_only on public.subscription_charges;
create trigger subscription_charges_append_only
  before update on public.subscription_charges
  for each row execute function public._subscription_charges_append_only();

-- ---------------------------------------------------------------------------
-- One rule for "may this subscription receive a payment on this date": the RPC and the Add Payment screen both use it.
-- ---------------------------------------------------------------------------
create or replace function public._subscription_payment_eligible(p_subscription_id uuid, p_paid_at date)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v record;
begin
  -- The version effective on the date; if none yet, the earliest: an advance payment is legitimate.
  select sv.* into v
  from public.subscription_versions sv
  where sv.subscription_id = p_subscription_id
    and sv.effective_from <= p_paid_at
    and (sv.effective_to is null or sv.effective_to > p_paid_at)
  order by sv.effective_from desc
  limit 1;

  if not found then
    select sv.* into v
    from public.subscription_versions sv
    where sv.subscription_id = p_subscription_id and sv.effective_from > p_paid_at
    order by sv.effective_from asc
    limit 1;
    if not found then
      return false;
    end if;
  end if;

  if v.stopped_effective_date is not null and p_paid_at >= v.stopped_effective_date then
    return false;
  end if;
  if v.plan_end_date is not null and p_paid_at > public.subscription_shifted_date(p_subscription_id, v.plan_end_date) then
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.subscription_payment_target(p_payee_id uuid, p_payee_is_manual boolean, p_paid_at date)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id
  from public.subscriptions s
  where public.is_manager(auth.uid())
    and s.payee_id = p_payee_id and s.payee_is_manual = p_payee_is_manual and s.deleted_at is null
    and public._subscription_payment_eligible(s.id, p_paid_at)
  order by s.created_at desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Monitoring: the daily billing run also checks that the system is coherent. Reports only; never changes data.
-- ---------------------------------------------------------------------------
create or replace function public._subscription_integrity_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public._studio_today_date();
  v_week date := v_today - extract(dow from v_today)::int;
  v_overdue int;
  v_over int;
begin
  select count(*) into v_overdue
  from public.subscriptions s
  join lateral public._subscription_next_charge(s.id) nc on true
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where s.deleted_at is null and nc.charge_date <= v_today and v.plan_start_date <= v_today;

  select coalesce(sum(greatest((u->>'used')::int - (u->>'effective_weekly_limit')::int, 0)), 0) into v_over
  from (select distinct payee_id, payee_is_manual from public.subscriptions where deleted_at is null) p
  cross join lateral jsonb_array_elements(public._subscription_week_usage(
    null, p.payee_id, p.payee_is_manual, v_week,
    (select array_agg(t order by t) from unnest(enum_range(null::public.subscription_tier)) t))) u;

  if v_overdue > 0 then
    perform public._report_system_error(
      p_source := 'trusted', p_subsystem := 'subscriptions', p_operation := 'integrity_check',
      p_error_class := 'overdue_charge', p_message := v_overdue || ' subscription(s) have a due charge that was not posted',
      p_severity := 'error', p_entities := jsonb_build_object('count', v_overdue),
      p_fingerprint_key := 'subscription_overdue_charge');
  end if;
  if v_over > 0 then
    perform public._report_system_error(
      p_source := 'trusted', p_subsystem := 'subscriptions', p_operation := 'integrity_check',
      p_error_class := 'over_allocation', p_message := v_over || ' covered session(s) above the effective allowance this week',
      p_severity := 'warning', p_entities := jsonb_build_object('count', v_over, 'week_start', v_week),
      p_fingerprint_key := 'subscription_over_allocation');
  end if;
  return jsonb_build_object('overdue_charges', v_overdue, 'over_allocated_sessions', v_over);
end;
$$;

CREATE OR REPLACE FUNCTION public.manager_weekly_stats_core(p_anchor date, p_mode text DEFAULT 'week'::text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_is_super boolean;
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
  v_is_super := public.is_super_user(v_uid);

  v_mode := lower(trim(coalesce(p_mode, 'week')));
  if v_mode not in ('week', 'month', 'global') then
    v_mode := 'week';
  end if;

  select b.period_start, b.period_end into v_start, v_end
  from public._manager_stats_period_bounds(p_anchor, v_mode) b;

  -- Performance Phase 3: price every slot of the period once for this call (see _mws_prepare_price_memo).
  perform public._mws_prepare_price_memo(v_start, v_end);

  -- Capacity/utilization: real seats occupied, unaffected by hiding.
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
  where s.session_date between v_start and v_end
    and (v_is_super or not public.is_registration_hidden(c.session_id, c.user_id));

  select count(*)::int into v_no_show
  from public.session_registrations reg
  join public.training_sessions s on s.id = reg.session_id
  where s.session_date between v_start and v_end
    and reg.status = 'active'
    and reg.attended = false
    and (s.session_date + s.start_time) < now()
    and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id));

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
       and reg.attended = true
       and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id)))
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
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
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
        s.custom_coach_rate_ils,
        coalesce(s.duration_minutes, 60)::int as duration_minutes
      from public.training_sessions s
      where s.session_date between v_start and v_end
    ),
    -- Coach payout: real headcount regardless of hiding.
    coach_lines as (
      select
        ws.coach_id,
        ws.id as session_id,
        ws.session_date,
        ws.start_time,
        ws.duration_minutes,
        (t.reg_n + t.man_n)::int as registered_count,
        ws.max_participants as group_capacity,
        coalesce(ws.custom_coach_rate_ils, public.coach_capacity_price_ils(ws.coach_id, (t.reg_n + t.man_n), ws.session_date)) as rate_ils,
        (
          case
            when (t.reg_n + t.man_n) > 0 then
              coalesce(ws.custom_coach_rate_ils, public.coach_capacity_price_ils(ws.coach_id, (t.reg_n + t.man_n), ws.session_date))
            else 0::numeric
          end
        ) as payout_ils,
        (
          (t.reg_n + t.man_n) > 0
          and ws.custom_coach_rate_ils is null
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
    -- Athlete-facing money: exclude hidden app registrations/cancellations.
    arrived_money as (
      select
        coalesce(public._mws_price(s.id, reg.user_id, null), 0)::numeric as expected,
        coalesce(reg.amount_paid, 0)::numeric as collected,
        public.normalize_payment_method_key(reg.payment_method) as pay_method
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is true
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
      union all
      select
        coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0)::numeric,
        coalesce(m.amount_paid, 0)::numeric,
        public.normalize_payment_method_key(m.payment_method)
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is true
      union all
      select
        coalesce(public._mws_price(s.id, reg.user_id, null), 0)::numeric,
        coalesce(reg.amount_paid, 0)::numeric,
        public.normalize_payment_method_key(reg.payment_method)
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is false
        and reg.charge_no_show is true
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
      union all
      select
        coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0)::numeric,
        coalesce(m.amount_paid, 0)::numeric,
        public.normalize_payment_method_key(m.payment_method)
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is false
        and m.charge_no_show is true
    ),
    -- "Collected by method" must reconcile with "Total collected": include non-discount,
    -- non-reversed account-level payments (ordinary AND subscription -- both land in
    -- athlete_account_payments; a subscription payment has source_subscription_id set but
    -- is otherwise an ordinary row) keyed the same way session payments are, never
    -- inventing a method when one is missing (normalize_payment_method_key already maps
    -- null/blank to the existing '(none)' bucket).
    account_money as (
      select
        a.amount_ils::numeric as collected,
        public.normalize_payment_method_key(a.payment_method) as pay_method
      from public.athlete_account_payments a
      where a.paid_at between v_start and v_end
        and a.reversed_at is null
        and public.normalize_payment_method_key(a.payment_method) <> 'discount'
    ),
    amt_m as (
      select coalesce(
        (
          select jsonb_object_agg(x.k, x.v)
          from (
            select
              u.pay_method as k,
              round(sum(u.collected)::numeric, 2) as v
            from (
              select pay_method, collected from arrived_money
              union all
              select pay_method, collected from account_money
            ) u
            group by u.pay_method
          ) x
        ),
        '{}'::jsonb
      ) as j
    ),
    -- Per-athlete debt feed: exclude hidden app registrations/cancellations. A session
    -- covered by an active subscription (subscription_registration_coverage.covered) owes
    -- nothing of its own -- the subscription_charges line item below is its sole debt line,
    -- so this is never double-counted with the charge.
    per_slot as (
      select
        'app'::text as kind,
        reg.user_id::text as pid,
        (case when cov.covered then 0
          else coalesce(public._mws_price(s.id, reg.user_id, null), 0)
        end)::numeric as exp_amt,
        coalesce(reg.amount_paid, 0)::numeric as coll_amt
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is true
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
      union all
      select
        'manual'::text,
        m.manual_participant_id::text,
        (case when cov.covered then 0
          else coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0)
        end)::numeric,
        coalesce(m.amount_paid, 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
      where s.session_date between v_start and v_end
        and m.attended is true
      union all
      select
        'app'::text,
        reg.user_id::text,
        (case when cov.covered then 0
          else coalesce(public._mws_price(s.id, reg.user_id, null), 0)
        end)::numeric,
        coalesce(reg.amount_paid, 0)::numeric
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is false
        and reg.charge_no_show is true
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
      union all
      select
        'manual'::text,
        m.manual_participant_id::text,
        (case when cov.covered then 0
          else coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0)
        end)::numeric,
        coalesce(m.amount_paid, 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
      where s.session_date between v_start and v_end
        and m.attended is false
        and m.charge_no_show is true
      union all
      select
        'app'::text,
        c.user_id::text,
        (case when cov.covered then 0
          else coalesce(public._mws_price(s.id, c.user_id, null), 0)
        end)::numeric,
        coalesce(c.penalty_collected_ils, 0)::numeric
      from public.cancellations c
      join public.training_sessions s on s.id = c.session_id
      left join public.session_registrations reg2
        on reg2.session_id = c.session_id and reg2.user_id = c.user_id
      left join public.subscription_registration_coverage cov on cov.registration_id = reg2.id
      where s.session_date between v_start and v_end
        and c.charged_full_price is true
        and (v_is_super or not public.is_registration_hidden(c.session_id, c.user_id))
      union all
      -- Subscription charges (recurring/proration/correction/reversal rows) are additional
      -- debt-feed line items, attributed to the billing period they were posted for -- not
      -- smeared across weeks. Byte-identical semantics to _period_merged_athlete_finance's
      -- equivalent branch; the reversal convention (a `reversal` row carries a negative
      -- amount_ils referencing the charge it reverses via `reverses`) means a plain sum
      -- already nets to the corrected total with no double-count or extra filtering needed.
      -- Not subject to the hidden-registration filter: a subscription charge has no single
      -- session to hide, and hiding only ever applies to session-level registrations/cancellations.
      select
        case when sc.payee_is_manual then 'manual' else 'app' end::text,
        sc.payee_id::text,
        sc.amount_ils::numeric,
        0::numeric
      from public.subscription_charges sc
      join public.subscription_billing_periods bp on bp.id = sc.billing_period_id
      where bp.period_start between v_start and v_end
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
    -- "discount" account payments aren't real money received -- they reduce what was
    -- expected instead (see merged_ath below), mirroring computeBillingSummary on the
    -- client (src/lib/participantHistoryHelpers.ts). Split them out here so they never
    -- inflate collected_account_ils / collected_total_ils. Reversed payments (refunds /
    -- cancelled receipts) are excluded entirely -- the row is kept for audit (reversed_at
    -- set, never deleted) but is no longer real money collected, matching
    -- _period_merged_athlete_finance.
    acct_by_ath as (
      select
        case when a.payee_is_manual then 'manual' else 'app' end as kind,
        a.payee_id::text as pid,
        coalesce(sum(a.amount_ils) filter (
          where public.normalize_payment_method_key(a.payment_method) <> 'discount'
        ), 0)::numeric as collected_account_ils,
        coalesce(sum(a.amount_ils) filter (
          where public.normalize_payment_method_key(a.payment_method) = 'discount'
        ), 0)::numeric as discount_account_ils
      from public.athlete_account_payments a
      where a.paid_at between v_start and v_end
        and a.reversed_at is null
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
        -- Clamp at 0 rather than let expected go negative if a discount exceeds what
        -- was actually owed for the period.
        greatest(0, coalesce(s.expected_ils, 0) - coalesce(a.discount_account_ils, 0))::numeric as expected_ils,
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
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
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
        and (v_is_super or not public.is_registration_hidden(c.session_id, c.user_id))
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
    -- Day-level "collected" is meant to read as real cash flow -- exclude discounts
    -- here too so a discount recorded on a given day doesn't inflate that day's total.
    account_by_day as (
      select
        (a.paid_at::date) as day_date,
        round(sum(a.amount_ils) filter (
          where public.normalize_payment_method_key(a.payment_method) <> 'discount'
        )::numeric, 2) as account_ils
      from public.athlete_account_payments a
      where a.paid_at::date between v_start and v_end
        and a.reversed_at is null
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
        'subscription_charges_ils', d.charges_ils,
        'sessions', d.sessions_json
      )
      order by d.day_date
    ),
    '[]'::json
  )
  into v_expected_by_day
  from (
    with expected_slot_money as (
      select reg.session_id, (case when cov.covered then 0 else coalesce(public._mws_price(s.id, reg.user_id, null), 0) end)::numeric as exp_amt
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is true
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
      union all
      select m.session_id, (case when cov.covered then 0 else coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0) end)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
      where s.session_date between v_start and v_end
        and m.attended is true
      union all
      select reg.session_id, (case when cov.covered then 0 else coalesce(public._mws_price(s.id, reg.user_id, null), 0) end)::numeric
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is false
        and reg.charge_no_show is true
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
      union all
      select m.session_id, (case when cov.covered then 0 else coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0) end)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
      where s.session_date between v_start and v_end
        and m.attended is false
        and m.charge_no_show is true
      union all
      select c.session_id, (case when cov.covered then 0 else coalesce(public._mws_price(s.id, c.user_id, null), 0) end)::numeric
      from public.cancellations c
      join public.training_sessions s on s.id = c.session_id
      left join public.session_registrations reg2 on reg2.session_id = c.session_id and reg2.user_id = c.user_id
      left join public.subscription_registration_coverage cov on cov.registration_id = reg2.id
      where s.session_date between v_start and v_end
        and c.charged_full_price is true
        and (v_is_super or not public.is_registration_hidden(c.session_id, c.user_id))
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
    charges_by_day as (
      select bp.period_start as day_date, round(sum(sc.amount_ils)::numeric, 2) as charges_ils
      from public.subscription_charges sc
      join public.subscription_billing_periods bp on bp.id = sc.billing_period_id
      where bp.period_start between v_start and v_end
      group by 1
    ),
    exp_day_keys as (
      select distinct session_date as day_date from per_session_exp
      union
      select day_date from charges_by_day
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
    select ds.day_date, ds.sessions_json, ds.day_total + coalesce(cd.charges_ils, 0) as day_total, coalesce(cd.charges_ils, 0) as charges_ils
    from exp_day_sessions ds
    left join charges_by_day cd on cd.day_date = ds.day_date
    where ds.day_total + coalesce(cd.charges_ils, 0) <> 0
  ) d;

  -- Missing-attendance staff nudge list: intentionally unfiltered -- staff
  -- still need to mark attendance for hidden athletes normally.
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
$function$;
CREATE OR REPLACE FUNCTION public._period_merged_athlete_finance(p_start date, p_end date)
 RETURNS TABLE(kind text, pid text, expected_ils numeric, collected_sessions_ils numeric, collected_account_ils numeric, collected_total_ils numeric, outstanding_ils numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with per_slot as (
    select
      'app'::text as kind,
      reg.user_id::text as pid,
      (case when cov.covered then 0
        else coalesce(public._mws_price(s.id, reg.user_id, null), 0)
      end)::numeric as exp_amt,
      coalesce(reg.amount_paid, 0)::numeric as coll_amt
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
    where s.session_date between p_start and p_end
      and reg.status = 'active'
      and reg.attended is true
    union all
    select
      'manual'::text,
      m.manual_participant_id::text,
      (case when cov.covered then 0
        else coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0)
      end)::numeric,
      coalesce(m.amount_paid, 0)::numeric
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
    where s.session_date between p_start and p_end
      and m.attended is true
    union all
    select
      'app'::text,
      reg.user_id::text,
      (case when cov.covered then 0
        else coalesce(public._mws_price(s.id, reg.user_id, null), 0)
      end)::numeric,
      coalesce(reg.amount_paid, 0)::numeric
    from public.session_registrations reg
    join public.training_sessions s on s.id = reg.session_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg.id
    where s.session_date between p_start and p_end
      and reg.status = 'active'
      and reg.attended is false
      and reg.charge_no_show is true
    union all
    select
      'manual'::text,
      m.manual_participant_id::text,
      (case when cov.covered then 0
        else coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0)
      end)::numeric,
      coalesce(m.amount_paid, 0)::numeric
    from public.session_manual_participants m
    join public.training_sessions s on s.id = m.session_id
    left join public.subscription_registration_coverage cov on cov.manual_participant_id = m.id
    where s.session_date between p_start and p_end
      and m.attended is false
      and m.charge_no_show is true
    union all
    select
      'app'::text,
      c.user_id::text,
      (case when cov.covered then 0
        else coalesce(public._mws_price(s.id, c.user_id, null), 0)
      end)::numeric,
      coalesce(c.penalty_collected_ils, 0)::numeric
    from public.cancellations c
    join public.training_sessions s on s.id = c.session_id
    left join public.session_registrations reg2
      on reg2.session_id = c.session_id and reg2.user_id = c.user_id
    left join public.subscription_registration_coverage cov on cov.registration_id = reg2.id
    where s.session_date between p_start and p_end
      and c.charged_full_price is true
    union all
    -- Subscription charges are additional debt-feed line items (recurring/proration/etc.),
    -- attributed to the billing period they were posted for. No separate "collected" side here:
    -- payment against a subscription charge is recorded as an athlete_account_payments row
    -- (already summed in acct_by_ath below), matching the plan's "debt-feed line items only" rule.
    -- Filtered by bp.period_start (not session_date, since a charge has no single session) — a
    -- charge surfaces in whichever p_start/p_end range contains its billing period's start date,
    -- as one lump sum, not smeared across the period's weeks.
    -- Netting (Phase 3, not written yet by this migration): a `reversal` row is expected to carry
    -- a NEGATIVE amount_ils equal to `-1 * ` the charge it reverses (via `reverses`), so that
    -- summing all subscription_charges rows for a payee/period nets to the corrected total with
    -- no double-count — e.g. +300 recurring, -300 reversal, +150 stop_proration nets to +150.
    -- This convention is not enforced by a CHECK constraint here; Phase 3's writer must honor it.
    select
      case when sc.payee_is_manual then 'manual' else 'app' end::text,
      sc.payee_id::text,
      sc.amount_ils::numeric,
      0::numeric
    from public.subscription_charges sc
    join public.subscription_billing_periods bp on bp.id = sc.billing_period_id
    where bp.period_start between p_start and p_end
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
      round(coalesce(sum(a.amount_ils) filter (where public.normalize_payment_method_key(a.payment_method) <> 'discount'), 0)::numeric, 2) as collected_account_ils,
      round(coalesce(sum(a.amount_ils) filter (where public.normalize_payment_method_key(a.payment_method) = 'discount'), 0)::numeric, 2) as discount_account_ils
    from public.athlete_account_payments a
    where a.paid_at between p_start and p_end
      and a.reversed_at is null
    group by 1, 2
  ),
  ath_keys as (
    select kind, pid from sess_by_ath
    union
    select kind, pid from acct_by_ath
  )
  select
    k.kind,
    k.pid,
    -- A discount reduces what is expected; it is not money collected. Outstanding is unchanged by this.
    greatest(0, coalesce(s.expected_ils, 0) - coalesce(a.discount_account_ils, 0))::numeric as expected_ils,
    coalesce(s.collected_sessions_ils, 0)::numeric as collected_sessions_ils,
    coalesce(a.collected_account_ils, 0)::numeric as collected_account_ils,
    (coalesce(s.collected_sessions_ils, 0) + coalesce(a.collected_account_ils, 0))::numeric as collected_total_ils,
    round((
      coalesce(s.expected_ils, 0)
      - coalesce(a.discount_account_ils, 0)
      - coalesce(s.collected_sessions_ils, 0)
      - coalesce(a.collected_account_ils, 0)
    )::numeric, 2) as outstanding_ils
  from ath_keys k
  left join sess_by_ath s on s.kind = k.kind and s.pid = k.pid
  left join acct_by_ath a on a.kind = k.kind and a.pid = k.pid;
$function$;
CREATE OR REPLACE FUNCTION public._guard_receipted_account_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_becoming_reversed boolean;
begin
  if tg_op = 'DELETE' then
    if old.reversed_at is not null then
      raise exception 'account_payment_reversed_immutable'
        using errcode = 'P0001',
              detail = 'This payment has been reversed and is kept for historical auditability; it cannot be deleted. Record a new payment instead.';
    end if;
    -- A subscription payment is reversed, never hard-deleted, so a subscription's balance always has its history.
    if old.source_subscription_id is not null then
      raise exception 'subscription_payment_use_reversal'
        using errcode = 'P0001',
              detail = 'A payment recorded against a subscription cannot be deleted. Reverse it instead.';
    end if;
    if public._payment_has_any_document('account', old.id) then
      raise exception 'account_payment_has_receipt_history'
        using errcode = 'P0001',
              detail = 'A receipt has been issued for this payment at some point (even if later cancelled); it cannot be deleted. Cancel-and-correct or reverse it instead.';
    end if;
    return old;
  end if;

  -- tg_op = 'UPDATE' from here.
  if new.source_subscription_id is distinct from old.source_subscription_id then
    raise exception 'subscription_payment_link_immutable'
      using errcode = 'P0001',
            detail = 'A payment''s subscription link is set when it is recorded and cannot be edited.';
  end if;
  if old.reversed_at is not null then
    if (new.amount_ils, new.payment_method, new.paid_at, new.payee_id, new.payee_is_manual, new.payer_name, new.note, new.reversed_at, new.reversed_by)
        is distinct from
        (old.amount_ils, old.payment_method, old.paid_at, old.payee_id, old.payee_is_manual, old.payer_name, old.note, old.reversed_at, old.reversed_by) then
      raise exception 'account_payment_reversed_immutable'
        using errcode = 'P0001',
              detail = 'This payment has been reversed and can no longer be modified. Record a new payment instead.';
    end if;
    return new;  -- true no-op save on an already-reversed row still passes
  end if;

  v_becoming_reversed := old.reversed_at is null and new.reversed_at is not null;
  if v_becoming_reversed then
    if coalesce(current_setting('shira.allow_payment_reversal', true), '') <> 'on' then
      raise exception 'unauthorized_payment_reversal'
        using errcode = 'P0001',
              detail = 'A payment can only be reversed by cancelling its receipt (cancel_document with payment reversal).';
    end if;
    return new;
  end if;

  if new.reversed_by is distinct from old.reversed_by then
    -- reversed_at unchanged but reversed_by changed: not a real state, defensively refused the same way.
    raise exception 'unauthorized_payment_reversal'
      using errcode = 'P0001',
            detail = 'A payment can only be reversed by cancelling its receipt (cancel_document with payment reversal).';
  end if;

  if (new.amount_ils, new.payment_method, new.paid_at, new.payee_id, new.payee_is_manual, new.payer_name, new.note)
      is not distinct from
      (old.amount_ils, old.payment_method, old.paid_at, old.payee_id, old.payee_is_manual, old.payer_name, old.note) then
    return new;  -- no receipt-relevant field changed
  end if;
  if public._payment_has_active_document('account', old.id) then
    raise exception 'account_payment_locked_receipt_issued'
      using errcode = 'P0001',
            detail = 'A receipt has been issued for this account payment; it can no longer be modified or deleted. Cancel the receipt first if a correction is required.';
  end if;
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public._validate_athlete_account_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if new.source_subscription_id is not null and not exists (
    select 1 from public.subscriptions s
    where s.id = new.source_subscription_id and s.payee_id = new.payee_id and s.payee_is_manual = new.payee_is_manual
  ) then
    raise exception 'subscription_payment_wrong_payee' using errcode = 'P0001';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$function$;
CREATE OR REPLACE FUNCTION public.manager_reverse_account_payment(p_payment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_reason text := trim(coalesce(p_reason, ''));
  v_pay public.athlete_account_payments%rowtype;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_manager(v_uid) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if char_length(v_reason) < 3 then return jsonb_build_object('ok', false, 'error', 'reason_required'); end if;

  select * into v_pay from public.athlete_account_payments where id = p_payment_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_pay.reversed_at is not null then return jsonb_build_object('ok', false, 'error', 'already_reversed'); end if;
  if public._payment_has_any_document('account', v_pay.id) then
    return jsonb_build_object('ok', false, 'error', 'has_receipt_history');
  end if;

  -- The switch _guard_receipted_account_payment checks, local to this transaction and turned straight back off.
  perform set_config('shira.allow_payment_reversal', 'on', true);
  update public.athlete_account_payments
  set reversed_at = now(), reversed_by = v_uid
  where id = v_pay.id;
  perform set_config('shira.allow_payment_reversal', 'off', true);

  perform public._insert_activity_event(
    v_uid, 'account_payment_reversed', 'athlete_account_payment', v_pay.id::text,
    jsonb_build_object(
      'payee_id', v_pay.payee_id,
      'payee_is_manual', v_pay.payee_is_manual,
      'amount_ils', v_pay.amount_ils,
      'payment_method', v_pay.payment_method,
      'paid_at', v_pay.paid_at,
      'reason', v_reason
    )
  );

  return jsonb_build_object('ok', true);
end;
$function$;
CREATE OR REPLACE FUNCTION public.record_subscription_payment(p_subscription_id uuid, p_amount_ils numeric, p_payment_method text, p_payer_name text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_paid_at date DEFAULT NULL::date, p_client_request_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sub record;
  v_existing_id uuid;
  v_payment_id uuid;
  v_paid_at date;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  -- Idempotency fast path: a retry with the same token that already succeeded returns the
  -- existing payment rather than erroring or duplicating. Checked before the lock -- a pure read
  -- against a unique index, no race with delete_subscription to serialize against yet.
  if p_client_request_id is not null then
    select id into v_existing_id
    from public.athlete_account_payments
    where client_request_id = p_client_request_id;
    if found then
      return json_build_object('ok', true, 'payment_id', v_existing_id, 'duplicate', true);
    end if;
  end if;

  if p_subscription_id is null then
    return json_build_object('ok', false, 'error', 'invalid_subscription');
  end if;

  -- Same advisory lock delete_subscription takes, keyed by subscription id: whichever of the two
  -- calls commits first is authoritative for what the other observes once it proceeds past here.
  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select s.id, s.payee_id, s.payee_is_manual, s.deleted_at into v_sub
  from public.subscriptions s
  where s.id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;
  if v_sub.deleted_at is not null then
    return json_build_object('ok', false, 'error', 'subscription_deleted');
  end if;

  if p_amount_ils is null or p_amount_ils <= 0 then
    return json_build_object('ok', false, 'error', 'invalid_amount');
  end if;
  if p_payment_method is null or btrim(p_payment_method) = '' then
    return json_build_object('ok', false, 'error', 'invalid_payment_method');
  end if;

  v_paid_at := coalesce(p_paid_at, public._studio_today_date());

  if not public._subscription_payment_eligible(v_sub.id, v_paid_at) then
    return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
  end if;

  begin
    insert into public.athlete_account_payments (
      payee_id, payee_is_manual, amount_ils, payment_method, payer_name, note, paid_at,
      source_subscription_id, client_request_id
    ) values (
      v_sub.payee_id, v_sub.payee_is_manual, p_amount_ils, p_payment_method, p_payer_name, p_note, v_paid_at,
      v_sub.id, p_client_request_id
    )
    returning id into v_payment_id;
  exception when unique_violation then
    -- A concurrent retry with the same client_request_id raced us; converge on its row.
    select id into v_payment_id
    from public.athlete_account_payments
    where client_request_id = p_client_request_id;
    return json_build_object('ok', true, 'payment_id', v_payment_id, 'duplicate', true);
  end;

  return json_build_object('ok', true, 'payment_id', v_payment_id, 'duplicate', false);
end;
$function$;
CREATE OR REPLACE FUNCTION public.generate_due_subscription_charges()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := public._studio_today_date();
  r record;
  v_next_raw_start date;
  v_next_raw_end date;
  v_effective_start date;
  v_periods_touched int := 0;
  v_failed int := 0;
  v_res json;
  v_stranded_id uuid;
  v_stranded_version uuid;
  v_stranded_raw_start date;
  v_stranded_raw_end date;
  v_err_state text;
  v_err_msg text;
begin
  for r in
    select s.id as subscription_id, v.id as version_id, v.anchor_day, v.plan_start_date,
           v.stopped_effective_date, v.plan_end_date
    from public.subscriptions s
    join public.subscription_versions v
      on v.subscription_id = s.id and v.effective_to is null
    where s.deleted_at is null
      and v.plan_start_date <= v_today
  loop
    begin
      loop
        select bp.id, bp.version_id, bp.raw_period_start, bp.raw_period_end
        into v_stranded_id, v_stranded_version, v_stranded_raw_start, v_stranded_raw_end
        from public.subscription_billing_periods bp
        where bp.subscription_id = r.subscription_id
          and not exists (
            select 1 from public.subscription_charges c
            where c.billing_period_id = bp.id and c.charge_type in ('recurring', 'proration')
          )
        order by bp.raw_period_start asc
        limit 1;

        if v_stranded_id is not null then
          v_res := public.subscription_generate_or_correct_billing_period(
            r.subscription_id, v_stranded_version, v_stranded_raw_start, v_stranded_raw_end, null, null
          );
          if coalesce((v_res->>'ok')::boolean, false) then
            v_periods_touched := v_periods_touched + 1;
          else
            perform public._report_system_error(
              p_source := 'trusted',
              p_subsystem := 'subscriptions',
              p_operation := 'billing_period_correction',
              p_error_class := 'ok_false',
              p_message := coalesce(v_res->>'error', 'subscription_generate_or_correct_billing_period returned ok:false'),
              p_severity := 'error',
              p_entities := jsonb_build_object('subscription_id', r.subscription_id, 'billing_period_id', v_stranded_id),
              p_fingerprint_key := 'subscription_billing_correction_failed:' || r.subscription_id);
          end if;
          continue;
        end if;

        select nc.raw_start, nc.raw_end, nc.charge_date
        into v_next_raw_start, v_next_raw_end, v_effective_start
        from public._subscription_next_charge(r.subscription_id) nc;

        exit when not found;
        exit when v_effective_start > v_today;

        v_res := public.subscription_generate_or_correct_billing_period(
          r.subscription_id, r.version_id, v_next_raw_start, v_next_raw_end, null, null
        );
        if coalesce((v_res->>'ok')::boolean, false) then
          v_periods_touched := v_periods_touched + 1;
        else
          perform public._report_system_error(
            p_source := 'trusted',
            p_subsystem := 'subscriptions',
            p_operation := 'billing_period_correction',
            p_error_class := 'ok_false',
            p_message := coalesce(v_res->>'error', 'subscription_generate_or_correct_billing_period returned ok:false'),
            p_severity := 'error',
            p_entities := jsonb_build_object('subscription_id', r.subscription_id),
            p_fingerprint_key := 'subscription_billing_correction_failed:' || r.subscription_id);
        end if;
      end loop;
    exception
      when others then
        v_failed := v_failed + 1;
        get stacked diagnostics v_err_state = returned_sqlstate, v_err_msg = message_text;
        begin
          perform public._insert_activity_event(
            null, 'subscription_billing_failed', 'subscription', r.subscription_id::text,
            jsonb_build_object('sqlstate', v_err_state, 'error', left(v_err_msg, 500), 'run_date', v_today)
          );
        exception when others then
          null;
        end;
        perform public._report_system_error(
          p_source := 'trusted',
          p_subsystem := 'subscriptions',
          p_operation := 'billing_period_correction',
          p_error_class := 'exception',
          p_error_code := v_err_state,
          p_message := left(v_err_msg, 500),
          p_severity := 'error',
          p_entities := jsonb_build_object('subscription_id', r.subscription_id),
          p_fingerprint_key := 'subscription_billing_correction_failed:' || r.subscription_id);
    end;
  end loop;

  begin
    perform public._subscription_integrity_check();
  exception when others then
    null;  -- monitoring never affects billing
  end;

  return json_build_object('ok', true, 'periods_touched', v_periods_touched, 'subscriptions_failed', v_failed);
end;
$function$;
CREATE OR REPLACE FUNCTION public.manager_subscription_overview_stats(p_start date, p_end date)
 RETURNS json
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_active_count int;
  v_charges_total numeric;
  v_payments_total numeric;
  v_lifetime_charges numeric;
  v_lifetime_payments numeric;
  v_today date := public._studio_today_date();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    return json_build_object('ok', false, 'error', 'invalid_range');
  end if;

  -- Point-in-time count, not period-scoped: "how many subscriptions are active right now".
  select count(*) into v_active_count
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where s.deleted_at is null
    and public.subscription_version_display_status(v.id, public._studio_today_date()) in ('active', 'frozen');

  -- Every charge-ledger row attributed to a billing period starting within the requested
  -- range (the "expected" side) -- unfiltered by charge_type so a reversal/correction posted
  -- in the same window as its original charge nets to the true effect, not the gross amount.
  select coalesce(sum(c.amount_ils), 0) into v_charges_total
  from public.subscription_charges c
  join public.subscription_billing_periods bp on bp.id = c.billing_period_id
  where bp.period_start between p_start and p_end;

  -- Subscription-tagged payments recorded within the requested range (the "collected" side) --
  -- same reversed_at exclusion as every other consumer of this table.
  select coalesce(sum(a.amount_ils), 0) into v_payments_total
  from public.athlete_account_payments a
  where a.source_subscription_id is not null
    and a.reversed_at is null
    and a.paid_at between p_start and p_end;

  -- Lifetime outstanding across every subscription (not period-scoped): every charge-ledger
  -- row ever posted, net of reversals/corrections by the same unconditional-sum convention
  -- as above. May be negative (overpayment credit) -- reported as-is, matching the existing
  -- outstanding_ils convention.
  select coalesce(sum(c.amount_ils), 0) into v_lifetime_charges
  from public.subscription_charges c;

  select coalesce(sum(a.amount_ils), 0) into v_lifetime_payments
  from public.athlete_account_payments a
  where a.source_subscription_id is not null
    and a.reversed_at is null;

  return (
    jsonb_build_object(
      'ok', true,
      'active_subscriptions_count', v_active_count,
      'charges_total_ils', v_charges_total,
      'payments_total_ils', v_payments_total,
      'outstanding_ils', v_lifetime_charges - v_lifetime_payments
    ) || (
      with cur as (
        select s.id, s.deleted_at is null as live, v.id as version_id, v.monthly_price_ils,
               public.subscription_version_display_status(v.id, v_today) as status,
               public.subscription_effective_next_billing_date(s.id) as next_charge,
               public.subscription_effective_plan_end_date(v.id) as plan_end,
               coalesce((select sum(c.amount_ils) from public.subscription_charges c where c.subscription_id = s.id), 0)
               - coalesce((select sum(a.amount_ils) from public.athlete_account_payments a
                           where a.source_subscription_id = s.id and a.reversed_at is null), 0) as balance
        from public.subscriptions s
        left join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
      )
      select jsonb_build_object(
        'running_count', count(*) filter (where live and status = 'active'),
        'frozen_count', count(*) filter (where live and status = 'frozen'),
        'scheduled_count', count(*) filter (where live and status = 'scheduled'),
        'open_balance_ils', coalesce(sum(balance) filter (where balance > 0), 0),
        'open_balance_count', count(*) filter (where balance > 0),
        'credit_ils', coalesce(-sum(balance) filter (where balance < 0), 0),
        'charges_next_7d_count', count(*) filter (where live and next_charge between v_today and v_today + 7),
        'charges_next_7d_ils', coalesce(sum(monthly_price_ils) filter (where live and next_charge between v_today and v_today + 7), 0),
        'ending_next_14d_count', count(*) filter (where live and plan_end between v_today and v_today + 14 and status in ('active', 'frozen'))
      )
      from cur
    )
  )::json;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Aggregate weekly allowance. The per-person rows ARE _subscription_week_usage, so the total cannot disagree with what a
-- manager or athlete sees for one person. Grain is person + tier: the limit is per person, so a plan change inside a week
-- is never counted twice.
--   Used      = attended + charged penalties
--   Unmarked  = ended, attendance not recorded (occupies allowance, not reported as attendance)
--   Reserved  = upcoming
--   Remaining = max(limit - occupying, 0) per row
--   Over      = max(occupying - limit, 0) per row, shown as an alert, never hidden by clamping
--   Used + Unmarked + Reserved + Remaining = Available + Over
-- ---------------------------------------------------------------------------
create or replace function public.manager_subscription_week_utilization(p_week_start date)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := public._studio_today_date();
  v_week date;
  v_tiers public.subscription_tier[];
  v_rows jsonb;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_week_start is null then
    return json_build_object('ok', false, 'error', 'invalid_week');
  end if;
  v_week := p_week_start - extract(dow from p_week_start)::int;
  select array_agg(t order by t) into v_tiers from unnest(enum_range(null::public.subscription_tier)) t;

  select coalesce(jsonb_agg(jsonb_build_object(
      'payee_id', p.payee_id, 'payee_is_manual', p.payee_is_manual, 'payee_display_name', p.name,
      'subscription_id', p.subscription_id, 'tier', u->>'tier',
      'available', (u->>'effective_weekly_limit')::int,
      'occupied', (u->>'used')::int,
      'attended', (u->>'attended')::int, 'penalty', (u->>'penalty')::int,
      'unmarked', (u->>'unmarked')::int, 'reserved', (u->>'reserved')::int,
      'released', (u->>'released')::int, 'extra', (u->>'extra')::int,
      'remaining', greatest((u->>'effective_weekly_limit')::int - (u->>'used')::int, 0),
      'over', greatest((u->>'used')::int - (u->>'effective_weekly_limit')::int, 0)
    ) order by p.name), '[]'::jsonb)
  into v_rows
  from (
    select distinct on (s.payee_id, s.payee_is_manual)
      s.payee_id, s.payee_is_manual, s.id as subscription_id,
      coalesce(case when not s.payee_is_manual then pr.full_name else mp.full_name end, '(unknown)') as name
    from public.subscriptions s
    left join public.profiles pr on not s.payee_is_manual and pr.user_id = s.payee_id
    left join public.manual_participants mp on s.payee_is_manual and mp.id = s.payee_id
    where s.deleted_at is null
    order by s.payee_id, s.payee_is_manual, s.created_at desc
  ) p
  cross join lateral jsonb_array_elements(public._subscription_week_usage(null, p.payee_id, p.payee_is_manual, v_week, v_tiers)) u;

  return (
    select jsonb_build_object(
      'ok', true,
      'week_start', v_week,
      'week_end', v_week + 6,
      'mode', case when v_week + 6 < v_today then 'closed' when v_week > v_today then 'future' else 'current' end,
      'available', coalesce(sum((r->>'available')::int), 0),
      'used', coalesce(sum((r->>'attended')::int + (r->>'penalty')::int), 0),
      'attended', coalesce(sum((r->>'attended')::int), 0),
      'penalty', coalesce(sum((r->>'penalty')::int), 0),
      'unmarked', coalesce(sum((r->>'unmarked')::int), 0),
      'reserved', coalesce(sum((r->>'reserved')::int), 0),
      'remaining', coalesce(sum((r->>'remaining')::int), 0),
      'over_allocated', coalesce(sum((r->>'over')::int), 0),
      'released', coalesce(sum((r->>'released')::int), 0),
      'extra_regular_price', coalesce(sum((r->>'extra')::int), 0),
      'rows', v_rows
    )::json
    from jsonb_array_elements(v_rows) r
  );
end;
$$;

-- The Overview list also shows the next charge and the end date.
drop function if exists public.manager_subscription_overview_breakdown();
create function public.manager_subscription_overview_breakdown()
returns table (
  subscription_id uuid, payee_id uuid, payee_is_manual boolean, payee_display_name text, display_status text, is_deleted boolean,
  plan_start_date date, plan_end_date date, has_no_end_date boolean,
  charges_total_ils numeric, payments_total_ils numeric, outstanding_ils numeric,
  next_billing_date date, effective_plan_end_date date
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return;
  end if;

  return query
  select
    s.id,
    s.payee_id,
    s.payee_is_manual,
    coalesce(
      case when not s.payee_is_manual then p.full_name else mp.full_name end,
      '(unknown)'
    ),
    public.subscription_version_display_status(v.id, public._studio_today_date()),
    s.deleted_at is not null,
    v.plan_start_date,
    v.plan_end_date,
    v.has_no_end_date,
    coalesce(charges.total, 0),
    coalesce(payments.total, 0),
    coalesce(charges.total, 0) - coalesce(payments.total, 0),
    public.subscription_effective_next_billing_date(s.id),
    public.subscription_effective_plan_end_date(v.id)
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  left join public.profiles p on not s.payee_is_manual and p.user_id = s.payee_id
  left join public.manual_participants mp on s.payee_is_manual and mp.id = s.payee_id
  left join lateral (
    select sum(c.amount_ils) as total
    from public.subscription_charges c
    where c.subscription_id = s.id
  ) charges on true
  left join lateral (
    select sum(a.amount_ils) as total
    from public.athlete_account_payments a
    where a.source_subscription_id = s.id
      and a.reversed_at is null
  ) payments on true
  where s.deleted_at is null
     or coalesce(charges.total, 0) <> 0
     or coalesce(payments.total, 0) <> 0
  order by s.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges: signed-in clients only, internals closed.
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'create_subscription(uuid, boolean, numeric, date, date, smallint, jsonb, numeric, text, text, text, uuid)',
    'edit_subscription_version(uuid, date, numeric, date, boolean, jsonb, boolean)',
    'freeze_subscription(uuid, date, date, boolean)',
    'stop_subscription(uuid, date, boolean)',
    'delete_subscription(uuid)',
    'reactivate_subscription(uuid, date, date)',
    'record_subscription_payment(uuid, numeric, text, text, text, date, uuid)',
    'get_my_subscription()',
    'get_subscription_detail(uuid)',
    'get_subscription_weekly_usage(uuid, date)',
    'list_active_subscriptions()',
    'list_subscription_history()',
    'manager_subscription_overview_stats(date, date)',
    'manager_subscription_overview_breakdown()',
    'manager_subscription_week_utilization(date)',
    'subscription_payment_target(uuid, boolean, date)',
    'manager_weekly_stats(date, text)',
    'manager_weekly_stats_core(date, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;

  foreach f in array array[
    '_subscription_charges_append_only()',
    '_subscription_payment_eligible(uuid, date)',
    '_subscription_integrity_check()',
    'subscription_lock_key(uuid, boolean, date, public.subscription_tier)',
    'subscription_admin_lock_key(uuid)',
    'subscription_payee_create_lock_key(uuid, boolean)',
    'subscription_next_anchor_date(smallint, date)',
    'subscription_tier_for_capacity(integer)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

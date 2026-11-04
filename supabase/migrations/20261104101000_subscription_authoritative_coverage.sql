-- ONE authoritative definition of allowance state, dates and coverage. Everything that decides or reports coverage
-- reads these, so registration, reconciliation, usage, the athlete view and the Overview cannot disagree.
--
-- Owner decisions implemented here (2026-11-03):
--   * An unattended session without a penalty does not consume allowance.
--   * A charged late cancellation or a charged no-show does consume it (the existing policy: the slot is spent, and a
--     covered session owes nothing further).
--   * A subscription's new coverage logic never reaches back into history: an ended session with no coverage row stays
--     as it is, and a paid regular-price session is not repriced by a slot that frees up later.
--
-- This migration changes no row. A week's rows are only recalculated when an operation touches that week.

-- ---------------------------------------------------------------------------
-- 1. Slot state: what one registration means for the allowance.
-- ---------------------------------------------------------------------------
create or replace function public._subscription_slot_state(
  p_status public.registration_status,   -- null for a manual participant
  p_attended boolean,
  p_charge_no_show boolean,
  p_charged_cancellation boolean,
  p_session_ended boolean
)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_charged_cancellation, false) then 'penalty'
    when p_status is not null and p_status <> 'active' then 'cancelled'
    when p_attended is true then 'attended'
    when p_attended is false and coalesce(p_charge_no_show, false) then 'penalty'
    when p_attended is false then 'released'
    when coalesce(p_session_ended, false) then 'unmarked'
    else 'reserved'
  end;
$$;

comment on function public._subscription_slot_state(public.registration_status, boolean, boolean, boolean, boolean) is
  'attended | penalty | unmarked | reserved all occupy allowance; released and cancelled do not.';

-- Every coverage row of a week with its state, on non-deleted subscriptions, counted per person.
create or replace function public._subscription_week_slots(
  p_week_start date,
  p_payee_id uuid default null,
  p_payee_is_manual boolean default null
)
returns table (
  coverage_id uuid, subscription_id uuid, payee_id uuid, payee_is_manual boolean, tier public.subscription_tier,
  session_id uuid, session_date date, covered boolean, non_coverage_reason public.subscription_non_coverage_reason,
  slot_state text, occupies boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.id, c.subscription_id, s.payee_id, s.payee_is_manual, c.tier,
    ts.id, ts.session_date, c.covered, c.non_coverage_reason,
    st.state,
    st.state in ('attended', 'penalty', 'unmarked', 'reserved')
  from public.subscription_registration_coverage c
  join public.subscriptions s on s.id = c.subscription_id and s.deleted_at is null
  left join public.session_registrations r on r.id = c.registration_id
  left join public.session_manual_participants m on m.id = c.manual_participant_id
  join public.training_sessions ts on ts.id = coalesce(r.session_id, m.session_id)
  cross join lateral (
    select public._subscription_slot_state(
      r.status,
      coalesce(r.attended, m.attended),
      coalesce(r.charge_no_show, m.charge_no_show),
      r.id is not null and exists (
        select 1 from public.cancellations x
        where x.session_id = r.session_id and x.user_id = r.user_id and x.charged_full_price is true
      ),
      public._session_has_ended(ts)
    ) as state
  ) st
  where c.week_start = p_week_start
    and (p_payee_id is null or (s.payee_id = p_payee_id and s.payee_is_manual = p_payee_is_manual));
$$;

-- ---------------------------------------------------------------------------
-- 2. Freeze date shift: one rule for period dates, next charge and the plan end.
-- ---------------------------------------------------------------------------
-- A raw calendar date moves forward by every active freeze that starts on or before the moved date. Iterated, because a
-- moved date can reach a later freeze. A freeze starting inside a billing cycle extends that cycle's END only; it no
-- longer delays the charge at the cycle's start, and consecutive cycles stay contiguous.
create or replace function public.subscription_shifted_date(p_subscription_id uuid, p_raw_date date)
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_current date := p_raw_date;
  v_next date;
begin
  if p_raw_date is null then
    return null;
  end if;
  loop
    select p_raw_date + coalesce(sum(f.freeze_until - f.freeze_from + 1), 0)::int into v_next
    from public.subscription_freezes f
    where f.subscription_id = p_subscription_id
      and f.cancelled_at is null
      and f.freeze_from <= v_current;
    exit when v_next = v_current;
    v_current := v_next;
  end loop;
  return v_current;
end;
$$;

create or replace function public.subscription_effective_plan_end_date(p_version_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select public.subscription_shifted_date(v.subscription_id, v.plan_end_date)
  from public.subscription_versions v
  where v.id = p_version_id;
$$;

-- ---------------------------------------------------------------------------
-- 3. Effective context and status honour the extended end date.
-- ---------------------------------------------------------------------------
create or replace function public.subscription_effective_context(
  p_payee_id uuid, p_payee_is_manual boolean, p_session_date date, p_tier public.subscription_tier
)
returns public.subscription_effective_context_result
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub_id uuid;
  v_version_id uuid;
  v_frozen boolean := false;
  v_limit int;
  v_result public.subscription_effective_context_result;
begin
  select s.id, v.id
  into v_sub_id, v_version_id
  from public.subscriptions s
  join public.subscription_versions v
    on v.subscription_id = s.id
   and v.effective_from <= p_session_date
   and (v.effective_to is null or v.effective_to > p_session_date)
  where s.payee_id = p_payee_id
    and s.payee_is_manual = p_payee_is_manual
    and s.deleted_at is null
    and v.plan_start_date <= p_session_date
    and (v.plan_end_date is null or public.subscription_shifted_date(s.id, v.plan_end_date) >= p_session_date)
    and (v.stopped_effective_date is null or v.stopped_effective_date > p_session_date)
  order by v.effective_from desc
  limit 1;

  v_result.subscription_id := v_sub_id;
  v_result.version_id := v_version_id;
  v_result.in_window := v_sub_id is not null;

  if v_sub_id is not null then
    v_frozen := exists (
      select 1
      from public.subscription_freezes f
      where f.subscription_id = v_sub_id
        and f.cancelled_at is null
        and p_session_date between f.freeze_from and f.freeze_until
    );

    select a.weekly_limit into v_limit
    from public.subscription_version_allowances a
    where a.version_id = v_version_id and a.tier = p_tier;
  end if;

  v_result.is_frozen := v_frozen;
  v_result.weekly_limit := v_limit;
  return v_result;
end;
$$;

create or replace function public.subscription_version_display_status(p_version_id uuid, p_as_of_date date default current_date)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.subscription_versions%rowtype;
begin
  select * into v from public.subscription_versions where id = p_version_id;
  if not found then
    return null;
  end if;

  if v.stopped_effective_date is not null and p_as_of_date >= v.stopped_effective_date then
    return 'stopped';
  end if;

  if v.effective_to is not null and p_as_of_date >= v.effective_to then
    return 'superseded';
  end if;

  if p_as_of_date < v.effective_from then
    return 'scheduled';
  end if;

  if v.plan_end_date is not null and p_as_of_date > public.subscription_shifted_date(v.subscription_id, v.plan_end_date) then
    return 'completed';
  end if;

  if exists (
    select 1 from public.subscription_freezes f
    where f.subscription_id = v.subscription_id
      and f.cancelled_at is null
      and p_as_of_date between f.freeze_from and f.freeze_until
  ) then
    return 'frozen';
  end if;

  return 'active';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The next charge: the cron job and every "next billing" label share it.
-- ---------------------------------------------------------------------------
create or replace function public._subscription_next_charge(p_subscription_id uuid)
returns table (raw_start date, raw_end date, charge_date date)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.subscription_versions%rowtype;
  v_last_raw date;
  v_raw_start date;
  v_charge date;
begin
  select cv.* into v
  from public.subscription_versions cv
  join public.subscriptions s on s.id = cv.subscription_id
  where cv.subscription_id = p_subscription_id and cv.effective_to is null and s.deleted_at is null;
  if not found then
    return;
  end if;

  select max(bp.raw_period_start) into v_last_raw
  from public.subscription_billing_periods bp
  where bp.subscription_id = p_subscription_id;

  v_raw_start := case when v_last_raw is null then v.plan_start_date
                      else public.subscription_next_anchor_date(v.anchor_day, v_last_raw) end;
  v_charge := public.subscription_shifted_date(p_subscription_id, v_raw_start);

  if v.stopped_effective_date is not null and v_charge >= v.stopped_effective_date then
    return;
  end if;
  if v.plan_end_date is not null and v_charge > public.subscription_shifted_date(p_subscription_id, v.plan_end_date) then
    return;
  end if;

  raw_start := v_raw_start;
  raw_end := public.subscription_next_anchor_date(v.anchor_day, v_raw_start);
  charge_date := v_charge;
  return next;
end;
$$;

-- NULL means no further charge is scheduled. A subscription that has not started shows its first charge, on its start date.
create or replace function public.subscription_effective_next_billing_date(p_subscription_id uuid)
returns date
language sql
stable
security definer
set search_path = public
as $$
  select nc.charge_date from public._subscription_next_charge(p_subscription_id) nc;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reconcile: the same effective limit and live set as registration, across all of a person's subscriptions that week.
-- ---------------------------------------------------------------------------
create or replace function public.subscription_reconcile_week(
  p_subscription_id uuid,
  p_week_start date,
  p_tier public.subscription_tier
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_limit int;
  v_covered_count int := 0;
  v_ctx public.subscription_effective_context_result;
  v_covered boolean;
  v_reason public.subscription_non_coverage_reason;
  r record;
begin
  select payee_id, payee_is_manual into v_payee_id, v_payee_is_manual
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return;
  end if;

  perform pg_advisory_xact_lock(public.subscription_lock_key(v_payee_id, v_payee_is_manual, p_week_start, p_tier));

  v_limit := public.subscription_effective_weekly_limit(v_payee_id, v_payee_is_manual, p_tier, p_week_start);

  for r in
    select g.*, ts.session_date, public._session_has_ended(ts) as ended,
           cov.id as coverage_id, cov.subscription_id as was_subscription_id, cov.covered as was_covered, cov.non_coverage_reason as was_reason,
           public._subscription_slot_state(g.status, g.attended, g.charge_no_show, g.charged_cancellation, public._session_has_ended(ts)) as state
    from (
      select reg.id as registration_id, null::uuid as manual_row_id, reg.session_id, reg.registered_at as created_at,
             reg.status, reg.attended, reg.charge_no_show,
             exists (select 1 from public.cancellations c
                     where c.session_id = reg.session_id and c.user_id = reg.user_id and c.charged_full_price is true) as charged_cancellation,
             coalesce(reg.amount_paid, 0) + coalesce((select c.penalty_collected_ils from public.cancellations c
                     where c.session_id = reg.session_id and c.user_id = reg.user_id), 0) as collected
      from public.session_registrations reg
      where not v_payee_is_manual and reg.user_id = v_payee_id
      union all
      select null, m.id, m.session_id, m.added_at, null, m.attended, m.charge_no_show, false, coalesce(m.amount_paid, 0)
      from public.session_manual_participants m
      where v_payee_is_manual and m.manual_participant_id = v_payee_id
    ) g
    join public.training_sessions ts on ts.id = g.session_id
    left join public.subscription_registration_coverage cov
      on cov.registration_id = g.registration_id or cov.manual_participant_id = g.manual_row_id
    where ts.session_date between p_week_start and p_week_start + 6
      and public.subscription_tier_for_capacity(ts.max_participants) = p_tier
    order by g.created_at asc, coalesce(g.registration_id, g.manual_row_id) asc
  loop
    -- A cancelled booking holds nothing and is left as recorded.
    continue when r.state = 'cancelled';
    -- History stays as it is: coverage is never created for a session that already ended.
    continue when r.coverage_id is null and r.ended;

    v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);

    if r.was_reason = 'subscription_deleted' and (r.ended or v_ctx.subscription_id is null) then
      -- Deleting a subscription moved this session to regular price; attendance edits must not undo that.
      v_covered := false;
      v_reason := 'subscription_deleted';
    elsif r.state = 'released' then
      v_covered := false;
      v_reason := 'no_show_released';
    elsif r.was_covered and r.ended and exists (
      select 1 from public.subscription_versions sv
      where sv.subscription_id = r.was_subscription_id and sv.stopped_effective_date = r.session_date
    ) then
      -- A session on the stop date that had already taken place stays as it was.
      v_covered := true;
      v_reason := null;
      v_covered_count := v_covered_count + 1;
    elsif v_ctx.subscription_id is null or not v_ctx.in_window then
      v_covered := false;
      v_reason := case when r.was_reason = 'subscription_ended' then 'subscription_ended'::public.subscription_non_coverage_reason
                       else 'not_subscribed'::public.subscription_non_coverage_reason end;
    elsif v_ctx.is_frozen then
      v_covered := false;
      v_reason := 'frozen';
    elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
      v_covered := false;
      v_reason := 'tier_not_included';
    elsif v_covered_count >= v_limit then
      v_covered := false;
      v_reason := 'allowance_exceeded';
    elsif coalesce(r.was_covered, false) is false and r.collected > 0 then
      -- Money was already taken for this session at the regular price. A slot freeing up later must not silently turn
      -- that into an unexplained credit.
      v_covered := false;
      v_reason := 'paid_at_regular_price';
    else
      v_covered := true;
      v_reason := null;
      v_covered_count := v_covered_count + 1;
    end if;

    if r.registration_id is not null then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        coalesce(v_ctx.subscription_id, p_subscription_id), v_ctx.version_id, r.registration_id, null,
        r.session_date, p_week_start, p_tier,
        v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (registration_id) where registration_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where (public.subscription_registration_coverage.subscription_id, public.subscription_registration_coverage.version_id,
             public.subscription_registration_coverage.session_date, public.subscription_registration_coverage.week_start,
             public.subscription_registration_coverage.tier, public.subscription_registration_coverage.covered,
             public.subscription_registration_coverage.non_coverage_reason)
        is distinct from
            (excluded.subscription_id, excluded.version_id, excluded.session_date, excluded.week_start, excluded.tier,
             excluded.covered, excluded.non_coverage_reason);
    else
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        coalesce(v_ctx.subscription_id, p_subscription_id), v_ctx.version_id, null, r.manual_row_id,
        r.session_date, p_week_start, p_tier,
        v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where (public.subscription_registration_coverage.subscription_id, public.subscription_registration_coverage.version_id,
             public.subscription_registration_coverage.session_date, public.subscription_registration_coverage.week_start,
             public.subscription_registration_coverage.tier, public.subscription_registration_coverage.covered,
             public.subscription_registration_coverage.non_coverage_reason)
        is distinct from
            (excluded.subscription_id, excluded.version_id, excluded.session_date, excluded.week_start, excluded.tier,
             excluded.covered, excluded.non_coverage_reason);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Registration counts the same occupied slots, per person.
-- ---------------------------------------------------------------------------
create or replace function public.subscription_reserve_or_reject(
  p_payee_id uuid, p_payee_is_manual boolean, p_session_id uuid, p_accept_extra boolean default false
)
returns public.subscription_reserve_decision
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess public.training_sessions%rowtype;
  v_tier public.subscription_tier;
  v_week_start date;
  v_ctx public.subscription_effective_context_result;
  v_lock_key bigint;
  v_covered_count int;
  v_effective_limit int;
  v_result public.subscription_reserve_decision;
begin
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    raise exception 'session_not_found';
  end if;

  v_tier := public.subscription_tier_for_capacity(v_sess.max_participants);
  v_week_start := v_sess.session_date - extract(dow from v_sess.session_date)::int;

  -- Server side of the mandatory subscription-terms screen: an athlete who must accept the terms cannot register
  -- THEMSELVES (bypassing the screen through the API). Staff additions, cron roster copies, coverage and billing are
  -- unaffected - terms acceptance controls app access, never the subscription's financial lifecycle.
  if not p_payee_is_manual and auth.uid() is not null and auth.uid() = p_payee_id
     and public._subscription_terms_required_for_user(p_payee_id) then
    raise exception 'subscription_terms_required'
      using errcode = 'P0001', hint = 'Accept the subscription terms in the app first.';
  end if;

  v_lock_key := public.subscription_lock_key(p_payee_id, p_payee_is_manual, v_week_start, v_tier);
  perform pg_advisory_xact_lock(v_lock_key);

  v_ctx := public.subscription_effective_context(p_payee_id, p_payee_is_manual, v_sess.session_date, v_tier);

  v_result.tier := v_tier;
  v_result.week_start := v_week_start;

  if v_ctx.subscription_id is null or not v_ctx.in_window then
    v_result.outcome := 'not_subscribed';
    v_result.ok := true;
    v_result.subscription_id := null;
    v_result.version_id := null;
    v_result.covered := null;
    v_result.non_coverage_reason := null;
    return v_result;
  end if;

  v_result.subscription_id := v_ctx.subscription_id;
  v_result.version_id := v_ctx.version_id;

  if v_ctx.is_frozen then
    -- Session-date freeze eligibility is unchanged: a session ON a frozen date is never covered,
    -- regardless of the week's effective allowance.
    v_result.outcome := 'frozen';
    v_result.non_coverage_reason := 'frozen';
  elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
    v_result.outcome := 'tier_not_included';
    v_result.non_coverage_reason := 'tier_not_included';
  else
    v_effective_limit := public.subscription_effective_weekly_limit(p_payee_id, p_payee_is_manual, v_tier, v_week_start);

    select count(*) into v_covered_count
    from public._subscription_week_slots(v_week_start, p_payee_id, p_payee_is_manual) sl
    where sl.tier = v_tier and sl.covered and sl.occupies;

    if v_covered_count < v_effective_limit then
      v_result.outcome := 'covered';
      v_result.non_coverage_reason := null;
    else
      v_result.outcome := 'allowance_exceeded';
      v_result.non_coverage_reason := 'allowance_exceeded';
    end if;
  end if;

  if v_result.outcome = 'covered' then
    v_result.covered := true;
    v_result.ok := true;
  else
    v_result.covered := false;
    v_result.ok := coalesce(p_accept_extra, false);
  end if;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Weekly usage, read by the athlete view, the manager's detail screen and the Overview's reconciliation test.
--    Counted per person, like the limit it is compared with. p_subscription_id is kept for its callers.
-- ---------------------------------------------------------------------------
-- What the week allowed for one session, leaving out changes that take effect after it: days up to the session count as they
-- were, later days count as eligible. A change effective on or before the session is part of the answer.
create or replace function public._subscription_session_entitlement(
  p_payee_id uuid, p_payee_is_manual boolean, p_tier public.subscription_tier, p_week_start date, p_session_date date
)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ctx public.subscription_effective_context_result;
  v_day public.subscription_effective_context_result;
  v_limit int;
  v_eligible int := 0;
  d date;
begin
  v_ctx := public.subscription_effective_context(p_payee_id, p_payee_is_manual, p_session_date, p_tier);
  v_limit := coalesce(v_ctx.weekly_limit, 0);
  if v_ctx.subscription_id is null or not v_ctx.in_window or v_limit <= 0 then
    return 0;
  end if;
  for d in select generate_series(p_week_start, p_week_start + 5, interval '1 day')::date loop
    if d > p_session_date then
      v_eligible := v_eligible + 1;
    else
      v_day := public.subscription_effective_context(p_payee_id, p_payee_is_manual, d, p_tier);
      if v_day.in_window and not v_day.is_frozen then
        v_eligible := v_eligible + 1;
      end if;
    end if;
  end loop;
  return ceil(v_limit * v_eligible / 6.0)::int;
end;
$$;

-- The allowance to report for a week: the effective limit, or more when completed sessions keep coverage they validly held
-- before a later change reduced it. Bookings are always checked against the effective limit itself.
create or replace function public._subscription_week_reported_limit(
  p_payee_id uuid, p_payee_is_manual boolean, p_tier public.subscription_tier, p_week_start date
)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    public.subscription_effective_weekly_limit(p_payee_id, p_payee_is_manual, p_tier, p_week_start),
    coalesce((
      select least(count(*)::int, public._subscription_session_entitlement(p_payee_id, p_payee_is_manual, p_tier, p_week_start, min(sl.session_date)))
      from public._subscription_week_slots(p_week_start, p_payee_id, p_payee_is_manual) sl
      where sl.tier = p_tier and sl.covered and sl.slot_state in ('attended', 'penalty', 'unmarked')
      having count(*) > 0
    ), 0)
  );
$$;

create or replace function public._subscription_week_usage(
  p_subscription_id uuid, p_payee_id uuid, p_payee_is_manual boolean, p_week_start date, p_tiers public.subscription_tier[]
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with counted as (
    select * from public._subscription_week_slots(p_week_start, p_payee_id, p_payee_is_manual)
  ),
  rows as (
    select
      t.tier,
      coalesce((
        select max(ctx.weekly_limit)
        from generate_series(p_week_start, p_week_start + 5, interval '1 day') d,
             lateral public.subscription_effective_context(p_payee_id, p_payee_is_manual, d::date, t.tier) ctx
        where ctx.in_window
      ), 0) as configured_weekly_limit,
      public._subscription_week_reported_limit(p_payee_id, p_payee_is_manual, t.tier, p_week_start) as effective_weekly_limit,
      (select count(*) from counted c where c.tier = t.tier and c.covered and c.occupies) as used,
      (select count(*) from counted c where c.tier = t.tier and c.covered and c.slot_state = 'attended') as attended,
      (select count(*) from counted c where c.tier = t.tier and c.covered and c.slot_state = 'penalty') as penalty,
      (select count(*) from counted c where c.tier = t.tier and c.covered and c.slot_state = 'unmarked') as unmarked,
      (select count(*) from counted c where c.tier = t.tier and c.covered and c.slot_state = 'reserved') as reserved,
      (select count(*) from counted c where c.tier = t.tier and c.slot_state = 'released') as released,
      (select count(*) from counted c where c.tier = t.tier and not c.covered and c.occupies
         and c.non_coverage_reason in ('allowance_exceeded', 'frozen', 'tier_not_included', 'paid_at_regular_price')) as extra,
      t.ord
    from unnest(p_tiers) with ordinality as t(tier, ord)
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', r.tier,
      'configured_weekly_limit', r.configured_weekly_limit,
      'effective_weekly_limit', r.effective_weekly_limit,
      'used', r.used,
      'attended', r.attended,
      'penalty', r.penalty,
      'unmarked', r.unmarked,
      'reserved', r.reserved,
      'released', r.released,
      'extra', r.extra
    ) order by r.ord
  ), '[]'::jsonb)
  from rows r
  where r.configured_weekly_limit > 0 or r.effective_weekly_limit > 0 or r.used > 0 or r.extra > 0 or r.released > 0;
$$;

-- ---------------------------------------------------------------------------
-- 8. Existing future bookings are evaluated when a subscription begins (owner decision). Sessions that already ended are
--    untouched: subscription_reconcile_week does not create coverage for them.
-- ---------------------------------------------------------------------------
create or replace function public._subscription_cover_existing_future_registrations(p_subscription_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payee uuid;
  v_manual boolean;
  v_count int;
  r record;
begin
  select payee_id, payee_is_manual into v_payee, v_manual from public.subscriptions where id = p_subscription_id;

  for r in
    select distinct ts.session_date - extract(dow from ts.session_date)::int as week_start,
           public.subscription_tier_for_capacity(ts.max_participants) as tier
    from public.training_sessions ts
    where not public._session_has_ended(ts)
      and (
        (not v_manual and exists (select 1 from public.session_registrations reg where reg.session_id = ts.id and reg.user_id = v_payee and reg.status = 'active'))
        or (v_manual and exists (select 1 from public.session_manual_participants m where m.session_id = ts.id and m.manual_participant_id = v_payee))
      )
  loop
    perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
  end loop;

  select count(*) into v_count from public.subscription_registration_coverage c
  where c.subscription_id = p_subscription_id and c.covered;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Triggers: a freed slot and a moved session take effect immediately.
-- ---------------------------------------------------------------------------
create or replace function public._subscription_reconcile_after_coverage_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.covered then
    perform public.subscription_reconcile_week(old.subscription_id, old.week_start, old.tier);
  end if;
  return old;
end;
$$;

drop trigger if exists subscription_reconcile_on_coverage_delete on public.subscription_registration_coverage;
create trigger subscription_reconcile_on_coverage_delete
  after delete on public.subscription_registration_coverage
  for each row execute function public._subscription_reconcile_after_coverage_delete();

create or replace function public._subscription_reconcile_after_session_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_week date := new.session_date - extract(dow from new.session_date)::int;
  v_new_tier public.subscription_tier := public.subscription_tier_for_capacity(new.max_participants);
  r record;
begin
  if new.session_date is not distinct from old.session_date
     and v_new_tier is not distinct from public.subscription_tier_for_capacity(old.max_participants) then
    return new;
  end if;

  for r in
    select distinct c.subscription_id, c.week_start, c.tier
    from public.subscription_registration_coverage c
    left join public.session_registrations reg on reg.id = c.registration_id
    left join public.session_manual_participants m on m.id = c.manual_participant_id
    where coalesce(reg.session_id, m.session_id) = new.id
  loop
    update public.subscription_registration_coverage c
    set session_date = new.session_date, week_start = v_new_week, tier = v_new_tier
    where c.subscription_id = r.subscription_id
      and (c.registration_id in (select reg.id from public.session_registrations reg where reg.session_id = new.id)
           or c.manual_participant_id in (select m.id from public.session_manual_participants m where m.session_id = new.id));
    perform public.subscription_reconcile_week(r.subscription_id, v_new_week, v_new_tier);
    perform public.subscription_reconcile_week(r.subscription_id, r.week_start, r.tier);
  end loop;
  return new;
end;
$$;

drop trigger if exists subscription_reconcile_on_session_change on public.training_sessions;
create trigger subscription_reconcile_on_session_change
  after update of session_date, max_participants on public.training_sessions
  for each row execute function public._subscription_reconcile_after_session_change();

-- ---------------------------------------------------------------------------
-- Billing: shared next-charge rule, contiguous cycles, extended end date.
-- ---------------------------------------------------------------------------
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

  return json_build_object('ok', true, 'periods_touched', v_periods_touched, 'subscriptions_failed', v_failed);
end;
$function$;
CREATE OR REPLACE FUNCTION public.subscription_generate_or_correct_billing_period(p_subscription_id uuid, p_version_id uuid, p_raw_period_start date, p_raw_period_end date, p_source_event_id uuid DEFAULT NULL::uuid, p_correction_charge_type subscription_charge_type DEFAULT NULL::subscription_charge_type)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_bp_id uuid;
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_frozen_days int;
  v_period_start date;
  v_period_end date;
  v_amount record;
  v_new_amount numeric(12, 2);
  v_new_type public.subscription_charge_type;
  v_existing public.subscription_charges%rowtype;
begin
  if not exists (
    select 1 from public.subscription_versions where id = p_version_id and subscription_id = p_subscription_id
  ) then
    if not exists (select 1 from public.subscription_versions where id = p_version_id) then
      return json_build_object('ok', false, 'error', 'version_not_found');
    end if;
    return json_build_object('ok', false, 'error', 'version_subscription_mismatch');
  end if;

  select payee_id, payee_is_manual into v_payee_id, v_payee_is_manual
  from public.subscriptions
  where id = p_subscription_id;
  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  v_period_start := public.subscription_shifted_date(p_subscription_id, p_raw_period_start);
  v_period_end := public.subscription_shifted_date(p_subscription_id, p_raw_period_end);
  v_frozen_days := v_period_end - p_raw_period_end;

  insert into public.subscription_billing_periods (
    subscription_id, version_id, period_start, period_end,
    raw_period_start, raw_period_end, frozen_days_applied
  )
  values (
    p_subscription_id, p_version_id, v_period_start, v_period_end,
    p_raw_period_start, p_raw_period_end, v_frozen_days
  )
  on conflict (subscription_id, raw_period_start) do nothing
  returning id into v_bp_id;

  if v_bp_id is null then
    select id into v_bp_id
    from public.subscription_billing_periods
    where subscription_id = p_subscription_id and raw_period_start = p_raw_period_start;
  end if;

  -- Keep the row's version_id, and its effective dates/frozen_days_applied, current -- a freeze
  -- created after this period already existed must immediately shift it (period_start/period_end
  -- are scheduling metadata, safe to update in place; the financial ledger rows are the only thing
  -- this function ever treats as immutable-except-via-reversal).
  update public.subscription_billing_periods
  set version_id = p_version_id,
      period_start = v_period_start,
      period_end = v_period_end,
      frozen_days_applied = v_frozen_days
  where id = v_bp_id
    and (
      version_id is distinct from p_version_id
      or period_start is distinct from v_period_start
      or period_end is distinct from v_period_end
      or frozen_days_applied is distinct from v_frozen_days
    );

  select * into v_amount
  from public.subscription_billing_period_amount(p_subscription_id, v_period_start, v_period_end);
  v_new_amount := v_amount.amount_ils;

  select c.* into v_existing
  from public.subscription_charges c
  where c.billing_period_id = v_bp_id
    and c.charge_type <> 'reversal'
    and not exists (
      select 1 from public.subscription_charges rv
      where rv.charge_type = 'reversal' and rv.reverses = c.id
    )
  order by c.created_at desc, c.id desc
  limit 1;

  if not found then
    v_new_type := case when v_amount.is_full_recurring
                        then 'recurring'::public.subscription_charge_type
                        else 'proration'::public.subscription_charge_type
                   end;
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, source_event_id
    ) values (
      v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual, v_new_amount, v_new_type, null
    );
    return json_build_object(
      'ok', true, 'billing_period_id', v_bp_id, 'action', 'created',
      'amount_ils', v_new_amount, 'charge_type', v_new_type,
      'period_start', v_period_start, 'period_end', v_period_end
    );
  end if;

  if v_existing.amount_ils = v_new_amount then
    return json_build_object(
      'ok', true, 'billing_period_id', v_bp_id, 'action', 'unchanged', 'amount_ils', v_existing.amount_ils,
      'period_start', v_period_start, 'period_end', v_period_end
    );
  end if;

  if p_correction_charge_type is null then
    return json_build_object('ok', false, 'error', 'correction_charge_type_required');
  end if;

  -- Idempotency is per (action, billing period): one action (a stop, freeze or edit) may have to correct SEVERAL
  -- periods, each exactly once. (Previously ANY reversal for the action short-circuited every other period.)
  if p_source_event_id is not null and exists (
    select 1 from public.subscription_charges
    where source_event_id = p_source_event_id and charge_type = 'reversal' and billing_period_id = v_bp_id
  ) then
    return json_build_object('ok', true, 'billing_period_id', v_bp_id, 'action', 'already_corrected');
  end if;

  insert into public.subscription_charges (
    billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses, source_event_id
  ) values (
    v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual,
    -v_existing.amount_ils, 'reversal', v_existing.id, p_source_event_id
  );

  insert into public.subscription_charges (
    billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, source_event_id
  ) values (
    v_bp_id, p_subscription_id, v_payee_id, v_payee_is_manual,
    v_new_amount, p_correction_charge_type, p_source_event_id
  );

  return json_build_object(
    'ok', true, 'billing_period_id', v_bp_id, 'action', 'corrected',
    'amount_ils', v_new_amount, 'charge_type', p_correction_charge_type,
    'reversed_ils', v_existing.amount_ils,
    'period_start', v_period_start, 'period_end', v_period_end
  );
exception
  when unique_violation then
    return json_build_object('ok', true, 'action', 'concurrent_noop');
end;
$function$;
CREATE OR REPLACE FUNCTION public.subscription_billing_period_segments(p_subscription_id uuid, p_period_start date, p_period_end date)
 RETURNS TABLE(segment_start date, segment_end date, version_id uuid, monthly_price_ils numeric, is_billable boolean, is_frozen boolean, segment_days integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with boundary_points as (
    select p_period_start as d
    union
    select p_period_end
    union
    select v.effective_from
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.effective_from > p_period_start and v.effective_from < p_period_end
    union
    select v.effective_to
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.effective_to is not null
      and v.effective_to > p_period_start and v.effective_to < p_period_end
    union
    select v.plan_start_date
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.plan_start_date > p_period_start and v.plan_start_date < p_period_end
    union
    select public.subscription_shifted_date(p_subscription_id, v.plan_end_date) + 1
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.plan_end_date is not null
      and public.subscription_shifted_date(p_subscription_id, v.plan_end_date) + 1 > p_period_start
      and public.subscription_shifted_date(p_subscription_id, v.plan_end_date) + 1 < p_period_end
    union
    select v.stopped_effective_date
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.stopped_effective_date is not null
      and v.stopped_effective_date > p_period_start and v.stopped_effective_date < p_period_end
    union
    select f.freeze_from
    from public.subscription_freezes f
    where f.subscription_id = p_subscription_id and f.cancelled_at is null
      and f.freeze_from > p_period_start and f.freeze_from < p_period_end
    union
    select f.freeze_until + 1
    from public.subscription_freezes f
    where f.subscription_id = p_subscription_id and f.cancelled_at is null
      and f.freeze_until + 1 > p_period_start and f.freeze_until + 1 < p_period_end
  ),
  ordered as (
    select d, lead(d) over (order by d) as next_d
    from boundary_points
  ),
  segments as (
    select d as segment_start, next_d as segment_end
    from ordered
    where next_d is not null and next_d > d
  )
  select
    s.segment_start,
    s.segment_end,
    v.id as version_id,
    v.monthly_price_ils,
    (
      v.id is not null
      and s.segment_start >= v.plan_start_date
      and (v.plan_end_date is null or s.segment_start <= public.subscription_shifted_date(p_subscription_id, v.plan_end_date))
      and (v.stopped_effective_date is null or s.segment_start < v.stopped_effective_date)
      and not exists (
        select 1 from public.subscription_freezes f
        where f.subscription_id = p_subscription_id and f.cancelled_at is null
          and f.freeze_from <= s.segment_start and f.freeze_until >= s.segment_start
      )
    ) as is_billable,
    exists (
      select 1 from public.subscription_freezes f
      where f.subscription_id = p_subscription_id and f.cancelled_at is null
        and f.freeze_from <= s.segment_start and f.freeze_until >= s.segment_start
    ) as is_frozen,
    (s.segment_end - s.segment_start)::int as segment_days
  from segments s
  left join public.subscription_versions v
    on v.subscription_id = p_subscription_id
    and v.effective_from <= s.segment_start
    and (v.effective_to is null or v.effective_to > s.segment_start)
  order by s.segment_start;
$function$;

-- ---------------------------------------------------------------------------
-- Lifecycle entry points.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_subscription(p_payee_id uuid, p_payee_is_manual boolean, p_monthly_price_ils numeric, p_start_date date, p_end_date date DEFAULT NULL::date, p_anchor_day smallint DEFAULT NULL::smallint, p_allowances jsonb DEFAULT '[]'::jsonb, p_initial_payment_amount_ils numeric DEFAULT NULL::numeric, p_initial_payment_method text DEFAULT NULL::text, p_initial_payment_payer_name text DEFAULT NULL::text, p_initial_payment_note text DEFAULT NULL::text, p_initial_payment_client_request_id uuid DEFAULT NULL::uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_subscription_id uuid;
  v_version_id uuid;
  v_anchor smallint;
  v_conflict record;
  v_tier public.subscription_tier;
  v_seen_tiers public.subscription_tier[] := '{}';
  a jsonb;
  v_limit int;
  v_payment_id uuid;
  v_existing_payment_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if p_monthly_price_ils is null or p_monthly_price_ils < 0 then
    return json_build_object('ok', false, 'error', 'invalid_price');
  end if;
  if p_start_date is null then
    return json_build_object('ok', false, 'error', 'invalid_start_date');
  end if;
  if p_end_date is not null and p_end_date < p_start_date then
    return json_build_object('ok', false, 'error', 'invalid_date_range');
  end if;
  if p_payee_id is null then
    return json_build_object('ok', false, 'error', 'invalid_payee');
  end if;

  -- Initial payment is optional, but if any amount is supplied it must be well-formed -- checked
  -- up front, before any insert, so a bad payment never leaves a subscription created without it
  -- (or worse, a half-created pair).
  if p_initial_payment_amount_ils is not null then
    if p_initial_payment_amount_ils <= 0 then
      return json_build_object('ok', false, 'error', 'invalid_initial_payment_amount');
    end if;
    if p_initial_payment_method is null or btrim(p_initial_payment_method) = '' then
      return json_build_object('ok', false, 'error', 'invalid_initial_payment_method');
    end if;
    -- Idempotency fast path for the whole create-with-payment call: if this exact client token
    -- already produced a payment, the subscription side already happened too (same transaction),
    -- so treat this as "already done" rather than creating a second subscription.
    if p_initial_payment_client_request_id is not null then
      select id into v_existing_payment_id
      from public.athlete_account_payments
      where client_request_id = p_initial_payment_client_request_id;
      if found then
        return json_build_object(
          'ok', true, 'subscription_id', (select source_subscription_id from public.athlete_account_payments where id = v_existing_payment_id),
          'payment_id', v_existing_payment_id, 'duplicate', true
        );
      end if;
    end if;
  end if;

  -- Exactly one valid payee identity, reusing the existing validation trigger
  -- (_validate_subscription_payee) at INSERT time below; here we only reject the obviously-wrong
  -- shape early (dual-payee XOR is inherent to the two-column model, not a two-nullable-column
  -- pattern, so there is nothing further to XOR-check at this layer).

  perform pg_advisory_xact_lock(public.subscription_payee_create_lock_key(p_payee_id, p_payee_is_manual));

  -- Conflicting-active-subscription-lineage rule (judgment call -- see migration header §2):
  -- reject if this payee already has a non-tombstoned subscription whose CURRENT version's
  -- display status as of p_start_date is not 'stopped'/'completed'.
  select s.id into v_conflict
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  where s.payee_id = p_payee_id
    and s.payee_is_manual = coalesce(p_payee_is_manual, false)
    and s.deleted_at is null
    and public.subscription_version_display_status(v.id, p_start_date) not in ('stopped', 'completed')
  limit 1;

  if found then
    return json_build_object('ok', false, 'error', 'conflicting_active_subscription', 'subscription_id', v_conflict.id);
  end if;

  v_anchor := coalesce(p_anchor_day, extract(day from p_start_date)::smallint);
  if v_anchor < 1 or v_anchor > 31 then
    return json_build_object('ok', false, 'error', 'invalid_anchor_day');
  end if;

  insert into public.subscriptions (payee_id, payee_is_manual, created_by)
  values (p_payee_id, coalesce(p_payee_is_manual, false), v_uid)
  returning id into v_subscription_id;

  insert into public.subscription_versions (
    subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
    plan_start_date, plan_end_date, created_by
  ) values (
    v_subscription_id, 1, p_start_date, p_monthly_price_ils, v_anchor,
    p_start_date, p_end_date, v_uid
  ) returning id into v_version_id;

  -- Normalize allowances: exactly one row per subscription_tier, defaulting an unspecified tier to
  -- weekly_limit 0 (tier not included), validating each supplied entry is a real tier with a
  -- non-negative integer limit. Stored exactly as configured, regardless of duration/end-date --
  -- has_no_end_date (derived from p_end_date) never affects weekly_limit in any way.
  for v_tier in select unnest(enum_range(null::public.subscription_tier)) loop
    v_limit := 0;
    for a in select * from jsonb_array_elements(coalesce(p_allowances, '[]'::jsonb)) loop
      if (a->>'tier')::public.subscription_tier = v_tier then
        v_limit := (a->>'weekly_limit')::int;
      end if;
    end loop;
    if v_limit is null or v_limit < 0 then
      return json_build_object('ok', false, 'error', 'invalid_allowance', 'tier', v_tier::text);
    end if;
    insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
    values (v_version_id, v_tier, v_limit);
  end loop;

  -- Immediate first billing if the start date is today/past -- reuses the exact Phase 3 engine,
  -- the same call generate_due_subscription_charges makes for a subscription's first period. If
  -- p_start_date is in the future, this call's own guard (v_next_start > v_today check lives in
  -- the daily job, not here) is replicated inline: only bill immediately when due.
  if p_start_date <= public._studio_today_date() then
    perform public.subscription_generate_or_correct_billing_period(
      v_subscription_id, v_version_id, p_start_date,
      public.subscription_next_anchor_date(v_anchor, p_start_date),
      null, null
    );
  end if;

  -- Initial payment (3.1): recorded as an ordinary athlete_account_payments row tagged to this
  -- subscription, in the SAME transaction as the subscription itself (this is a single plpgsql
  -- function invocation -- there is no implicit commit between statements), so a failure here
  -- rolls back the subscription too rather than leaving it payment-less and ambiguous. No receipt
  -- is issued. Partial/overpayment amounts are both allowed -- no comparison to the monthly price
  -- is enforced server-side (the UI defaults the field to the monthly price, but the manager may
  -- change it either way).
  if p_initial_payment_amount_ils is not null then
    begin
      insert into public.athlete_account_payments (
        payee_id, payee_is_manual, amount_ils, payment_method, payer_name, note, paid_at,
        source_subscription_id, client_request_id
      ) values (
        p_payee_id, coalesce(p_payee_is_manual, false), p_initial_payment_amount_ils, p_initial_payment_method,
        p_initial_payment_payer_name, p_initial_payment_note, public._studio_today_date(),
        v_subscription_id, p_initial_payment_client_request_id
      )
      returning id into v_payment_id;
    exception when unique_violation then
      select id into v_payment_id
      from public.athlete_account_payments
      where client_request_id = p_initial_payment_client_request_id;
    end;
  end if;

  -- Bookings the person already holds for future sessions are evaluated now; ended sessions are never touched.
  perform public._subscription_cover_existing_future_registrations(v_subscription_id);

  perform public._insert_activity_event(v_uid, 'subscription_created', 'subscription', v_subscription_id::text,
    jsonb_build_object('payee_id', p_payee_id, 'payee_is_manual', coalesce(p_payee_is_manual, false),
      'monthly_price_ils', p_monthly_price_ils, 'start_date', p_start_date, 'end_date', p_end_date));

  return json_build_object(
    'ok', true, 'subscription_id', v_subscription_id, 'version_id', v_version_id,
    'payment_id', v_payment_id,
    'future_registrations_covered', (select count(*) from public.subscription_registration_coverage c
                                     where c.subscription_id = v_subscription_id and c.covered)
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.reactivate_subscription(p_source_subscription_id uuid, p_start_date date, p_end_date date DEFAULT NULL::date)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_src_sub public.subscriptions%rowtype;
  v_src_version public.subscription_versions%rowtype;
  v_new_sub_id uuid;
  v_new_version_id uuid;
  -- The reactivation date is the new monthly anchor (owner decision): a new billing cycle starts that day, so no short
  -- period can carry a full monthly charge. The source's history stays on the source.
  v_anchor smallint := extract(day from p_start_date)::smallint;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_start_date is null then
    return json_build_object('ok', false, 'error', 'invalid_start_date');
  end if;
  if p_end_date is not null and p_end_date < p_start_date then
    return json_build_object('ok', false, 'error', 'invalid_date_range');
  end if;

  select * into v_src_sub from public.subscriptions where id = p_source_subscription_id;
  if not found then
    return json_build_object('ok', false, 'error', 'source_subscription_not_found');
  end if;

  -- Copy from whichever version is most representative of the source's settings: its most recent
  -- (highest version_no) version, regardless of that source subscription's own current tombstoned/
  -- stopped state — reactivate is explicitly meant to work from historical/stopped/tombstoned
  -- subscriptions.
  select * into v_src_version from public.subscription_versions
  where subscription_id = p_source_subscription_id
  order by version_no desc limit 1;
  if not found then
    return json_build_object('ok', false, 'error', 'source_has_no_version');
  end if;

  perform pg_advisory_xact_lock(public.subscription_payee_create_lock_key(v_src_sub.payee_id, v_src_sub.payee_is_manual));

  if exists (
    select 1 from public.subscriptions s
    join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
    where s.payee_id = v_src_sub.payee_id
      and s.payee_is_manual = v_src_sub.payee_is_manual
      and s.deleted_at is null
      and public.subscription_version_display_status(v.id, p_start_date) not in ('stopped', 'completed')
  ) then
    return json_build_object('ok', false, 'error', 'conflicting_active_subscription');
  end if;

  insert into public.subscriptions (payee_id, payee_is_manual, created_by)
  values (v_src_sub.payee_id, v_src_sub.payee_is_manual, v_uid)
  returning id into v_new_sub_id;

  -- p_end_date (this call's own parameter) independently controls the new lineage's duration —
  -- has_no_end_date derives automatically (generated column); the source's own has_no_end_date is
  -- never copied, matching "Requires new start date and optional end date ... from caller".
  insert into public.subscription_versions (
    subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
    plan_start_date, plan_end_date, created_by
  ) values (
    v_new_sub_id, 1, p_start_date, v_src_version.monthly_price_ils, v_anchor,
    p_start_date, p_end_date, v_uid
  ) returning id into v_new_version_id;

  -- Copies price/allowances/plan settings only — never freezes, charges, coverage, or billing
  -- periods, which all stay with the original historical subscription (a brand-new subscriptions
  -- row means no FK from any of those tables could ever point at this new lineage anyway).
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
  select v_new_version_id, tier, weekly_limit
  from public.subscription_version_allowances where version_id = v_src_version.id;

  if p_start_date <= public._studio_today_date() then
    perform public.subscription_generate_or_correct_billing_period(
      v_new_sub_id, v_new_version_id, p_start_date,
      public.subscription_next_anchor_date(v_anchor, p_start_date),
      null, null
    );
  end if;

  perform public._subscription_cover_existing_future_registrations(v_new_sub_id);

  perform public._insert_activity_event(v_uid, 'subscription_reactivated', 'subscription', v_new_sub_id::text,
    jsonb_build_object('source_subscription_id', p_source_subscription_id, 'start_date', p_start_date, 'end_date', p_end_date));

  return json_build_object('ok', true, 'subscription_id', v_new_sub_id, 'version_id', v_new_version_id);
end;
$function$;
CREATE OR REPLACE FUNCTION public.freeze_subscription(p_subscription_id uuid, p_freeze_from date, p_freeze_until date, p_confirmed boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_impact jsonb;
  v_freeze_id uuid;
  v_version_id uuid;
  r record;
  v_source_id uuid;
  v_next_billing_date date;
  v_effective_plan_end_date date;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_freeze_from is null or p_freeze_until is null or p_freeze_until < p_freeze_from then
    return json_build_object('ok', false, 'error', 'invalid_freeze_dates');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  if not exists (select 1 from public.subscriptions where id = p_subscription_id and deleted_at is null) then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  select id into v_version_id from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if v_version_id is null then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  -- Checked first: the impact preview tries the insert, and would report the standing freeze as an overlap.
  if exists (select 1 from public.subscription_freezes f where f.subscription_id = p_subscription_id
             and f.cancelled_at is null and f.freeze_from = p_freeze_from and f.freeze_until = p_freeze_until) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  v_impact := public.subscription_compute_impact(
    p_subscription_id, 'freeze', p_freeze_from, p_freeze_until
  );
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  -- After an unfreeze the same dates are a new freeze, so the ledger key is the freeze row itself.

  begin
    insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until, created_by)
    values (p_subscription_id, p_freeze_from, p_freeze_until, v_uid)
    returning id into v_freeze_id;
    v_source_id := v_freeze_id;
  exception
    when exclusion_violation then
      return json_build_object('ok', false, 'error', 'freeze_overlap');
  end;

  for r in
    select distinct tier, week_start
    from public.subscription_registration_coverage
    where subscription_id = p_subscription_id
      and week_start >= (p_freeze_from - extract(dow from p_freeze_from)::int)
  loop
    perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
  end loop;

  -- Shift every billing period whose raw (unshifted) window is at or after the freeze -- covers
  -- both the ordinary "current period" case and a retroactive freeze touching several already-
  -- generated periods. Each call is idempotent and only writes a correction charge if the
  -- recomputed amount actually differs (the common case: none, since the extended period nets to
  -- the same full price -- see subscription_billing_period_amount's comment).
  for r in
    select bp.raw_period_start, bp.raw_period_end
    from public.subscription_billing_periods bp
    where bp.subscription_id = p_subscription_id
      and bp.period_end >= p_freeze_from
    order by bp.raw_period_start asc
  loop
    perform public.subscription_generate_or_correct_billing_period(
      p_subscription_id, v_version_id, r.raw_period_start, r.raw_period_end, v_source_id, 'freeze_credit'
    );
  end loop;

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'freeze', v_source_id, p_freeze_from, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  perform public._insert_activity_event(v_uid, 'subscription_frozen', 'subscription', p_subscription_id::text,
    jsonb_build_object('freeze_id', v_freeze_id, 'freeze_from', p_freeze_from, 'freeze_until', p_freeze_until));

  v_next_billing_date := public.subscription_effective_next_billing_date(p_subscription_id);
  v_effective_plan_end_date := public.subscription_effective_plan_end_date(v_version_id);

  return json_build_object(
    'ok', true, 'action', 'applied', 'freeze_id', v_freeze_id, 'impact', v_impact,
    'frozen_days', (p_freeze_until - p_freeze_from + 1),
    'next_billing_date', v_next_billing_date,
    'effective_plan_end_date', v_effective_plan_end_date
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public.subscription_compute_impact(p_subscription_id uuid, p_action_type subscription_impact_action_type, p_freeze_from date DEFAULT NULL::date, p_freeze_until date DEFAULT NULL::date, p_stop_date date DEFAULT NULL::date, p_new_effective_from date DEFAULT NULL::date, p_new_price numeric DEFAULT NULL::numeric, p_new_plan_end_date date DEFAULT NULL::date, p_clear_end_date boolean DEFAULT false, p_new_allowances jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sub public.subscriptions%rowtype;
  v_current public.subscription_versions%rowtype;
  v_new_version_id uuid;
  v_freeze_id uuid;
  v_range_start date;
  v_items jsonb := '[]'::jsonb;
  v_count int := 0;
  v_has_history boolean;
  v_new_plan_end_date date;
  v_preview_next_billing_date date;
  v_preview_effective_plan_end_date date;
  r record;
  v_after public.subscription_registration_coverage%rowtype;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id and deleted_at is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_current_version');
  end if;

  if p_action_type = 'freeze' then
    if p_freeze_from is null or p_freeze_until is null then
      return jsonb_build_object('ok', false, 'error', 'freeze_dates_required');
    end if;
    v_range_start := p_freeze_from;
  elsif p_action_type = 'stop' then
    if p_stop_date is null then
      return jsonb_build_object('ok', false, 'error', 'stop_date_required');
    end if;
    v_range_start := p_stop_date;
  elsif p_action_type = 'edit' then
    if p_new_effective_from is null then
      return jsonb_build_object('ok', false, 'error', 'effective_from_required');
    end if;
    v_range_start := p_new_effective_from;
  else
    return jsonb_build_object('ok', false, 'error', 'unsupported_action_type');
  end if;

  create temporary table if not exists _subscription_impact_before (
    coverage_id uuid primary key,
    covered boolean not null
  ) on commit drop;
  delete from _subscription_impact_before where coverage_id is not null;

  insert into _subscription_impact_before (coverage_id, covered)
  select id, covered from public.subscription_registration_coverage
  where subscription_id = p_subscription_id;

  begin
    if p_action_type = 'freeze' then
      insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until)
      values (p_subscription_id, p_freeze_from, p_freeze_until)
      returning id into v_freeze_id;

    elsif p_action_type = 'stop' then
      update public.subscription_versions
      set stopped_effective_date = p_stop_date
      where id = v_current.id;

    elsif p_action_type = 'edit' then
      v_new_plan_end_date := case when p_clear_end_date then null else coalesce(p_new_plan_end_date, v_current.plan_end_date) end;

      if p_new_effective_from < v_current.effective_from then
        return jsonb_build_object('ok', false, 'error', 'effective_from_before_current_version');
      end if;

      if p_new_effective_from = v_current.effective_from then
        select exists (
          select 1 from public.subscription_billing_periods where version_id = v_current.id
          union all
          select 1 from public.subscription_registration_coverage where version_id = v_current.id
        ) into v_has_history;

        if not v_has_history then
          update public.subscription_versions
          set monthly_price_ils = coalesce(p_new_price, v_current.monthly_price_ils),
              plan_end_date = v_new_plan_end_date
          where id = v_current.id;
          v_new_version_id := v_current.id;

          if p_new_allowances is not null then
            delete from public.subscription_version_allowances where version_id = v_current.id;
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_current.id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
            from jsonb_array_elements(p_new_allowances) a;
          end if;
        else
          update public.subscription_versions
          set effective_to = p_new_effective_from
          where id = v_current.id;

          insert into public.subscription_versions (
            subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
            plan_start_date, plan_end_date, created_by
          ) values (
            p_subscription_id,
            (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
            p_new_effective_from,
            coalesce(p_new_price, v_current.monthly_price_ils),
            v_current.anchor_day,
            v_current.plan_start_date,
            v_new_plan_end_date,
            v_current.created_by
          ) returning id into v_new_version_id;

          update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

          if p_new_allowances is not null then
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
            from jsonb_array_elements(p_new_allowances) a;
          else
            insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
            select v_new_version_id, tier, weekly_limit
            from public.subscription_version_allowances where version_id = v_current.id;
          end if;
        end if;
      else
        update public.subscription_versions
        set effective_to = p_new_effective_from
        where id = v_current.id;

        insert into public.subscription_versions (
          subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
          plan_start_date, plan_end_date, created_by
        ) values (
          p_subscription_id,
          (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
          p_new_effective_from,
          coalesce(p_new_price, v_current.monthly_price_ils),
          v_current.anchor_day,
          v_current.plan_start_date,
          v_new_plan_end_date,
          v_current.created_by
        ) returning id into v_new_version_id;

        update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

        if p_new_allowances is not null then
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
          from jsonb_array_elements(p_new_allowances) a;
        else
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, tier, weekly_limit
          from public.subscription_version_allowances where version_id = v_current.id;
        end if;
      end if;
    end if;

    for r in
      select distinct tier, week_start
      from public.subscription_registration_coverage
      where subscription_id = p_subscription_id
        and week_start >= (v_range_start - extract(dow from v_range_start)::int)
    loop
      perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
    end loop;

    if p_action_type = 'freeze' then
      -- Actually run the real billing-period correction inside this rolled-back block, so the
      -- preview's derived dates come from the exact same authoritative logic the real freeze will
      -- use -- never computed independently here.
      for r in
        select bp.raw_period_start, bp.raw_period_end
        from public.subscription_billing_periods bp
        where bp.subscription_id = p_subscription_id
          and bp.period_end >= p_freeze_from
      loop
        perform public.subscription_generate_or_correct_billing_period(
          p_subscription_id, v_current.id, r.raw_period_start, r.raw_period_end, v_freeze_id, 'freeze_credit'
        );
      end loop;

      v_preview_next_billing_date := public.subscription_effective_next_billing_date(p_subscription_id);
      v_preview_effective_plan_end_date := public.subscription_effective_plan_end_date(v_current.id);
    end if;

    for v_after in
      select cov.*
      from public.subscription_registration_coverage cov
      join _subscription_impact_before b on b.coverage_id = cov.id
      where cov.subscription_id = p_subscription_id
        and b.covered = true
        and cov.covered = false
    loop
      v_count := v_count + 1;
      v_items := v_items || jsonb_build_object(
        'registration_id', v_after.registration_id,
        'manual_participant_id', v_after.manual_participant_id,
        'session_date', v_after.session_date,
        'week_start', v_after.week_start,
        'tier', v_after.tier,
        'new_non_coverage_reason', v_after.non_coverage_reason
      );
    end loop;

    raise exception using errcode = 'ZZ001', message = 'subscription_impact_preview_rollback';
  exception
    when sqlstate 'ZZ001' then
      null;
    when exclusion_violation then
      return jsonb_build_object('ok', false, 'error', 'freeze_overlap');
  end;

  return jsonb_build_object(
    'ok', true,
    'count', v_count,
    'items', v_items,
    'current_monthly_price_ils', v_current.monthly_price_ils,
    'preview_next_billing_date', v_preview_next_billing_date,
    'preview_effective_plan_end_date', v_preview_effective_plan_end_date,
    'estimate_note',
      'count is exact (recomputed via the real subscription_reconcile_week algorithm under the ' ||
      'hypothetical state, then rolled back). A precise dollar figure is intentionally not ' ||
      'estimated here — the exact amount is determined by subscription_generate_or_correct_' ||
      'billing_period at confirm time, which segments real calendar days across real prices. For a ' ||
      'freeze specifically, preview_next_billing_date/preview_effective_plan_end_date are computed '||
      'by actually running that same correction logic inside this rolled-back preview.'
  );
end;
$function$;
CREATE OR REPLACE FUNCTION public._subscription_resolve_future_registrations(p_subscription_id uuid, p_cutoff_date date, p_action text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count int := 0;
  r record;
begin
  if p_action not in ('remove', 'charge_regular_price') then
    raise exception 'invalid_future_registration_action';
  end if;

  -- Materialized: the whole list is read and locked before the first removal fires a reconcile that could change it.
  for r in
    with list as materialized (
    select cov.id as cov_id, sr.session_id, sr.user_id
    from public.subscription_registration_coverage cov
    join public.session_registrations sr on sr.id = cov.registration_id
    join public.training_sessions ts on ts.id = sr.session_id
    where cov.subscription_id = p_subscription_id
      and cov.covered = true
      and cov.session_date >= p_cutoff_date
      and cov.registration_id is not null
      and sr.status = 'active'
      and not public._session_has_ended(ts)
    for update of cov, sr
    ) select * from list
  loop
    if p_action = 'remove' then
      perform public.manager_remove_athlete(r.session_id, r.user_id);
      -- The registration row survives as 'cancelled' (manager_remove_athlete never deletes it, for
      -- registration_history's sake) -- the coverage row no longer describes anything live, so it is
      -- removed too (now safe: 20261026160000 unguarded this table from hard DELETE). Neither the
      -- registration nor any attendance/payment row is touched.
      delete from public.subscription_registration_coverage where id = r.cov_id;
    else
      update public.subscription_registration_coverage
      set covered = false,
          non_coverage_reason = 'subscription_ended',
          decided_at = now(),
          decided_by = 'reconcile'
      where id = r.cov_id;
    end if;
    v_count := v_count + 1;
  end loop;

  for r in
    with list as materialized (
    select cov.id as cov_id, smp.session_id, smp.manual_participant_id as mp_id
    from public.subscription_registration_coverage cov
    join public.session_manual_participants smp on smp.id = cov.manual_participant_id
    join public.training_sessions ts on ts.id = smp.session_id
    where cov.subscription_id = p_subscription_id
      and cov.covered = true
      and cov.session_date >= p_cutoff_date
      and cov.manual_participant_id is not null
      and not public._session_has_ended(ts)
    for update of cov, smp
    ) select * from list
  loop
    if p_action = 'remove' then
      perform public.remove_manual_participant_from_session(r.session_id, r.mp_id);
      -- remove_manual_participant_from_session hard-deletes the session_manual_participants row,
      -- which cascades the coverage row automatically (20261026160000) -- explicit delete as a
      -- harmless backstop in case that ever changes.
      delete from public.subscription_registration_coverage where id = r.cov_id;
    else
      update public.subscription_registration_coverage
      set covered = false,
          non_coverage_reason = 'subscription_ended',
          decided_at = now(),
          decided_by = 'reconcile'
      where id = r.cov_id;
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;
CREATE OR REPLACE FUNCTION public.stop_subscription_with_future_registrations(p_subscription_id uuid, p_stop_date date, p_confirmed boolean DEFAULT false, p_future_registration_action text DEFAULT NULL::text, p_expected_future_registration_ids uuid[] DEFAULT NULL::uuid[], p_expected_future_manual_participant_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_impact jsonb;
  v_future_impact jsonb;
  v_future_resolved int := 0;
  r record;
  v_source_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_stop_date is null then
    return json_build_object('ok', false, 'error', 'stop_date_required');
  end if;
  if p_future_registration_action is not null and p_future_registration_action not in ('remove', 'charge_regular_price') then
    return json_build_object('ok', false, 'error', 'invalid_future_registration_action');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  v_impact := public.subscription_compute_impact(p_subscription_id, 'stop', null, null, p_stop_date);
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  v_future_impact := public.subscription_future_registrations_impact(p_subscription_id, p_stop_date);

  if (coalesce((v_impact->>'count')::int, 0) > 0 or jsonb_array_length(v_future_impact) > 0)
     and not coalesce(p_confirmed, false) then
    return json_build_object(
      'ok', true, 'action', 'preview', 'impact', v_impact,
      'future_registrations', v_future_impact,
      'future_registrations_count', jsonb_array_length(v_future_impact)
    );
  end if;

  if jsonb_array_length(v_future_impact) > 0 and p_future_registration_action is null then
    return json_build_object(
      'ok', false, 'error', 'future_registration_action_required',
      'future_registrations', v_future_impact,
      'future_registrations_count', jsonb_array_length(v_future_impact)
    );
  end if;

  -- (2) Preview/confirm staleness guard. Only relevant when we're actually about to resolve
  -- something; a null action with zero future rows never reaches here with anything to check.
  if p_future_registration_action is not null and jsonb_array_length(v_future_impact) > 0 then
    if p_expected_future_registration_ids is null or p_expected_future_manual_participant_ids is null then
      return json_build_object(
        'ok', false, 'error', 'future_registrations_expectation_required',
        'future_registrations', v_future_impact,
        'future_registrations_count', jsonb_array_length(v_future_impact)
      );
    end if;

    if exists (
      select 1
      from jsonb_to_recordset(v_future_impact) as x(registration_id uuid, manual_participant_id uuid)
      where (x.registration_id is not null and x.registration_id <> all (p_expected_future_registration_ids))
         or (x.manual_participant_id is not null and x.manual_participant_id <> all (p_expected_future_manual_participant_ids))
    ) then
      return json_build_object(
        'ok', false, 'error', 'future_registrations_changed',
        'future_registrations', v_future_impact,
        'future_registrations_count', jsonb_array_length(v_future_impact)
      );
    end if;
  end if;

  -- Idempotency key includes both which entry point applied the stop and the chosen future-
  -- registration action (same discipline as edit_subscription_version's payload-inclusive key): a
  -- retry with the SAME action converges; a different action for the same subscription/stop_date is a
  -- genuinely different operation. Deliberately namespaced ('stopv2') separately from the plain
  -- stop_subscription entry point's key -- the two share subscription_admin_lock_key (so they can
  -- never race each other) but are tracked as independent idempotency lineages; the underlying
  -- mutations (stopped_effective_date update, billing correction) are themselves safe to re-apply with
  -- the same effective values (guarded by `is distinct from` / amount-equality checks), so this is a
  -- transitional-period bookkeeping nuance, not a correctness or financial-integrity risk.
  v_source_id := md5(
    p_subscription_id::text || '|stopv2|' || p_stop_date::text || '|' ||
    coalesce(p_future_registration_action, 'none')
  )::uuid;

  -- A retry is the same request while it is still what stands. Returning to an earlier stop date is a new operation.
  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'stop' and action_source_id = v_source_id and confirmed = true) then
    if v_current.stopped_effective_date is not distinct from p_stop_date then
      return json_build_object('ok', true, 'action', 'already_applied');
    end if;
    v_source_id := md5(v_source_id::text || '|' || (select count(*) from public.subscription_impact_events
                       where subscription_id = p_subscription_id and action_type = 'stop'))::uuid;
  end if;

  update public.subscription_versions
  set stopped_effective_date = p_stop_date
  where id = v_current.id and stopped_effective_date is distinct from p_stop_date;

  -- The manager's choice is applied BEFORE reconciling: reconcile moves these rows to not covered, and the resolver acts
  -- on rows that are still covered. Anything short of the full list rolls the whole stop back rather than report success.
  if p_future_registration_action is not null then
    v_future_resolved := public._subscription_resolve_future_registrations(
      p_subscription_id, p_stop_date, p_future_registration_action
    );
    if v_future_resolved <> jsonb_array_length(v_future_impact) then
      raise exception 'future_registrations_not_resolved'
        using errcode = 'P0001',
              detail = format('expected %s, resolved %s', jsonb_array_length(v_future_impact), v_future_resolved);
    end if;
  end if;

  for r in
    select distinct tier, week_start
    from public.subscription_registration_coverage
    where subscription_id = p_subscription_id
      and week_start >= (p_stop_date - extract(dow from p_stop_date)::int)
  loop
    perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
  end loop;

  for r in
    select bp.raw_period_start, bp.raw_period_end
    from public.subscription_billing_periods bp
    where bp.subscription_id = p_subscription_id
      and bp.period_end > p_stop_date
    order by bp.raw_period_start asc
  loop
    perform public.subscription_generate_or_correct_billing_period(
      p_subscription_id, v_current.id, r.raw_period_start, r.raw_period_end, v_source_id, 'stop_proration'
    );
  end loop;

  perform public._insert_activity_event(v_uid, 'subscription_stopped', 'subscription', p_subscription_id::text,
    jsonb_build_object('stop_date', p_stop_date, 'future_registration_action', p_future_registration_action,
      'future_registrations_resolved', v_future_resolved));

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'stop', v_source_id, p_stop_date, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  return json_build_object(
    'ok', true, 'action', 'applied', 'impact', v_impact,
    'future_registrations_resolved', v_future_resolved
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- The old stop entry point can no longer skip the manager's choice about future bookings.
-- ---------------------------------------------------------------------------
create or replace function public.stop_subscription(p_subscription_id uuid, p_stop_date date, p_confirmed boolean default false)
returns json
language sql
security definer
set search_path = public
as $$
  select public.stop_subscription_with_future_registrations(p_subscription_id, p_stop_date, p_confirmed, null, null, null);
$$;
CREATE OR REPLACE FUNCTION public.edit_subscription_version(p_subscription_id uuid, p_effective_from date, p_new_price numeric DEFAULT NULL::numeric, p_new_plan_end_date date DEFAULT NULL::date, p_clear_end_date boolean DEFAULT false, p_new_allowances jsonb DEFAULT NULL::jsonb, p_confirmed boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_impact jsonb;
  v_new_version_id uuid;
  v_new_plan_end_date date;
  v_has_history boolean;
  v_rows int;
  r record;
  v_res json;
  v_current_allowances_map jsonb;
  v_new_allowances_map jsonb;
  v_actually_changed boolean;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_new_price is not null and p_new_price < 0 then
    return json_build_object('ok', false, 'error', 'invalid_price');
  end if;
  if p_effective_from is null then
    return json_build_object('ok', false, 'error', 'effective_from_required');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  -- Server-side impact recompute, always — never trust a client-supplied earlier preview, whether
  -- this is the first preview call or the confirmed application.
  v_impact := public.subscription_compute_impact(
    p_subscription_id, 'edit',
    null, null, null,
    p_effective_from, p_new_price, p_new_plan_end_date, p_clear_end_date, p_new_allowances
  );
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_new_plan_end_date := case when p_clear_end_date then null else coalesce(p_new_plan_end_date, v_current.plan_end_date) end;

  -- Whether this edit actually changes any subscription term, vs. just re-saving the form with the
  -- same price/end-date/allowances under a (possibly different) effective_from. Zero-weight tiers are
  -- normalized out of both sides before comparing allowances, matching how the UI itself treats "0
  -- per week" as "not included" (ManagerSubscriptionDetailScreen's allowances section filters the
  -- same way) -- so a resubmitted full 7-tier array with the same nonzero tiers is not a "change"
  -- just because it also spells out zeros the current version's rows happen to omit, or vice versa.
  select coalesce(jsonb_object_agg(tier::text, weekly_limit), '{}'::jsonb)
  into v_current_allowances_map
  from public.subscription_version_allowances
  where version_id = v_current.id and weekly_limit <> 0;

  if p_new_allowances is not null then
    select coalesce(jsonb_object_agg((a->>'tier'), (a->>'weekly_limit')::int), '{}'::jsonb)
    into v_new_allowances_map
    from jsonb_array_elements(p_new_allowances) a
    where (a->>'weekly_limit')::int <> 0;
  end if;

  v_actually_changed :=
    (p_new_price is not null and p_new_price is distinct from v_current.monthly_price_ils)
    or (v_new_plan_end_date is distinct from v_current.plan_end_date)
    or (p_new_allowances is not null and v_new_allowances_map is distinct from v_current_allowances_map);

  -- Idempotency (fixed — pre-merge review round 2): the key MUST distinguish a true retry of the
  -- identical request from a genuinely distinct edit that happens to share a subscription/date.
  -- Hashing subscription+action+date ALONE (the original design) collapsed two different edits
  -- effective on the same date into one "operation" — e.g. price 300 then a later, deliberate
  -- price 350 correction for the same date would have been misread as a retry of the first and
  -- silently dropped. The key now incorporates every business-relevant field actually being
  -- changed (price, resulting plan_end_date, and the canonical text form of the allowances jsonb,
  -- which is stable/order-independent since Postgres normalizes jsonb on parse) so two payloads
  -- differing in ANY of those fields always produce different keys, while two calls with an
  -- identical payload converge to the same key (a true retry).
  declare
    v_source_id uuid := md5(
      p_subscription_id::text || '|edit|' || p_effective_from::text || '|' ||
      coalesce(p_new_price::text, 'null') || '|' ||
      coalesce(v_new_plan_end_date::text, 'null') || '|' ||
      coalesce(p_new_allowances::text, 'null')
    )::uuid;
  begin
    -- A true retry is the identical request with nothing left to change. The same payload after other edits is a real
    -- change, and needs its own ledger key.
    if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
               and action_type = 'edit' and action_source_id = v_source_id and confirmed = true) then
      if not v_actually_changed then
        return json_build_object('ok', true, 'action', 'already_applied');
      end if;
      v_source_id := md5(v_source_id::text || '|' || (select count(*) from public.subscription_impact_events
                         where subscription_id = p_subscription_id and action_type = 'edit'))::uuid;
    end if;

    if p_effective_from < v_current.effective_from then
      return json_build_object('ok', false, 'error', 'effective_from_before_current_version');
    end if;

    if not v_actually_changed then
      -- Nothing about price, plan end date, or allowances is actually different — never close the
      -- current version or insert an identical-looking duplicate purely because the form was saved
      -- with a (possibly different) effective_from. The reconcile/billing-correction steps below
      -- still run against the unchanged current version and are no-ops (same amount -> 'unchanged',
      -- no charge rows written), so this path is a true no-op end to end.
      v_new_version_id := v_current.id;
    elsif p_effective_from = v_current.effective_from then
      -- Safety check (fixed — pre-merge review round 2): re-verified fresh against the live schema
      -- that the only two tables referencing subscription_versions.id are
      -- subscription_billing_periods.version_id and subscription_registration_coverage.version_id
      -- (subscription_version_allowances also references it, but every version has allowance rows
      -- immediately upon creation — that is configuration, not history, and is excluded here).
      select exists (
        select 1 from public.subscription_billing_periods where version_id = v_current.id
        union all
        select 1 from public.subscription_registration_coverage where version_id = v_current.id
      ) into v_has_history;

      if not v_has_history then
        -- Case (a): brand-new version, nothing depends on it yet — safe to update in place.
        update public.subscription_versions
        set monthly_price_ils = coalesce(p_new_price, v_current.monthly_price_ils),
            plan_end_date = v_new_plan_end_date
        where id = v_current.id;
        v_new_version_id := v_current.id;

        if p_new_allowances is not null then
          delete from public.subscription_version_allowances where version_id = v_current.id;
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_current.id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
          from jsonb_array_elements(p_new_allowances) a;
        end if;
      else
        -- Case (b): history already exists against this exact version. Never mutate it in place —
        -- close it with effective_to = its OWN effective_from (a deliberate, explicitly-safe
        -- zero-width case; see 20260924146000's constraint-relaxation comment for the proof that a
        -- zero-width version can never match any real billing segment) and insert a genuinely new
        -- version at that same date. The original row's fields are never touched, preserving full
        -- auditability, while "from the beginning" semantics and correct corrections are honored
        -- via the normal reconcile/billing-correction steps below.
        update public.subscription_versions
        set effective_to = p_effective_from
        where id = v_current.id and effective_to is null;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          return json_build_object('ok', false, 'error', 'concurrent_modification');
        end if;

        insert into public.subscription_versions (
          subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
          plan_start_date, plan_end_date, created_by
        ) values (
          p_subscription_id,
          (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
          p_effective_from,
          coalesce(p_new_price, v_current.monthly_price_ils),
          v_current.anchor_day,
          v_current.plan_start_date,
          v_new_plan_end_date,
          v_uid
        ) returning id into v_new_version_id;

        update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

        if p_new_allowances is not null then
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
          from jsonb_array_elements(p_new_allowances) a;
        else
          insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
          select v_new_version_id, tier, weekly_limit
          from public.subscription_version_allowances where version_id = v_current.id;
        end if;
      end if;
    else
      update public.subscription_versions
      set effective_to = p_effective_from
      where id = v_current.id and effective_to is null;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', false, 'error', 'concurrent_modification');
      end if;

      insert into public.subscription_versions (
        subscription_id, version_no, effective_from, monthly_price_ils, anchor_day,
        plan_start_date, plan_end_date, created_by
      ) values (
        p_subscription_id,
        (select coalesce(max(version_no), 0) + 1 from public.subscription_versions where subscription_id = p_subscription_id),
        p_effective_from,
        coalesce(p_new_price, v_current.monthly_price_ils),
        v_current.anchor_day,
        v_current.plan_start_date,
        v_new_plan_end_date,
        v_uid
      ) returning id into v_new_version_id;

      update public.subscription_versions set superseded_by = v_new_version_id where id = v_current.id;

      if p_new_allowances is not null then
        insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
        select v_new_version_id, (a->>'tier')::public.subscription_tier, (a->>'weekly_limit')::int
        from jsonb_array_elements(p_new_allowances) a;
      else
        insert into public.subscription_version_allowances (version_id, tier, weekly_limit)
        select v_new_version_id, tier, weekly_limit
        from public.subscription_version_allowances where version_id = v_current.id;
      end if;
    end if;

    -- Reconcile every affected (tier, week_start) for real.
    for r in
      select distinct tier, week_start
      from public.subscription_registration_coverage
      where subscription_id = p_subscription_id
        and week_start >= (p_effective_from - extract(dow from p_effective_from)::int)
    loop
      perform public.subscription_reconcile_week(p_subscription_id, r.week_start, r.tier);
    end loop;

    -- Billing corrections for every existing billing period that overlaps the new version's
    -- effective window, through the Phase 3 correction engine, keyed to this edit's deterministic
    -- (now payload-inclusive) source_event_id (idempotent — a retry converges to
    -- 'unchanged'/'already_corrected').
    -- The engine takes RAW (unshifted) period bounds and adds the frozen days itself (20260928141108); passing the
    -- already-shifted effective dates made it shift twice, miss the existing row (unique on raw_period_start) and
    -- insert a duplicate billing period with a second full charge whenever the subscription had a freeze.
    for r in
      select bp.raw_period_start, bp.raw_period_end
      from public.subscription_billing_periods bp
      where bp.subscription_id = p_subscription_id
        and bp.period_end > p_effective_from
      order by bp.raw_period_start asc
    loop
      perform public.subscription_generate_or_correct_billing_period(
        p_subscription_id, v_new_version_id, r.raw_period_start, r.raw_period_end,
        v_source_id, 'edit_correction'
      );
    end loop;

    insert into public.subscription_impact_events (
      subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
    ) values (
      p_subscription_id, 'edit', v_source_id, p_effective_from, true, v_uid
    )
    on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

    if v_actually_changed then
      perform public._insert_activity_event(v_uid, 'subscription_edited', 'subscription', p_subscription_id::text,
        jsonb_build_object('effective_from', p_effective_from, 'version_id', v_new_version_id, 'new_price', p_new_price,
          'new_plan_end_date', v_new_plan_end_date, 'allowances_changed', p_new_allowances is not null));
    end if;

    return json_build_object('ok', true, 'action', 'applied', 'version_id', v_new_version_id, 'impact', v_impact);
  end;
end;
$function$;
CREATE OR REPLACE FUNCTION public.correct_subscription_start_date(p_subscription_id uuid, p_new_start_date date)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_has_history boolean;
  v_old_anchor_matched_default boolean;
  v_new_anchor smallint;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_new_start_date is null then
    return json_build_object('ok', false, 'error', 'invalid_start_date');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select * into v_current from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return json_build_object('ok', false, 'error', 'no_current_version');
  end if;

  if v_current.plan_end_date is not null and v_current.plan_end_date < p_new_start_date then
    return json_build_object('ok', false, 'error', 'invalid_date_range');
  end if;

  -- Must be the one and only version this subscription has ever had.
  if v_current.version_no <> 1 or v_current.superseded_by is not null then
    return json_build_object('ok', false, 'error', 'has_history', 'reason', 'edited_version');
  end if;

  select exists (
    select 1 from public.subscription_freezes where subscription_id = p_subscription_id
    union all
    select 1 from public.subscription_billing_periods where subscription_id = p_subscription_id
    union all
    select 1 from public.subscription_charges where subscription_id = p_subscription_id
    union all
    select 1 from public.subscription_registration_coverage where subscription_id = p_subscription_id
    union all
    select 1 from public.athlete_account_payments where source_subscription_id = p_subscription_id
  ) into v_has_history;

  if v_has_history then
    return json_build_object('ok', false, 'error', 'has_history', 'reason', 'financial_or_coverage_activity');
  end if;

  v_old_anchor_matched_default := v_current.anchor_day = extract(day from v_current.plan_start_date)::smallint;
  v_new_anchor := case when v_old_anchor_matched_default
    then extract(day from p_new_start_date)::smallint
    else v_current.anchor_day
  end;

  update public.subscription_versions
  set plan_start_date = p_new_start_date,
      effective_from = p_new_start_date,
      anchor_day = v_new_anchor
  where id = v_current.id;

  perform public._subscription_cover_existing_future_registrations(p_subscription_id);

  return json_build_object('ok', true, 'plan_start_date', p_new_start_date, 'anchor_day', v_new_anchor);
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
  v_ver record;
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

  -- Date-eligibility check. First, the version actually effective at paid_at, if any.
  select v.* into v_ver
  from public.subscription_versions v
  where v.subscription_id = v_sub.id
    and v.effective_from <= v_paid_at
    and (v.effective_to is null or v.effective_to > v_paid_at)
  order by v.effective_from desc
  limit 1;

  if not found then
    -- No version covers paid_at. If paid_at is before the subscription has even started
    -- (effective_from in the future relative to paid_at), this is a legitimate advance payment --
    -- not stopped, not completed, just not started yet as of that date (an established, already-
    -- relied-upon case: record_subscription_payment is called with no payment date, i.e. today,
    -- against a subscription whose plan_start_date is in the future -- see
    -- 189_subscription_delete_payment_guard_tests.sh scenarios 3/4). Fall back to the EARLIEST
    -- version so a stop applied in advance (unusual but representable) still correctly blocks it.
    select v.* into v_ver
    from public.subscription_versions v
    where v.subscription_id = v_sub.id
      and v.effective_from > v_paid_at
    order by v.effective_from asc
    limit 1;

    if not found then
      -- paid_at is after every version's window: the subscription had already fully ended by
      -- paid_at with nothing covering it. Genuinely ineligible.
      return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
    end if;
  end if;

  if v_ver.stopped_effective_date is not null and v_paid_at >= v_ver.stopped_effective_date then
    return json_build_object('ok', false, 'error', 'subscription_not_eligible_for_date');
  end if;

  if v_ver.plan_end_date is not null and v_paid_at > public.subscription_shifted_date(v_sub.id, v_ver.plan_end_date) then
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

-- ---------------------------------------------------------------------------
-- Athlete read model.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_subscription()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_sub public.subscriptions%rowtype;
  v_version public.subscription_versions%rowtype;
  v_today date := public._studio_today_date();
  v_week_start date := v_today - extract(dow from v_today)::int;
  v_next_week_start date := v_week_start + 7;
  v_next_billing_date date;
  v_effective_plan_end_date date;
  v_current_freeze jsonb;
  v_upcoming_freeze jsonb;
  v_allowances jsonb;
  v_tiers public.subscription_tier[];
  v_usage jsonb;
  v_this_extra jsonb;
  v_next_usage jsonb;
  v_is_scheduled boolean;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- The running subscription if there is one, else the next one to start.
  select s.* into v_sub
  from public.subscriptions s
  join public.subscription_versions cv on cv.subscription_id = s.id and cv.effective_to is null
  where s.payee_id = v_uid
    and s.payee_is_manual = false
    and s.deleted_at is null
    and public.subscription_version_display_status(cv.id, v_today) not in ('stopped', 'completed')
  order by (public.subscription_version_display_status(cv.id, v_today) = 'scheduled') asc, cv.plan_start_date asc
  limit 1;

  if not found then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

  select v.* into v_version
  from public.subscription_versions v
  where v.subscription_id = v_sub.id and v.effective_to is null
  limit 1;

  if not found then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

  v_is_scheduled := public.subscription_version_display_status(v_version.id, v_today) = 'scheduled';

  v_next_billing_date := public.subscription_effective_next_billing_date(v_sub.id);
  v_effective_plan_end_date := public.subscription_effective_plan_end_date(v_version.id);

  select to_jsonb(f) - 'id' - 'subscription_id' - 'created_by' - 'created_at' - 'cancelled_at'
  into v_current_freeze
  from public.subscription_freezes f
  where f.subscription_id = v_sub.id
    and f.cancelled_at is null
    and v_today between f.freeze_from and f.freeze_until
  limit 1;

  select to_jsonb(f) - 'id' - 'subscription_id' - 'created_by' - 'created_at' - 'cancelled_at'
  into v_upcoming_freeze
  from public.subscription_freezes f
  where f.subscription_id = v_sub.id
    and f.cancelled_at is null
    and f.freeze_from > v_today
  order by f.freeze_from asc
  limit 1;

  select coalesce(jsonb_object_agg(a.tier::text, a.weekly_limit), '{}'::jsonb)
  into v_allowances
  from public.subscription_version_allowances a
  where a.version_id = v_version.id and a.weekly_limit > 0;

  -- This week: unchanged rows (current version's included tiers), each with `extra` added.
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', a.tier,
      'configured_weekly_limit', a.weekly_limit,
      'effective_weekly_limit', public._subscription_week_reported_limit(v_sub.payee_id, false, a.tier, v_week_start),
      'used', (
        select count(*)
        from public._subscription_week_slots(v_week_start, v_sub.payee_id, false) sl
        where sl.tier = a.tier and sl.covered and sl.occupies
      )
    )
    order by a.tier
  ), '[]'::jsonb)
  into v_usage
  from public.subscription_version_allowances a
  where a.version_id = v_version.id and a.weekly_limit > 0
    -- Before a subscription starts, this week has no allowance to report. Not "0 of 0, used up".
    and (not v_is_scheduled or public.subscription_effective_weekly_limit(v_sub.payee_id, false, a.tier, v_week_start) > 0);

  select array_agg(t order by t) into v_tiers from unnest(enum_range(null::public.subscription_tier)) t;
  v_this_extra := public._subscription_week_usage(v_sub.id, v_sub.payee_id, false, v_week_start, v_tiers);
  select coalesce(jsonb_agg(
    u.row || jsonb_build_object('extra', coalesce((
      select (e->>'extra')::int from jsonb_array_elements(v_this_extra) e where e->>'tier' = u.row->>'tier'
    ), 0))
    order by u.ord
  ), '[]'::jsonb)
  into v_usage
  from jsonb_array_elements(v_usage) with ordinality as u(row, ord);

  v_next_usage := public._subscription_week_usage(v_sub.id, v_sub.payee_id, false, v_next_week_start, v_tiers);

  return json_build_object(
    'ok', true,
    'has_subscription', true,
    'is_frozen', v_current_freeze is not null,
    'is_scheduled', v_is_scheduled,
    'monthly_price_ils', v_version.monthly_price_ils,
    'plan_start_date', v_version.plan_start_date,
    'plan_end_date', v_version.plan_end_date,
    'effective_plan_end_date', v_effective_plan_end_date,
    'has_no_end_date', v_version.has_no_end_date,
    'next_billing_date', v_next_billing_date,
    'current_freeze', v_current_freeze,
    'upcoming_freeze', v_upcoming_freeze,
    'week_start', v_week_start,
    'allowances', v_allowances,
    'weekly_usage', v_usage,
    'next_week', jsonb_build_object(
      'week_start', v_next_week_start,
      'week_end', v_next_week_start + 6,
      'usage', v_next_usage
    ) || public._subscription_week_days(v_sub.payee_id, false, v_next_week_start)
  );
end;
$function$;

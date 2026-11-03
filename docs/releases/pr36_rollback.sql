-- ROLLBACK for PR #36 (migrations 20261104100000..20261104105000). Generated from the definitions at main 65a1d62 and
-- tested on a disposable database. Use only with the owner's approval, after reading docs/releases/pr36-subscription-release.md.
--
-- Restores the previous function bodies, triggers and table policies. It does NOT remove what is harmless to keep: new
-- enum values (PostgreSQL cannot drop them), the corrections table, the new columns on subscription_freezes, and the
-- tighter grants for anon. It changes no payment, charge or coverage row.
begin;

drop trigger if exists subscription_reconcile_on_coverage_delete on public.subscription_registration_coverage;
drop trigger if exists subscription_reconcile_on_session_change on public.training_sessions;
drop trigger if exists subscription_charges_append_only on public.subscription_charges;
drop trigger if exists subscription_payment_cap_check on public.athlete_account_payments;

drop function if exists public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[], text);
drop function if exists public.manager_subscription_overview_breakdown();

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
    if public._payment_has_any_document('account', old.id) then
      raise exception 'account_payment_has_receipt_history'
        using errcode = 'P0001',
              detail = 'A receipt has been issued for this payment at some point (even if later cancelled); it cannot be deleted. Cancel-and-correct or reverse it instead.';
    end if;
    return old;
  end if;

  -- tg_op = 'UPDATE' from here.
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
$function$
;
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
      round(sum(a.amount_ils)::numeric, 2) as collected_account_ils
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
    coalesce(s.expected_ils, 0)::numeric as expected_ils,
    coalesce(s.collected_sessions_ils, 0)::numeric as collected_sessions_ils,
    coalesce(a.collected_account_ils, 0)::numeric as collected_account_ils,
    (coalesce(s.collected_sessions_ils, 0) + coalesce(a.collected_account_ils, 0))::numeric as collected_total_ils,
    round((
      coalesce(s.expected_ils, 0)
      - coalesce(s.collected_sessions_ils, 0)
      - coalesce(a.collected_account_ils, 0)
    )::numeric, 2) as outstanding_ils
  from ath_keys k
  left join sess_by_ath s on s.kind = k.kind and s.pid = k.pid
  left join acct_by_ath a on a.kind = k.kind and a.pid = k.pid;
$function$
;
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

  for r in
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
$function$
;
CREATE OR REPLACE FUNCTION public._subscription_week_usage(p_subscription_id uuid, p_payee_id uuid, p_payee_is_manual boolean, p_week_start date, p_tiers subscription_tier[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with counted as (
    select cov.tier, cov.covered
    from public.subscription_registration_coverage cov
    left join public.session_registrations reg on reg.id = cov.registration_id
    where cov.subscription_id = p_subscription_id
      and cov.week_start = p_week_start
      and (cov.covered = true or cov.non_coverage_reason in ('allowance_exceeded', 'frozen', 'tier_not_included'))
      and (
        cov.manual_participant_id is not null
        or reg.status = 'active'
        or exists (
          select 1 from public.cancellations c
          where c.session_id = reg.session_id and c.user_id = reg.user_id and c.charged_full_price is true
        )
      )
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
      public.subscription_effective_weekly_limit(p_payee_id, p_payee_is_manual, t.tier, p_week_start) as effective_weekly_limit,
      (select count(*) from counted c where c.tier = t.tier and c.covered) as used,
      (select count(*) from counted c where c.tier = t.tier and not c.covered) as extra,
      t.ord
    from unnest(p_tiers) with ordinality as t(tier, ord)
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', r.tier,
      'configured_weekly_limit', r.configured_weekly_limit,
      'effective_weekly_limit', r.effective_weekly_limit,
      'used', r.used,
      'extra', r.extra
    ) order by r.ord
  ), '[]'::jsonb)
  from rows r
  where r.configured_weekly_limit > 0 or r.effective_weekly_limit > 0 or r.used > 0 or r.extra > 0;
$function$
;
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
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$function$
;
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

  return json_build_object('ok', true, 'plan_start_date', p_new_start_date, 'anchor_day', v_new_anchor);
end;
$function$
;
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

  return json_build_object(
    'ok', true, 'subscription_id', v_subscription_id, 'version_id', v_version_id,
    'payment_id', v_payment_id
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.delete_subscription(p_subscription_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_deleted_at timestamptz;
  v_has_payment boolean;
  v_source_id uuid;
  v_reversed_count int := 0;
  v_reversed_total numeric(12, 2) := 0;
  r record;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select deleted_at into v_deleted_at
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  -- Idempotent no-op: never re-check payments or re-reverse charges on a repeated call.
  if v_deleted_at is not null then
    return json_build_object('ok', true, 'action', 'already_deleted');
  end if;

  -- The owner-approved rule: ANY valid (unreversed) payment -- including a partial one -- blocks
  -- deletion outright. Nothing is modified when this fires: no charge touched, no payment touched,
  -- the subscription itself untouched. The caller should offer stop_subscription instead.
  select exists (
    select 1 from public.athlete_account_payments a
    where a.source_subscription_id = p_subscription_id
      and a.reversed_at is null
  ) into v_has_payment;

  if v_has_payment then
    return json_build_object('ok', false, 'error', 'subscription_has_payments');
  end if;

  v_source_id := gen_random_uuid();

  -- Reverse every currently-effective charge (any charge_type -- recurring, proration,
  -- freeze_credit, stop_proration, edit_correction -- whichever haven't already been reversed by
  -- an earlier stop/freeze/edit correction) so this subscription contributes exactly zero to
  -- outstanding debt everywhere it's read from (manager_subscription_overview_stats,
  -- _period_merged_athlete_finance, get_subscription_detail). The original charge rows are never
  -- altered -- only a new `reversal` row is appended per charge, linked via `reverses`, same
  -- append-only discipline as every other correction path.
  for r in
    select c.id, c.billing_period_id, c.subscription_id, c.payee_id, c.payee_is_manual, c.amount_ils
    from public.subscription_charges c
    where c.subscription_id = p_subscription_id
      and c.charge_type <> 'reversal'
      and not exists (
        select 1 from public.subscription_charges rv
        where rv.charge_type = 'reversal' and rv.reverses = c.id
      )
  loop
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses, source_event_id
    ) values (
      r.billing_period_id, r.subscription_id, r.payee_id, r.payee_is_manual,
      -r.amount_ils, 'reversal', r.id, v_source_id
    );
    v_reversed_count := v_reversed_count + 1;
    v_reversed_total := v_reversed_total + r.amount_ils;
  end loop;

  update public.subscriptions set deleted_at = now() where id = p_subscription_id and deleted_at is null;

  return json_build_object(
    'ok', true, 'action', 'tombstoned',
    'reversed_charge_count', v_reversed_count,
    'reversed_total_ils', v_reversed_total
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.delete_subscription_with_future_registrations(p_subscription_id uuid, p_future_registration_action text DEFAULT NULL::text, p_confirmed boolean DEFAULT false, p_expected_future_registration_ids uuid[] DEFAULT NULL::uuid[], p_expected_future_manual_participant_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_deleted_at timestamptz;
  v_has_payment boolean;
  v_source_id uuid;
  v_reversed_count int := 0;
  v_reversed_total numeric(12, 2) := 0;
  v_cutoff date;
  v_future_impact jsonb;
  v_future_resolved int := 0;
  r record;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_future_registration_action is not null and p_future_registration_action not in ('remove', 'charge_regular_price') then
    return json_build_object('ok', false, 'error', 'invalid_future_registration_action');
  end if;

  perform pg_advisory_xact_lock(public.subscription_admin_lock_key(p_subscription_id));

  select deleted_at into v_deleted_at
  from public.subscriptions
  where id = p_subscription_id;

  if not found then
    return json_build_object('ok', false, 'error', 'subscription_not_found');
  end if;

  -- Idempotent no-op: never re-check payments or re-reverse charges on a repeated call.
  if v_deleted_at is not null then
    return json_build_object('ok', true, 'action', 'already_deleted');
  end if;

  -- The owner-approved rule: ANY valid (unreversed) payment -- including a partial one -- blocks
  -- deletion outright. Nothing is modified when this fires: no charge touched, no payment touched,
  -- the subscription itself untouched. The caller should offer stop instead.
  select exists (
    select 1 from public.athlete_account_payments a
    where a.source_subscription_id = p_subscription_id
      and a.reversed_at is null
  ) into v_has_payment;

  if v_has_payment then
    return json_build_object('ok', false, 'error', 'subscription_has_payments');
  end if;

  -- Deletion is immediate (unlike a scheduled stop date): the cutoff for "future" is today.
  v_cutoff := public._studio_today_date();
  v_future_impact := public.subscription_future_registrations_impact(p_subscription_id, v_cutoff);

  if jsonb_array_length(v_future_impact) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object(
      'ok', true, 'action', 'preview',
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

  -- (2) Preview/confirm staleness guard -- see stop_subscription_with_future_registrations for the
  -- full rationale. Runs before anything is mutated (including the payment-block/charge-reversal
  -- steps below), so a mismatch aborts the whole deletion, not just the future-registration part.
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

  v_source_id := gen_random_uuid();

  -- Reverse every currently-effective charge (any charge_type -- recurring, proration,
  -- freeze_credit, stop_proration, edit_correction -- whichever haven't already been reversed by
  -- an earlier stop/freeze/edit correction) so this subscription contributes exactly zero to
  -- outstanding debt everywhere it's read from (manager_subscription_overview_stats,
  -- _period_merged_athlete_finance, get_subscription_detail). The original charge rows are never
  -- altered -- only a new `reversal` row is appended per charge, linked via `reverses`, same
  -- append-only discipline as every other correction path.
  for r in
    select c.id, c.billing_period_id, c.subscription_id, c.payee_id, c.payee_is_manual, c.amount_ils
    from public.subscription_charges c
    where c.subscription_id = p_subscription_id
      and c.charge_type <> 'reversal'
      and not exists (
        select 1 from public.subscription_charges rv
        where rv.charge_type = 'reversal' and rv.reverses = c.id
      )
  loop
    insert into public.subscription_charges (
      billing_period_id, subscription_id, payee_id, payee_is_manual, amount_ils, charge_type, reverses, source_event_id
    ) values (
      r.billing_period_id, r.subscription_id, r.payee_id, r.payee_is_manual,
      -r.amount_ils, 'reversal', r.id, v_source_id
    );
    v_reversed_count := v_reversed_count + 1;
    v_reversed_total := v_reversed_total + r.amount_ils;
  end loop;

  update public.subscriptions set deleted_at = now() where id = p_subscription_id and deleted_at is null;

  if p_future_registration_action is not null then
    v_future_resolved := public._subscription_resolve_future_registrations(
      p_subscription_id, v_cutoff, p_future_registration_action
    );
  end if;

  return json_build_object(
    'ok', true, 'action', 'tombstoned',
    'reversed_charge_count', v_reversed_count,
    'reversed_total_ils', v_reversed_total,
    'future_registrations_resolved', v_future_resolved
  );
end;
$function$
;
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
    if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
               and action_type = 'edit' and action_source_id = v_source_id and confirmed = true) then
      return json_build_object('ok', true, 'action', 'already_applied');
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

    return json_build_object('ok', true, 'action', 'applied', 'version_id', v_new_version_id, 'impact', v_impact);
  end;
end;
$function$
;
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

  v_impact := public.subscription_compute_impact(
    p_subscription_id, 'freeze', p_freeze_from, p_freeze_until
  );
  if not coalesce((v_impact->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', v_impact->>'error')::json;
  end if;

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_source_id := md5(p_subscription_id::text || '|freeze|' || p_freeze_from::text || '|' || p_freeze_until::text)::uuid;

  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'freeze' and action_source_id = v_source_id and confirmed = true) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  begin
    insert into public.subscription_freezes (subscription_id, freeze_from, freeze_until, created_by)
    values (p_subscription_id, p_freeze_from, p_freeze_until, v_uid)
    returning id into v_freeze_id;
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
      and bp.raw_period_end >= p_freeze_from
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

  v_next_billing_date := public.subscription_effective_next_billing_date(p_subscription_id);
  v_effective_plan_end_date := public.subscription_effective_plan_end_date(v_version_id);

  return json_build_object(
    'ok', true, 'action', 'applied', 'freeze_id', v_freeze_id, 'impact', v_impact,
    'frozen_days', (p_freeze_until - p_freeze_from + 1),
    'next_billing_date', v_next_billing_date,
    'effective_plan_end_date', v_effective_plan_end_date
  );
end;
$function$
;
CREATE OR REPLACE FUNCTION public.generate_due_subscription_charges()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := public._studio_today_date();
  r record;
  v_last_raw_start date;
  v_next_raw_start date;
  v_next_raw_end date;
  v_effective_start date;
  v_effective_plan_end date;
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
      v_effective_plan_end := public.subscription_effective_plan_end_date(r.version_id);
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

        select bp.raw_period_start into v_last_raw_start
        from public.subscription_billing_periods bp
        where bp.subscription_id = r.subscription_id
        order by bp.raw_period_start desc
        limit 1;

        if v_last_raw_start is null then
          v_next_raw_start := r.plan_start_date;
        else
          v_next_raw_start := public.subscription_next_anchor_date(r.anchor_day, v_last_raw_start);
        end if;

        v_next_raw_end := public.subscription_next_anchor_date(r.anchor_day, v_next_raw_start);
        v_effective_start := v_next_raw_start + public.subscription_total_frozen_days(r.subscription_id, v_next_raw_end);

        exit when v_effective_start > v_today;
        exit when r.stopped_effective_date is not null and v_effective_start >= r.stopped_effective_date;
        exit when v_effective_plan_end is not null and v_effective_start > v_effective_plan_end;

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
$function$
;
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
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  select s.* into v_sub
  from public.subscriptions s
  where s.payee_id = v_uid
    and s.payee_is_manual = false
    and s.deleted_at is null
  order by s.created_at desc
  limit 1;

  if not found then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

  select v.* into v_version
  from public.subscription_versions v
  where v.subscription_id = v_sub.id and v.effective_to is null
  limit 1;

  if not found or public.subscription_version_display_status(v_version.id, v_today) in ('stopped', 'completed') then
    return json_build_object('ok', true, 'has_subscription', false);
  end if;

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
      'effective_weekly_limit', public.subscription_effective_weekly_limit(v_sub.payee_id, false, a.tier, v_week_start),
      'used', coalesce((
        select count(*)
        from public.subscription_registration_coverage cov
        left join public.session_registrations reg on reg.id = cov.registration_id
        where cov.subscription_id = v_sub.id
          and cov.tier = a.tier
          and cov.week_start = v_week_start
          and cov.covered = true
          and (
            cov.manual_participant_id is not null
            or reg.status = 'active'
            or exists (
              select 1 from public.cancellations c
              where c.session_id = reg.session_id
                and c.user_id = reg.user_id
                and c.charged_full_price is true
            )
          )
      ), 0)
    )
    order by a.tier
  ), '[]'::jsonb)
  into v_usage
  from public.subscription_version_allowances a
  where a.version_id = v_version.id and a.weekly_limit > 0;

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
$function$
;
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
  if v_pay.source_subscription_id is not null then return jsonb_build_object('ok', false, 'error', 'linked_to_subscription'); end if;
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
$function$
;
CREATE OR REPLACE FUNCTION public.manager_subscription_overview_breakdown()
 RETURNS TABLE(subscription_id uuid, payee_id uuid, payee_is_manual boolean, payee_display_name text, display_status text, is_deleted boolean, plan_start_date date, plan_end_date date, has_no_end_date boolean, charges_total_ils numeric, payments_total_ils numeric, outstanding_ils numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    coalesce(charges.total, 0) - coalesce(payments.total, 0)
  from public.subscriptions s
  join public.subscription_versions v on v.subscription_id = s.id and v.effective_to is null
  left join public.profiles p on not s.payee_is_manual and p.user_id = s.payee_id
  left join public.manual_participants mp on s.payee_is_manual and mp.id = s.payee_id
  -- Unfiltered by charge_type -- see migration comment above (same fix as
  -- manager_subscription_overview_stats, for the same reason: a reversed/corrected charge
  -- must net to its true effect, not be silently dropped from the lifetime total).
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
$function$
;
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

  return json_build_object(
    'ok', true,
    'active_subscriptions_count', v_active_count,
    'charges_total_ils', v_charges_total,
    'payments_total_ils', v_payments_total,
    'outstanding_ils', v_lifetime_charges - v_lifetime_payments
  );
end;
$function$
;
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
      select reg.session_id, coalesce(public._mws_price(s.id, reg.user_id, null), 0)::numeric as exp_amt
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is true
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
      union all
      select m.session_id, coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is true
      union all
      select reg.session_id, coalesce(public._mws_price(s.id, reg.user_id, null), 0)::numeric
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where s.session_date between v_start and v_end
        and reg.status = 'active'
        and reg.attended is false
        and reg.charge_no_show is true
        and (v_is_super or not public.is_registration_hidden(reg.session_id, reg.user_id))
      union all
      select m.session_id, coalesce(public._mws_price(s.id, null, m.manual_participant_id), 0)::numeric
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where s.session_date between v_start and v_end
        and m.attended is false
        and m.charge_no_show is true
      union all
      select c.session_id, coalesce(public._mws_price(s.id, c.user_id, null), 0)::numeric
      from public.cancellations c
      join public.training_sessions s on s.id = c.session_id
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
$function$
;
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
    v_new_sub_id, 1, p_start_date, v_src_version.monthly_price_ils, v_src_version.anchor_day,
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
      public.subscription_next_anchor_date(v_src_version.anchor_day, p_start_date),
      null, null
    );
  end if;

  return json_build_object('ok', true, 'subscription_id', v_new_sub_id, 'version_id', v_new_version_id);
end;
$function$
;
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

  if v_ver.plan_end_date is not null and v_paid_at > v_ver.plan_end_date then
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
$function$
;
CREATE OR REPLACE FUNCTION public.stop_subscription(p_subscription_id uuid, p_stop_date date, p_confirmed boolean DEFAULT false)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_current public.subscription_versions%rowtype;
  v_impact jsonb;
  r record;
  v_source_id uuid;
begin
  if v_uid is null or not public.is_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_stop_date is null then
    return json_build_object('ok', false, 'error', 'stop_date_required');
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

  if coalesce((v_impact->>'count')::int, 0) > 0 and not coalesce(p_confirmed, false) then
    return json_build_object('ok', true, 'action', 'preview', 'impact', v_impact);
  end if;

  v_source_id := md5(p_subscription_id::text || '|stop|' || p_stop_date::text)::uuid;

  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'stop' and action_source_id = v_source_id and confirmed = true) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  update public.subscription_versions
  set stopped_effective_date = p_stop_date
  where id = v_current.id and stopped_effective_date is distinct from p_stop_date;

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

  insert into public.subscription_impact_events (
    subscription_id, action_type, action_source_id, effective_date, confirmed, created_by
  ) values (
    p_subscription_id, 'stop', v_source_id, p_stop_date, true, v_uid
  )
  on conflict (subscription_id, action_type, action_source_id) do update set confirmed = true;

  return json_build_object('ok', true, 'action', 'applied', 'impact', v_impact);
end;
$function$
;
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

  if exists (select 1 from public.subscription_impact_events where subscription_id = p_subscription_id
             and action_type = 'stop' and action_source_id = v_source_id and confirmed = true) then
    return json_build_object('ok', true, 'action', 'already_applied');
  end if;

  update public.subscription_versions
  set stopped_effective_date = p_stop_date
  where id = v_current.id and stopped_effective_date is distinct from p_stop_date;

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

  if p_future_registration_action is not null then
    v_future_resolved := public._subscription_resolve_future_registrations(
      p_subscription_id, p_stop_date, p_future_registration_action
    );
  end if;

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
$function$
;
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
    select v.plan_end_date + 1
    from public.subscription_versions v
    where v.subscription_id = p_subscription_id
      and v.plan_end_date is not null
      and v.plan_end_date + 1 > p_period_start and v.plan_end_date + 1 < p_period_end
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
      and (v.plan_end_date is null or s.segment_start <= v.plan_end_date)
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
$function$
;
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
          and bp.raw_period_end >= p_freeze_from
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
$function$
;
CREATE OR REPLACE FUNCTION public.subscription_effective_context(p_payee_id uuid, p_payee_is_manual boolean, p_session_date date, p_tier subscription_tier)
 RETURNS subscription_effective_context_result
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    and (v.plan_end_date is null or v.plan_end_date >= p_session_date)
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
$function$
;
CREATE OR REPLACE FUNCTION public.subscription_effective_next_billing_date(p_subscription_id uuid)
 RETURNS date
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_latest_end date;
  v_version public.subscription_versions%rowtype;
  v_raw_end date;
begin
  select bp.period_end into v_latest_end
  from public.subscription_billing_periods bp
  where bp.subscription_id = p_subscription_id
  order by bp.raw_period_start desc
  limit 1;

  if v_latest_end is not null then
    return v_latest_end;
  end if;

  -- No billing period generated yet (e.g. plan_start_date is still in the future, or the daily job
  -- simply hasn't run yet today): compute the hypothetical first period's effective end the exact
  -- same way subscription_generate_or_correct_billing_period will, when it eventually runs.
  select * into v_version from public.subscription_versions
  where subscription_id = p_subscription_id and effective_to is null;
  if not found then
    return null;
  end if;

  v_raw_end := public.subscription_next_anchor_date(v_version.anchor_day, v_version.plan_start_date);
  return v_raw_end + public.subscription_total_frozen_days(p_subscription_id, v_raw_end);
end;
$function$
;
CREATE OR REPLACE FUNCTION public.subscription_effective_plan_end_date(p_version_id uuid)
 RETURNS date
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when v.plan_end_date is null then null
    else v.plan_end_date + public.subscription_total_frozen_days(v.subscription_id, v.plan_end_date)
  end
  from public.subscription_versions v
  where v.id = p_version_id;
$function$
;
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

  v_frozen_days := public.subscription_total_frozen_days(p_subscription_id, p_raw_period_end);
  v_period_start := p_raw_period_start + v_frozen_days;
  v_period_end := p_raw_period_end + v_frozen_days;

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
$function$
;
CREATE OR REPLACE FUNCTION public.subscription_reconcile_week(p_subscription_id uuid, p_week_start date, p_tier subscription_tier)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_payee_id uuid;
  v_payee_is_manual boolean;
  v_lock_key bigint;
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

  v_lock_key := public.subscription_lock_key(v_payee_id, v_payee_is_manual, p_week_start, p_tier);
  perform pg_advisory_xact_lock(v_lock_key);

  if not v_payee_is_manual then
    -- Gather predicate widened to match subscription_reserve_or_reject's "live" definition:
    -- any active registration (regardless of attended — a future, not-yet-attended booking still
    -- legitimately holds its reserved slot) or a cancelled-but-charged-full-price registration.
    -- Previously this required attended = true (or a charged no-show), which dropped live future
    -- reservations from the count — the root cause fixed by this migration.
    for r in
      select reg.id as registration_id, reg.registered_at as created_at, s.session_date
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where reg.user_id = v_payee_id
        and s.session_date between p_week_start and p_week_start + 6
        and public.subscription_tier_for_capacity(s.max_participants) = p_tier
        and (
          reg.status = 'active'
          or exists (
            select 1 from public.cancellations c
            where c.session_id = reg.session_id
              and c.user_id = reg.user_id
              and c.charged_full_price is true
          )
        )
      order by reg.registered_at asc, reg.id asc
    loop
      v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);

      if v_ctx.subscription_id is null or not v_ctx.in_window then
        v_covered := false;
        v_reason := 'not_subscribed';
      elsif v_ctx.is_frozen then
        v_covered := false;
        v_reason := 'frozen';
      elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
        v_covered := false;
        v_reason := 'tier_not_included';
      elsif v_covered_count < v_ctx.weekly_limit then
        v_covered := true;
        v_reason := null;
        v_covered_count := v_covered_count + 1;
      else
        v_covered := false;
        v_reason := 'allowance_exceeded';
      end if;

      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        p_subscription_id, v_ctx.version_id, r.registration_id, null,
        r.session_date, p_week_start, p_tier, v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (registration_id) where registration_id is not null do update set
        version_id = excluded.version_id,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where public.subscription_registration_coverage.covered is distinct from excluded.covered
         or public.subscription_registration_coverage.non_coverage_reason is distinct from excluded.non_coverage_reason
         or public.subscription_registration_coverage.version_id is distinct from excluded.version_id;
    end loop;
  else
    -- A removed manual participant is a hard DELETE (cascades to its coverage row via FK), so mere
    -- row existence already means "live" — no attended-based filter belongs here either, for the
    -- same reason as the app-registration branch above.
    for r in
      select m.id as registration_id, m.added_at as created_at, s.session_date
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where m.manual_participant_id = v_payee_id
        and s.session_date between p_week_start and p_week_start + 6
        and public.subscription_tier_for_capacity(s.max_participants) = p_tier
      order by m.added_at asc, m.id asc
    loop
      v_ctx := public.subscription_effective_context(v_payee_id, v_payee_is_manual, r.session_date, p_tier);

      if v_ctx.subscription_id is null or not v_ctx.in_window then
        v_covered := false;
        v_reason := 'not_subscribed';
      elsif v_ctx.is_frozen then
        v_covered := false;
        v_reason := 'frozen';
      elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
        v_covered := false;
        v_reason := 'tier_not_included';
      elsif v_covered_count < v_ctx.weekly_limit then
        v_covered := true;
        v_reason := null;
        v_covered_count := v_covered_count + 1;
      else
        v_covered := false;
        v_reason := 'allowance_exceeded';
      end if;

      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        p_subscription_id, v_ctx.version_id, null, r.registration_id,
        r.session_date, p_week_start, p_tier, v_covered, v_reason, now(), 'reconcile'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        version_id = excluded.version_id,
        covered = excluded.covered,
        non_coverage_reason = excluded.non_coverage_reason,
        decided_at = now(),
        decided_by = 'reconcile'
      where public.subscription_registration_coverage.covered is distinct from excluded.covered
         or public.subscription_registration_coverage.non_coverage_reason is distinct from excluded.non_coverage_reason
         or public.subscription_registration_coverage.version_id is distinct from excluded.version_id;
    end loop;
  end if;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.subscription_reserve_or_reject(p_payee_id uuid, p_payee_is_manual boolean, p_session_id uuid, p_accept_extra boolean DEFAULT false)
 RETURNS subscription_reserve_decision
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    from public.subscription_registration_coverage cov
    left join public.session_registrations reg on reg.id = cov.registration_id
    where cov.subscription_id = v_ctx.subscription_id
      and cov.tier = v_tier
      and cov.week_start = v_week_start
      and cov.covered = true
      and (
        cov.manual_participant_id is not null
        or reg.status = 'active'
        or exists (
          select 1 from public.cancellations c
          where c.session_id = reg.session_id
            and c.user_id = reg.user_id
            and c.charged_full_price is true
        )
      );

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
$function$
;
CREATE OR REPLACE FUNCTION public.subscription_version_display_status(p_version_id uuid, p_as_of_date date DEFAULT CURRENT_DATE)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if v.plan_end_date is not null and p_as_of_date > v.plan_end_date then
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
$function$
;

revoke all on function public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[]) from public, anon;
grant execute on function public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[]) to authenticated;
grant execute on function public.manager_subscription_overview_breakdown() to authenticated;

-- Functions the release added. _subscription_corrections_guard stays with the corrections table it protects.
drop function if exists public._subscription_apply_unfreeze;
drop function if exists public._subscription_charges_append_only;
drop function if exists public._subscription_cover_existing_future_registrations;
drop function if exists public._subscription_delete_history;
drop function if exists public._subscription_delete_impact_json;
drop function if exists public._subscription_integrity_check;
drop function if exists public._subscription_next_charge;
drop function if exists public._subscription_outstanding;
drop function if exists public._subscription_payment_cap_check;
drop function if exists public._subscription_payment_eligible;
drop function if exists public._subscription_reconcile_after_coverage_delete;
drop function if exists public._subscription_reconcile_after_session_change;
drop function if exists public._subscription_settlement_only;
drop function if exists public._subscription_slot_state;
drop function if exists public._subscription_week_slots;
drop function if exists public.manager_list_subscription_corrections;
drop function if exists public.manager_resolve_subscription_correction;
drop function if exists public.manager_subscription_week_utilization;
drop function if exists public.subscription_delete_impact;
drop function if exists public.subscription_payment_target;
drop function if exists public.subscription_shifted_date;
drop function if exists public.unfreeze_subscription;

do $$
declare
  t text;
begin
  foreach t in array array[
    'subscriptions', 'subscription_versions', 'subscription_version_allowances', 'subscription_billing_periods',
    'subscription_charges', 'subscription_freezes', 'subscription_registration_coverage',
    'subscription_impact_events', 'subscription_impact_event_registrations'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_manager_select', t);
    execute format('create policy %I on public.%I for all using (public.is_manager(auth.uid())) with check (public.is_manager(auth.uid()))', t || '_manager_all', t);
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

commit;

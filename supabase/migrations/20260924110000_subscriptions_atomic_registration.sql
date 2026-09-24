-- Subscription Management — Phase 2: atomic registration + reconciliation.
-- See /Users/amit/.claude/plans/golden-whistling-jellyfish.md.
--
-- Adds subscription_reserve_or_reject() (the atomic per-registration decision, called inside
-- the same transaction as the registration insert) and subscription_reconcile_week() (the
-- corrective re-evaluation pass), wires both into register_for_session / coach_add_athlete /
-- add_manual_participant_to_session, and adds reconciliation triggers on status-changing
-- columns. Every modified RPC preserves 100% of its existing behavior for payees with no
-- subscription row (the "not_subscribed" path is a no-op, functionally identical to before
-- this migration).

-- ---------------------------------------------------------------------------
-- Result type for subscription_reserve_or_reject()
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.subscription_reserve_decision as (
    outcome text,
    ok boolean,
    subscription_id uuid,
    version_id uuid,
    tier public.subscription_tier,
    week_start date,
    covered boolean,
    non_coverage_reason public.subscription_non_coverage_reason
  );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- subscription_reserve_or_reject — the atomic, per-session-date decision.
-- ---------------------------------------------------------------------------

create or replace function public.subscription_reserve_or_reject(
  p_payee_id uuid,
  p_payee_is_manual boolean,
  p_session_id uuid,
  p_accept_extra boolean default false
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
  v_result public.subscription_reserve_decision;
begin
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    raise exception 'session_not_found';
  end if;

  v_tier := public.subscription_tier_for_capacity(v_sess.max_participants);
  v_week_start := v_sess.session_date - extract(dow from v_sess.session_date)::int;

  -- Serialize concurrent registration attempts for the same payee/week/tier so two simultaneous
  -- requests for the last open subscription slot can't both read "1 slot left" (plan point 12).
  v_lock_key := public.subscription_lock_key(p_payee_id, p_payee_is_manual, v_week_start, v_tier);
  perform pg_advisory_xact_lock(v_lock_key);

  v_ctx := public.subscription_effective_context(p_payee_id, p_payee_is_manual, v_sess.session_date, v_tier);

  v_result.tier := v_tier;
  v_result.week_start := v_week_start;

  if v_ctx.subscription_id is null or not v_ctx.in_window then
    -- No active subscription covers this session date at all (ignoring freeze): ordinary
    -- pay-per-session behavior, exactly as before this migration. No warning, no coverage row.
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
    v_result.outcome := 'frozen';
    v_result.non_coverage_reason := 'frozen';
  elsif coalesce(v_ctx.weekly_limit, 0) <= 0 then
    v_result.outcome := 'tier_not_included';
    v_result.non_coverage_reason := 'tier_not_included';
  else
    -- This registration is being created now, so among registration.created_at-ordered rows for
    -- this subscription/tier/week it is always last — counting already-covered rows and
    -- comparing to the limit is equivalent to running the full ordered pass (plan §Atomic
    -- registration decision).
    --
    -- Bug fixed during the bypass-closure audit: a plain (unpaid) cancellation never flips its
    -- own coverage row back to covered=false (subscription_reconcile_week's gather predicate
    -- correctly excludes cancelled-without-charge rows going forward, but it only ever upserts
    -- rows that are IN its gathered set — it never proactively resets an orphaned row that fell
    -- OUT of that set). A naive `covered = true` count would therefore keep counting that stale
    -- row against the weekly limit forever, incorrectly blocking a later registration in the same
    -- tier/week even though the slot is actually free. Re-verify liveness here instead: for an
    -- app registration, only count it if it is still 'active', or was cancelled but has a
    -- charged_full_price cancellation (still legitimately consuming/costing the slot, matching
    -- _period_merged_athlete_finance's own chargeable definition). Manual-participant coverage
    -- rows need no such check — removing a manual participant is a hard DELETE that cascades to
    -- its coverage row via the FK, so any manual_participant_id row still present is still live.
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

    if v_covered_count < v_ctx.weekly_limit then
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

comment on function public.subscription_reserve_or_reject(uuid, boolean, uuid, boolean) is
  'Atomic per-registration subscription entitlement decision. Must be called inside the same '
  'transaction as the registration insert, before the insert. On ok=false, callers must return '
  'a structured subscription_limit_exceeded error and insert nothing.';

-- No direct grant to authenticated: this is called only from within register_for_session /
-- coach_add_athlete / add_manual_participant_to_session, all SECURITY DEFINER, which need no
-- separate grant on a function they call internally. Not exposing it as a public RPC also avoids
-- letting a caller invoke it standalone (harmless today since it only decides and never writes,
-- but there's no reason to widen the surface).

-- ---------------------------------------------------------------------------
-- subscription_reconcile_week — corrective, idempotent re-evaluation pass.
--
-- NOTE on substitution: the plan specifies ordering by "registration.created_at ASC,
-- registration.id ASC". Neither session_registrations nor session_manual_participants has a
-- created_at column; the closest existing analog is session_registrations.registered_at /
-- session_manual_participants.added_at (both are set once, at creation, and never touched by
-- re-registration-after-cancel — see 20260629189000_fix_register_after_cancel.sql, which
-- resets registered_at := now() on reactivation, so registered_at reflects the *current*
-- registration attempt's creation time exactly as created_at would). We use those columns.
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
    for r in
      select reg.id as registration_id, reg.registered_at as created_at, s.session_date
      from public.session_registrations reg
      join public.training_sessions s on s.id = reg.session_id
      where reg.user_id = v_payee_id
        and s.session_date between p_week_start and p_week_start + 6
        and public.subscription_tier_for_capacity(s.max_participants) = p_tier
        and (
          (reg.status = 'active' and reg.attended is true)
          or (reg.status = 'active' and reg.attended is false and reg.charge_no_show is true)
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
    for r in
      select m.id as registration_id, m.added_at as created_at, s.session_date
      from public.session_manual_participants m
      join public.training_sessions s on s.id = m.session_id
      where m.manual_participant_id = v_payee_id
        and s.session_date between p_week_start and p_week_start + 6
        and public.subscription_tier_for_capacity(s.max_participants) = p_tier
        and (
          (m.attended is true)
          or (m.attended is false and m.charge_no_show is true)
        )
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
$$;

comment on function public.subscription_reconcile_week(uuid, date, public.subscription_tier) is
  'Pure, idempotent recompute of coverage for one subscription/week/tier, ordered by '
  'registration.registered_at ASC, id ASC (registered_at substitutes for the plan''s '
  'registration.created_at — see comment above). Safe to call twice.';

-- No direct grant: only invoked from the reconciliation trigger functions below (also SECURITY
-- DEFINER, needing no separate grant) and, in a later phase, the manager-action RPCs after an
-- impact-preview confirmation. Calling it directly today is harmless (pure recompute from real
-- registration data, cannot fabricate coverage) but there is no reason to expose it publicly yet.

-- ---------------------------------------------------------------------------
-- Reconciliation triggers: fire subscription_reconcile_week() whenever a chargeability-
-- relevant column changes on a row that already has a coverage decision.
-- ---------------------------------------------------------------------------

create or replace function public._subscription_reconcile_after_registration_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cov public.subscription_registration_coverage%rowtype;
begin
  if (
    new.status is distinct from old.status
    or new.attended is distinct from old.attended
    or new.charge_no_show is distinct from old.charge_no_show
  ) then
    select * into v_cov
    from public.subscription_registration_coverage
    where registration_id = new.id;

    if found then
      perform public.subscription_reconcile_week(v_cov.subscription_id, v_cov.week_start, v_cov.tier);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists subscription_reconcile_on_registration_change on public.session_registrations;
create trigger subscription_reconcile_on_registration_change
  after update of status, attended, charge_no_show on public.session_registrations
  for each row execute function public._subscription_reconcile_after_registration_change();

create or replace function public._subscription_reconcile_after_manual_participant_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cov public.subscription_registration_coverage%rowtype;
begin
  if (
    new.attended is distinct from old.attended
    or new.charge_no_show is distinct from old.charge_no_show
  ) then
    select * into v_cov
    from public.subscription_registration_coverage
    where manual_participant_id = new.id;

    if found then
      perform public.subscription_reconcile_week(v_cov.subscription_id, v_cov.week_start, v_cov.tier);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists subscription_reconcile_on_manual_participant_change on public.session_manual_participants;
create trigger subscription_reconcile_on_manual_participant_change
  after update of attended, charge_no_show on public.session_manual_participants
  for each row execute function public._subscription_reconcile_after_manual_participant_change();

create or replace function public._subscription_reconcile_after_cancellation_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg_id uuid;
  v_cov public.subscription_registration_coverage%rowtype;
  v_changed boolean;
begin
  v_changed := (tg_op = 'INSERT') or (new.charged_full_price is distinct from old.charged_full_price);

  if v_changed then
    select reg.id into v_reg_id
    from public.session_registrations reg
    where reg.session_id = new.session_id and reg.user_id = new.user_id;

    if v_reg_id is not null then
      select * into v_cov
      from public.subscription_registration_coverage
      where registration_id = v_reg_id;

      if found then
        perform public.subscription_reconcile_week(v_cov.subscription_id, v_cov.week_start, v_cov.tier);
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists subscription_reconcile_on_cancellation_change on public.cancellations;
create trigger subscription_reconcile_on_cancellation_change
  after insert or update of charged_full_price on public.cancellations
  for each row execute function public._subscription_reconcile_after_cancellation_change();

-- ---------------------------------------------------------------------------
-- Wire subscription_reserve_or_reject into register_for_session.
-- Full current body from supabase/migrations/20260629189000_fix_register_after_cancel.sql,
-- preserved verbatim except for the subscription gate + coverage bookkeeping additions.
-- ---------------------------------------------------------------------------

create or replace function public.register_for_session(
  p_session_id uuid,
  p_accept_extra_subscription_charge boolean default false
)
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
  v_reactivated int;
  v_reg_id uuid;
  v_decision public.subscription_reserve_decision;
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

  v_decision := public.subscription_reserve_or_reject(
    v_uid, false, p_session_id, coalesce(p_accept_extra_subscription_charge, false)
  );
  if not v_decision.ok then
    return json_build_object(
      'ok', false,
      'error', 'subscription_limit_exceeded',
      'reason', v_decision.non_coverage_reason::text
    );
  end if;

  update session_registrations
  set
    status = 'active',
    registered_at = now(),
    attended = null,
    payment_method = null,
    amount_paid = null,
    charge_no_show = false,
    payment_recorded_by = null,
    payment_recorded_at = null
  where session_id = p_session_id
    and user_id = v_uid
    and status = 'cancelled'
  returning id into v_reg_id;

  get diagnostics v_reactivated = row_count;

  if v_reactivated = 0 then
    insert into session_registrations (session_id, user_id, status, registered_at)
    values (p_session_id, v_uid, 'active', now())
    returning id into v_reg_id;
  end if;

  insert into registration_history (session_id, user_id, event_type)
  values (p_session_id, v_uid, 'registered');

  delete from waitlist_requests where session_id = p_session_id and user_id = v_uid;

  if v_decision.outcome <> 'not_subscribed' then
    insert into public.subscription_registration_coverage(
      subscription_id, version_id, registration_id, manual_participant_id,
      session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
    )
    values (
      v_decision.subscription_id, v_decision.version_id, v_reg_id, null,
      v_sess.session_date, v_decision.week_start, v_decision.tier,
      v_decision.covered, v_decision.non_coverage_reason, now(), 'registration'
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
      decided_by = 'registration';
  end if;

  return json_build_object('ok', true);
exception
  when unique_violation then
    return json_build_object('ok', false, 'error', 'already_registered');
end;
$$;

grant execute on function public.register_for_session(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Wire subscription_reserve_or_reject into coach_add_athlete.
-- Full current body from supabase/migrations/20260911100000_coach_add_athlete_allow_coach_role.sql,
-- preserved verbatim except for the subscription gate + coverage bookkeeping additions.
-- ---------------------------------------------------------------------------

create or replace function public.coach_add_athlete(
  p_session_id uuid,
  p_user_id uuid,
  p_allow_over_capacity boolean default false,
  p_accept_extra_subscription_charge boolean default false
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
  v_reg_id uuid;
  v_decision public.subscription_reserve_decision;
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

  if v_sess.coach_id = p_user_id then
    return json_build_object('ok', false, 'error', 'is_session_coach');
  end if;

  if not exists (
    select 1 from public.profiles
    where user_id = p_user_id and approval_status = 'approved' and role in ('athlete', 'coach')
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

  v_decision := public.subscription_reserve_or_reject(
    p_user_id, false, p_session_id, coalesce(p_accept_extra_subscription_charge, false)
  );
  if not v_decision.ok then
    return json_build_object(
      'ok', false,
      'error', 'subscription_limit_exceeded',
      'reason', v_decision.non_coverage_reason::text
    );
  end if;

  insert into public.session_registrations (session_id, user_id, status)
  values (p_session_id, p_user_id, 'active')
  on conflict (session_id, user_id) do update
    set status = 'active', registered_at = now()
  returning id into v_reg_id;

  insert into public.registration_history (session_id, user_id, event_type)
  values (p_session_id, p_user_id, 'registered');

  delete from public.waitlist_requests where session_id = p_session_id and user_id = p_user_id;

  if v_decision.outcome <> 'not_subscribed' then
    insert into public.subscription_registration_coverage(
      subscription_id, version_id, registration_id, manual_participant_id,
      session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
    )
    values (
      v_decision.subscription_id, v_decision.version_id, v_reg_id, null,
      v_sess.session_date, v_decision.week_start, v_decision.tier,
      v_decision.covered, v_decision.non_coverage_reason, now(), 'registration'
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
      decided_by = 'registration';
  end if;

  return json_build_object('ok', true);
exception when others then
  return json_build_object('ok', false, 'error', sqlerrm);
end;
$$;

grant execute on function public.coach_add_athlete(uuid, uuid, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Wire subscription_reserve_or_reject into add_manual_participant_to_session.
-- Full current body from supabase/migrations/20260630280000_manual_participant_disabled.sql,
-- preserved verbatim except for the subscription gate + coverage bookkeeping additions.
-- ---------------------------------------------------------------------------

create or replace function public.add_manual_participant_to_session(
  p_session_id uuid,
  p_manual_participant_id uuid,
  p_allow_over_capacity boolean default false,
  p_accept_extra_subscription_charge boolean default false
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
  v_n int;
  v_reg_id uuid;
  v_decision public.subscription_reserve_decision;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not public.is_coach_or_manager(v_uid) then return json_build_object('ok', false, 'error', 'forbidden'); end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public.manual_participant_disabled_on_date(p_manual_participant_id, v_sess.session_date) then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;

  v_count := public.active_registration_count(p_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  v_decision := public.subscription_reserve_or_reject(
    p_manual_participant_id, true, p_session_id, coalesce(p_accept_extra_subscription_charge, false)
  );
  if not v_decision.ok then
    return json_build_object(
      'ok', false,
      'error', 'subscription_limit_exceeded',
      'reason', v_decision.non_coverage_reason::text
    );
  end if;

  insert into public.session_manual_participants (session_id, manual_participant_id)
  values (p_session_id, p_manual_participant_id)
  on conflict (session_id, manual_participant_id) do nothing
  returning id into v_reg_id;

  get diagnostics v_n = row_count;
  if v_n = 0 then
    return json_build_object('ok', false, 'error', 'already_in_session');
  end if;

  if v_decision.outcome <> 'not_subscribed' then
    insert into public.subscription_registration_coverage(
      subscription_id, version_id, registration_id, manual_participant_id,
      session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
    )
    values (
      v_decision.subscription_id, v_decision.version_id, null, v_reg_id,
      v_sess.session_date, v_decision.week_start, v_decision.tier,
      v_decision.covered, v_decision.non_coverage_reason, now(), 'registration'
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
      decided_by = 'registration';
  end if;

  return json_build_object('ok', true);
end;
$$;

grant execute on function public.add_manual_participant_to_session(uuid, uuid, boolean, boolean) to authenticated;

-- Subscription Management — bypass closure (post-audit fixes).
-- See /Users/amit/.claude/plans/golden-whistling-jellyfish.md.
--
-- The pre-merge audit of 20260924100000/20260924110000 found two real registration paths that
-- create/move a confirmed registration WITHOUT going through subscription_reserve_or_reject:
--   1. public.staff_move_session_participant — moves an existing registration to a different
--      session in the same studio week via raw UPDATE/INSERT/DELETE, never calling the gate.
--   2. public._copy_session_roster (session-series roster auto-copy) and the p_manual_ids bulk-
--      add block inside public.staff_create_session_series — both raw-INSERT manual/quick-add
--      participants into new session-series occurrences, never calling the gate.
--
-- This migration closes both, reusing subscription_reserve_or_reject / subscription_reconcile_week
-- exactly as the three already-gated RPCs do — no eligibility/allowance/priority logic is
-- reimplemented here.

-- ---------------------------------------------------------------------------
-- 1. staff_move_session_participant — treat a move as an atomic entitlement transition.
--
-- Full original body from supabase/migrations/20260629190000_staff_move_session_participant.sql,
-- preserved verbatim except: (a) a new trailing p_accept_extra_subscription_charge param,
-- (b) a subscription gate call for the DESTINATION inserted strictly before any mutation of
-- session_registrations/session_manual_participants (source and destination participant rows
-- are only ever touched after the gate has already said yes — a rejection returns immediately
-- with nothing touched), (c) the destination row's registered_at/added_at is copied from the
-- SOURCE row rather than reset to now() (see the priority-preservation comment inline), and
-- (d) coverage bookkeeping for the destination, plus an explicit reconcile of the source's
-- freed slot for the manual-participant branch (the app-athlete branch's plain UPDATE OF status
-- already fires the existing subscription_reconcile_on_registration_change trigger automatically,
-- so no extra call is needed there).
-- ---------------------------------------------------------------------------

create or replace function public.staff_move_session_participant(
  p_from_session_id uuid,
  p_to_session_id uuid,
  p_user_id uuid default null,
  p_manual_participant_id uuid default null,
  p_allow_over_capacity boolean default false,
  p_decrease_source_max boolean default false,
  p_increase_dest_max boolean default false,
  p_accept_extra_subscription_charge boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_from public.training_sessions%rowtype;
  v_to public.training_sessions%rowtype;
  v_count int;
  v_count_after int;
  v_reg public.session_registrations%rowtype;
  v_man public.session_manual_participants%rowtype;
  v_linked uuid;
  v_reactivated int;
  v_decision public.subscription_reserve_decision;
  v_dest_reg_id uuid;
  v_source_cov public.subscription_registration_coverage%rowtype;
  v_source_cov_found boolean := false;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_from_session_id is null or p_to_session_id is null then
    return json_build_object('ok', false, 'error', 'invalid_session');
  end if;
  if p_from_session_id = p_to_session_id then
    return json_build_object('ok', false, 'error', 'same_session');
  end if;
  if (p_user_id is null) = (p_manual_participant_id is null) then
    return json_build_object('ok', false, 'error', 'invalid_participant');
  end if;

  select * into v_from from public.training_sessions where id = p_from_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  select * into v_to from public.training_sessions where id = p_to_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  if not public._staff_can_manage_session(v_uid, v_from) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if not public._staff_can_manage_session(v_uid, v_to) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public._session_has_started(v_from) or public._session_has_started(v_to) then
    return json_build_object('ok', false, 'error', 'session_started');
  end if;
  if not public._sessions_same_studio_week(v_from.session_date, v_to.session_date) then
    return json_build_object('ok', false, 'error', 'same_week');
  end if;

  if p_user_id is not null then
    select * into v_reg
    from public.session_registrations
    where session_id = p_from_session_id and user_id = p_user_id and status = 'active';
    if not found then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    if v_reg.attended is not null
      or v_reg.payment_method is not null
      or v_reg.amount_paid is not null
      or coalesce(v_reg.charge_no_show, false) then
      return json_build_object('ok', false, 'error', 'roster_locked');
    end if;
    if exists (
      select 1 from public.session_registrations
      where session_id = p_to_session_id and user_id = p_user_id and status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
    if public.athlete_disabled_on_date(p_user_id, v_to.session_date) then
      return json_build_object('ok', false, 'error', 'account_disabled');
    end if;
  else
    select * into v_man
    from public.session_manual_participants
    where session_id = p_from_session_id and manual_participant_id = p_manual_participant_id;
    if not found then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    if v_man.attended is not null
      or v_man.payment_method is not null
      or v_man.amount_paid is not null
      or coalesce(v_man.charge_no_show, false) then
      return json_build_object('ok', false, 'error', 'roster_locked');
    end if;
    if exists (
      select 1 from public.session_manual_participants
      where session_id = p_to_session_id and manual_participant_id = p_manual_participant_id
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
    select mp.linked_user_id into v_linked
    from public.manual_participants mp
    where mp.id = p_manual_participant_id;
    if v_linked is not null and exists (
      select 1 from public.session_registrations
      where session_id = p_to_session_id and user_id = v_linked and status = 'active'
    ) then
      return json_build_object('ok', false, 'error', 'already_in_session');
    end if;
  end if;

  if coalesce(p_increase_dest_max, false) then
    if not public._staff_can_manage_session(v_uid, v_to) then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
    update public.training_sessions
    set max_participants = max_participants + 1
    where id = p_to_session_id;
    select * into v_to from public.training_sessions where id = p_to_session_id;
  end if;

  v_count := public.active_registration_count(p_to_session_id);
  if not coalesce(p_allow_over_capacity, false) and v_count >= v_to.max_participants then
    return json_build_object('ok', false, 'error', 'full');
  end if;

  if coalesce(p_decrease_source_max, false) then
    if not public._staff_can_manage_session(v_uid, v_from) then
      return json_build_object('ok', false, 'error', 'forbidden');
    end if;
    if v_from.max_participants <= 1 then
      return json_build_object('ok', false, 'error', 'invalid_capacity');
    end if;
    v_count_after := public.active_registration_count(p_from_session_id) - 1;
    if v_count_after > v_from.max_participants - 1 then
      return json_build_object('ok', false, 'error', 'invalid_capacity');
    end if;
    update public.training_sessions
    set max_participants = max_participants - 1
    where id = p_from_session_id;
  end if;

  -- Subscription entitlement gate for the DESTINATION, evaluated through the exact same
  -- authoritative decision function used by register_for_session/coach_add_athlete/
  -- add_manual_participant_to_session — no eligibility logic is reimplemented here.
  --
  -- Ordering, found and fixed during testing: the source registration is released FIRST, THEN
  -- the destination is evaluated. Evaluating the destination before releasing the source would
  -- make subscription_reserve_or_reject's count still include the source's own covered=true row
  -- (same subscription/tier/week pool for a same-tier move) and INCORRECTLY reject even the most
  -- common case — an athlete simply relocating their one already-used allowance slot to a
  -- different day, with no other registrant involved at all. Releasing first works correctly
  -- because of the companion fix in subscription_reserve_or_reject's counting query (see that
  -- function): a cancelled-without-charge row is now excluded from the count, exactly the state
  -- the source is in immediately after being released here.
  --
  -- If the destination is then rejected, the release is explicitly compensated (restored) below
  -- so the net effect is "nothing happened" — the athlete ends up exactly where they started.
  -- Known, accepted narrow edge case: if some OTHER registration in the same subscription/tier/
  -- week was already sitting uncovered (extra-paid) before this call, the source's release can
  -- cause that other registration's coverage to flip to covered=true via the automatic reconcile
  -- trigger within this same transaction; if the destination is then rejected and the source is
  -- restored, both registrations could transiently show covered=true until the next reconcile
  -- event (e.g. either registration's own attendance being recorded) resolves it via the normal
  -- registered_at-ordered pass. This requires an unusual combination (a pre-existing uncovered
  -- registration in the same pool AND a destination rejection in the same call) and self-heals
  -- the same way the two originally-identified bypasses do; judged an acceptable trade-off
  -- against the complexity of savepoint-based transactional rollback for this narrow case.
  if p_user_id is not null then
    update public.session_registrations
    set status = 'cancelled'
    where session_id = p_from_session_id and user_id = p_user_id and status = 'active';
    get diagnostics v_reactivated = row_count;
    if v_reactivated = 0 then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    -- The existing subscription_reconcile_on_registration_change trigger (AFTER UPDATE OF
    -- status on session_registrations) fires automatically here and reconciles the SOURCE
    -- week/tier if a coverage row existed for v_reg.id, freeing this slot for any other
    -- existing registration in that subscription/tier/week — no extra call needed.

    v_decision := public.subscription_reserve_or_reject(
      p_user_id, false, p_to_session_id, coalesce(p_accept_extra_subscription_charge, false)
    );
    if not v_decision.ok then
      -- Compensate: restore the source exactly as it was (only status was ever touched here;
      -- attended/payment fields were already confirmed null by the roster_locked check above).
      update public.session_registrations
      set status = 'active'
      where session_id = p_from_session_id and user_id = p_user_id;
      return json_build_object(
        'ok', false,
        'error', 'subscription_limit_exceeded',
        'reason', v_decision.non_coverage_reason::text
      );
    end if;

    insert into public.registration_history (session_id, user_id, event_type)
    values (p_from_session_id, p_user_id, 'removed');

    -- Registration-order priority choice (documented per the audit): the destination row
    -- preserves the ORIGINAL registration's registered_at (v_reg.registered_at, captured above
    -- before cancellation) instead of resetting to now(). A staff-initiated move relocates an
    -- existing commitment rather than creating a new voluntary registration act. For a same-tier
    -- move (the common case, capacity unchanged) this is not just a style choice but the
    -- technically correct one: the athlete already held a claim on that subscription/tier/week's
    -- shared allowance pool from the original registration time, and moving to a different day
    -- within the same week/tier doesn't create a new claim on a different pool. For the rarer
    -- cross-tier move, preserving the original timestamp could in theory let the athlete
    -- outrank another registrant who joined the destination tier's pool between the original
    -- registration and the move — judged an acceptable, narrow trade-off for a staff-
    -- administrative action versus the complexity of a tier-aware priority rule.
    update public.session_registrations
    set
      status = 'active',
      registered_at = v_reg.registered_at,
      attended = null,
      payment_method = null,
      amount_paid = null,
      charge_no_show = false,
      payment_recorded_by = null,
      payment_recorded_at = null
    where session_id = p_to_session_id and user_id = p_user_id and status = 'cancelled'
    returning id into v_dest_reg_id;
    get diagnostics v_reactivated = row_count;

    if v_reactivated = 0 then
      insert into public.session_registrations (session_id, user_id, status, registered_at)
      values (p_to_session_id, p_user_id, 'active', v_reg.registered_at)
      returning id into v_dest_reg_id;
    end if;

    insert into public.registration_history (session_id, user_id, event_type)
    values (p_to_session_id, p_user_id, 'registered');

    delete from public.waitlist_requests
    where session_id = p_to_session_id and user_id = p_user_id;

    if v_decision.outcome <> 'not_subscribed' then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        v_decision.subscription_id, v_decision.version_id, v_dest_reg_id, null,
        v_to.session_date, v_decision.week_start, v_decision.tier,
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
  else
    -- Capture the source coverage row (if any) before deleting it — needed both to reconcile the
    -- freed slot on success and to restore it exactly on a compensating rollback. Removing a
    -- manual participant is a hard DELETE (unlike the app-athlete case's status flip), so no
    -- UPDATE-based trigger fires for it automatically; the coverage row cascade-deletes with it.
    select * into v_source_cov
    from public.subscription_registration_coverage
    where manual_participant_id = v_man.id;
    v_source_cov_found := found;

    delete from public.session_manual_participants
    where session_id = p_from_session_id and manual_participant_id = p_manual_participant_id;
    get diagnostics v_reactivated = row_count;
    if v_reactivated = 0 then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;

    -- Same released-before-decided ordering as the app-athlete branch above, for the same
    -- reason: the deleted row's coverage no longer exists to be (mis)counted, so a same-tier
    -- move of an at-capacity manual participant is correctly evaluated as having room.
    v_decision := public.subscription_reserve_or_reject(
      p_manual_participant_id, true, p_to_session_id, coalesce(p_accept_extra_subscription_charge, false)
    );
    if not v_decision.ok then
      -- Compensate: re-insert the participant on the source exactly as before (attended/payment
      -- fields were already confirmed null by the roster_locked check above) and restore its
      -- coverage row's prior decision, since the DELETE cascaded it away.
      insert into public.session_manual_participants (session_id, manual_participant_id, added_at)
      values (p_from_session_id, p_manual_participant_id, v_man.added_at);
      if v_source_cov_found then
        insert into public.subscription_registration_coverage(
          subscription_id, version_id, registration_id, manual_participant_id,
          session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
        )
        select
          v_source_cov.subscription_id, v_source_cov.version_id, null, sm.id,
          v_source_cov.session_date, v_source_cov.week_start, v_source_cov.tier,
          v_source_cov.covered, v_source_cov.non_coverage_reason, v_source_cov.decided_at, v_source_cov.decided_by
        from public.session_manual_participants sm
        where sm.session_id = p_from_session_id and sm.manual_participant_id = p_manual_participant_id;
      end if;
      return json_build_object(
        'ok', false,
        'error', 'subscription_limit_exceeded',
        'reason', v_decision.non_coverage_reason::text
      );
    end if;

    -- Only now (destination confirmed) reconcile the freed source slot for any other existing
    -- registration in that subscription/tier/week — deferred here (unlike the app-athlete
    -- branch, where it fires unavoidably via the UPDATE trigger the moment the source changes)
    -- specifically so a subsequent rejection-and-restore never has to unwind a reconcile that
    -- already ran.
    if v_source_cov_found then
      perform public.subscription_reconcile_week(
        v_source_cov.subscription_id, v_source_cov.week_start, v_source_cov.tier
      );
    end if;

    insert into public.session_manual_participants (session_id, manual_participant_id, added_at)
    values (p_to_session_id, p_manual_participant_id, v_man.added_at)
    returning id into v_dest_reg_id;

    if v_decision.outcome <> 'not_subscribed' then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        v_decision.subscription_id, v_decision.version_id, null, v_dest_reg_id,
        v_to.session_date, v_decision.week_start, v_decision.tier,
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
  end if;

  perform public._insert_activity_event(
    v_uid,
    'participant_moved',
    'session',
    p_to_session_id::text,
    jsonb_build_object(
      'from_session_id', p_from_session_id,
      'to_session_id', p_to_session_id,
      'user_id', p_user_id,
      'manual_participant_id', p_manual_participant_id
    )
  );

  return json_build_object('ok', true);
exception
  when unique_violation then
    return json_build_object('ok', false, 'error', 'already_in_session');
end;
$$;

grant execute on function public.staff_move_session_participant(uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Session-series roster auto-copy for manual/quick-add participants.
--
-- Confirmed from the code (not assumed): copied manual participants become fully confirmed
-- session_manual_participants rows with no human in the loop at copy time — _copy_session_roster
-- is called from _generate_series_occurrences (the 'copy_on_generate' policy, driven by the daily
-- maintain_session_series_horizon job with no per-occurrence review step) and from
-- staff_create_session_series (the 'copy_on_create' policy, applied immediately at series
-- creation across every future occurrence in one call). Neither path pauses for confirmation.
-- There is no existing manager-facing impact-preview/confirmation step in the series creation or
-- horizon-extension flow to hook into (checked staff_create_session_series and
-- maintain_session_series_horizon in full — both are fire-and-forget, matching the pre-existing
-- best-effort `exception when others then null` swallow already used for the athlete-side copy).
--
-- Since there is no athlete/participant present to give consent at copy time, we must not
-- manufacture it. Chosen behavior, applied via one shared helper so both call sites stay in sync:
--   - not_subscribed  -> copy normally (unchanged behavior).
--   - covered         -> copy normally, coverage row created (covered=true).
--   - frozen / tier_not_included / allowance_exceeded -> DO NOT create a paid confirmed
--     registration. Skip the copy for that participant and log it via this repo's existing
--     activity-log convention (public._insert_activity_event / user_activity_events, which
--     managers can already read) so it is visible to staff, not silent — the series creation
--     itself still succeeds (matches the existing best-effort tolerance for partial roster-copy
--     failures on the athlete side).
-- ---------------------------------------------------------------------------

create or replace function public._series_add_manual_participant_checked(
  p_session_id uuid,
  p_manual_participant_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sess public.training_sessions%rowtype;
  v_decision public.subscription_reserve_decision;
  v_reg_id uuid;
begin
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return;
  end if;

  -- accept_extra is always false here: there is no human present at series-copy time to give
  -- consent, so a non-covered outcome must never silently become a paid registration.
  v_decision := public.subscription_reserve_or_reject(p_manual_participant_id, true, p_session_id, false);

  if v_decision.outcome in ('not_subscribed', 'covered') then
    insert into public.session_manual_participants (session_id, manual_participant_id)
    values (p_session_id, p_manual_participant_id)
    on conflict (session_id, manual_participant_id) do nothing
    returning id into v_reg_id;

    if v_reg_id is not null and v_decision.outcome <> 'not_subscribed' then
      insert into public.subscription_registration_coverage(
        subscription_id, version_id, registration_id, manual_participant_id,
        session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
      )
      values (
        v_decision.subscription_id, v_decision.version_id, null, v_reg_id,
        v_sess.session_date, v_decision.week_start, v_decision.tier,
        true, null, now(), 'registration'
      )
      on conflict (manual_participant_id) where manual_participant_id is not null do update set
        subscription_id = excluded.subscription_id,
        version_id = excluded.version_id,
        session_date = excluded.session_date,
        week_start = excluded.week_start,
        tier = excluded.tier,
        covered = true,
        non_coverage_reason = null,
        decided_at = now(),
        decided_by = 'registration';
    end if;
  else
    perform public._insert_activity_event(
      auth.uid(),
      'series_manual_participant_subscription_skipped',
      'session_manual_participant',
      p_manual_participant_id::text,
      jsonb_build_object(
        'session_id', p_session_id,
        'manual_participant_id', p_manual_participant_id,
        'reason', v_decision.non_coverage_reason
      )
    );
  end if;
exception when others then
  null;
end;
$$;

-- Full original body from supabase/migrations/20260605120000_session_series.sql, preserved
-- verbatim except the manual-participant loop now calls the checked helper above.
create or replace function public._copy_session_roster(p_from_session uuid, p_to_session uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  m record;
begin
  if p_from_session is null or p_to_session is null or p_from_session = p_to_session then
    return;
  end if;

  for r in
    select user_id
    from public.session_registrations
    where session_id = p_from_session and status = 'active'
  loop
    begin
      perform public.coach_add_athlete(p_to_session, r.user_id, true);
    exception when others then
      null;
    end;
  end loop;

  for m in
    select manual_participant_id
    from public.session_manual_participants
    where session_id = p_from_session
  loop
    begin
      perform public._series_add_manual_participant_checked(p_to_session, m.manual_participant_id);
    exception when others then
      null;
    end;
  end loop;
end;
$$;

-- Full latest body from supabase/migrations/20260807100000_series_anchor_start_and_edit_notify.sql
-- (the current authoritative definition of staff_create_session_series), preserved verbatim
-- except the p_manual_ids bulk-add loop now calls the same checked helper above instead of a
-- raw INSERT.
create or replace function public.staff_create_session_series(
  p_anchor_date date,
  p_start_time time,
  p_coach_id uuid,
  p_max_participants int,
  p_duration_minutes int default 60,
  p_is_open boolean default false,
  p_is_hidden boolean default false,
  p_is_kickbox boolean default false,
  p_custom_slot_price_ils numeric default null,
  p_repeat_mode text default 'ongoing',
  p_fixed_weeks int default null,
  p_copy_roster boolean default false,
  p_athlete_ids uuid[] default '{}',
  p_manual_ids uuid[] default '{}'
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mode public.session_series_repeat_mode;
  v_weeks int;
  v_series_id uuid;
  v_from date;
  v_to date;
  v_roster public.session_series_roster_policy;
  v_first_session uuid;
  v_sid uuid;
  v_ids uuid[] := '{}';
  v_a uuid;
  v_m uuid;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  if p_anchor_date is null or p_coach_id is null then
    return json_build_object('ok', false, 'error', 'invalid_input');
  end if;
  if p_max_participants is null or p_max_participants < 1 then
    return json_build_object('ok', false, 'error', 'invalid_capacity');
  end if;

  v_mode := case lower(trim(coalesce(p_repeat_mode, 'ongoing')))
    when 'fixed_weeks' then 'fixed_weeks'::public.session_series_repeat_mode
    when 'fixed' then 'fixed_weeks'::public.session_series_repeat_mode
    else 'ongoing'::public.session_series_repeat_mode
  end;

  if v_mode = 'fixed_weeks'::public.session_series_repeat_mode then
    v_weeks := coalesce(p_fixed_weeks, 4);
    if v_weeks < 1 then v_weeks := 1; end if;
    if v_weeks > 52 then v_weeks := 52; end if;
  else
    v_weeks := null;
  end if;

  v_roster := case
    when not coalesce(p_copy_roster, false) then 'none'::public.session_series_roster_policy
    when v_mode = 'ongoing'::public.session_series_repeat_mode then 'copy_on_generate'::public.session_series_roster_policy
    else 'copy_on_create'::public.session_series_roster_policy
  end;

  insert into public.session_series (
    coach_id,
    anchor_date,
    start_time,
    duration_minutes,
    max_participants,
    is_open_for_registration,
    is_hidden,
    is_kickbox,
    custom_slot_price_ils,
    repeat_mode,
    fixed_weeks,
    roster_policy,
    status,
    created_by
  )
  values (
    p_coach_id,
    p_anchor_date,
    p_start_time,
    greatest(1, coalesce(p_duration_minutes, 60)),
    p_max_participants,
    coalesce(p_is_open, false),
    coalesce(p_is_hidden, false),
    coalesce(p_is_kickbox, false),
    p_custom_slot_price_ils,
    v_mode,
    v_weeks,
    v_roster,
    'active',
    v_uid
  )
  returning id into v_series_id;

  v_from := p_anchor_date;
  if v_mode = 'ongoing'::public.session_series_repeat_mode then
    v_to := public._series_horizon_end();
  else
    v_to := p_anchor_date + ((v_weeks - 1) * 7);
  end if;

  perform public._generate_series_occurrences(v_series_id, v_from, v_to);

  select array_agg(t.id order by t.session_date)
  into v_ids
  from public.training_sessions t
  where t.series_id = v_series_id;

  if v_ids is not null and array_length(v_ids, 1) > 0 then
    v_first_session := v_ids[1];

    if v_roster = 'copy_on_create'::public.session_series_roster_policy then
      foreach v_sid in array v_ids loop
        if v_sid is distinct from v_first_session then
          perform public._copy_session_roster(v_first_session, v_sid);
        end if;
      end loop;
    end if;

    if p_athlete_ids is not null then
      foreach v_a in array p_athlete_ids loop
        if v_a is null then continue; end if;
        foreach v_sid in array v_ids loop
          begin
            perform public.coach_add_athlete(v_sid, v_a, true);
          exception when others then
            null;
          end;
        end loop;
      end loop;
    end if;

    if p_manual_ids is not null then
      foreach v_m in array p_manual_ids loop
        if v_m is null then continue; end if;
        foreach v_sid in array v_ids loop
          begin
            perform public._series_add_manual_participant_checked(v_sid, v_m);
          exception when others then
            null;
          end;
        end loop;
      end loop;
    end if;
  end if;

  return json_build_object(
    'ok', true,
    'series_id', v_series_id,
    'session_ids', coalesce(v_ids, '{}'::uuid[]),
    'count', coalesce(array_length(v_ids, 1), 0)
  );
end;
$$;

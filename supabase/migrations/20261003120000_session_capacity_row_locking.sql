-- Session capacity concurrency fix: make occupancy enforcement database-authoritative.
--
-- Audit finding (read-only audit, same session): every occupancy-increasing RPC
-- (register_for_session, coach_add_athlete, add_manual_participant_to_session,
-- staff_move_session_participant, and manager_revert_activity_event's active-restore branch)
-- reads active_registration_count(session_id) and compares it to max_participants with NO row
-- lock or advisory lock on the session, then writes. Under READ COMMITTED, two concurrent
-- callers for the last open slot can both read occupancy = max-1, both pass the check, and both
-- commit a distinct occupant row (the only unique constraints are (session_id,user_id) and
-- (session_id,manual_participant_id), which stop one user double-booking but do nothing to stop
-- two DIFFERENT users/participants from both taking the same last seat). No database CHECK or
-- trigger enforces count(*) <= max_participants anywhere.
--
-- Fix: every one of these functions now takes `SELECT ... FOR UPDATE` on the relevant
-- training_sessions row(s) as its very first read of that session, before any capacity decision,
-- held for the remainder of the transaction. staff_move_session_participant touches two session
-- rows (source and destination) and locks them in a fixed ORDER BY id (not by which is
-- source/destination) so two concurrent opposite-direction moves can never deadlock against each
-- other.
--
-- Scope, explicitly preserved unchanged:
--   - All eligibility/business checks, error contracts, subscription/coverage behavior,
--     registration reopening/reactivation behavior, and result shapes are untouched -- only the
--     session-row read gained FOR UPDATE (or, for the move RPC, was reordered into
--     id-deterministic two-row locking).
--   - The explicit, intentional p_allow_over_capacity=true override (used by the session-series
--     roster-copy feature so an existing roster survives a newly-lower capacity) is UNCHANGED:
--     the capacity REJECTION remains conditional on p_allow_over_capacity exactly as before. The
--     session row IS still locked unconditionally (even on the override path) -- not to reject
--     anything, but because the override path still performs an occupancy-increasing write, and
--     skipping the lock there would reopen the exact race for every OTHER (non-override) caller
--     racing against it. Locking is unconditional; rejection is conditional, same as before.
--   - The waitlist (notify-only, never auto-promotes) and the subscription weekly-allowance
--     advisory lock (pg_advisory_xact_lock, a different axis entirely -- payee/week/tier, not
--     session capacity) are untouched.
--   - manager_revert_activity_event's two branches that already delegate to coach_add_athlete /
--     add_manual_participant_to_session inherit the fix automatically and needed no direct edit.
--     Its 'session_registration_status_changed' branch's active-restoring path does its own raw
--     UPDATE and had NO capacity check at all; this migration adds one. That path is currently
--     unreachable (the only event-producing trigger for this type always logs a transition INTO
--     'cancelled', never out of it, as the function's own pre-existing comment states, confirmed
--     unchanged by this migration) -- so this is defense-in-depth, not a behavior change for any
--     currently-executable scenario -- but it already performs a full subscription-entitlement
--     decision on this same branch, so leaving a capacity hole here while treating the
--     subscription decision as authoritative was itself the inconsistency worth closing.
--
-- Direct client-insert bypass closed: session_manual_participants still had a live client-facing
-- INSERT policy (session_manual_participants_insert_staff) that checked WHO (coach owns the
-- session / is manager) but never HOW MANY -- a coach or manager client could, in principle,
-- insert directly and skip add_manual_participant_to_session's capacity/subscription checks
-- entirely. Confirmed (grep, this session) that no current mobile/web/edge-function code does
-- this. Dropped with no replacement, matching the exact pattern already used for
-- session_registrations (reg_insert_self, dropped in 20260409120000_security_hardening.sql) and
-- waitlist_requests (waitlist_insert_self, same migration): occupancy creation is RPC-only.
-- Every function that inserts into session_manual_participants (add_manual_participant_to_session,
-- staff_move_session_participant, manager_revert_activity_event, and the session-series roster
-- copy helper) is SECURITY DEFINER, owned by a role that already bypasses RLS -- the same
-- mechanism session_registrations' inserts have relied on since its own insert policy was
-- dropped -- so none of them are affected by this policy removal.

-- ---------------------------------------------------------------------------
-- register_for_session: lock the session row before the capacity decision.
-- ---------------------------------------------------------------------------
create or replace function public.register_for_session(p_session_id uuid, p_accept_extra_subscription_charge boolean default false)
returns json
language plpgsql
security definer
set search_path = 'public'
as $function$
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
  select * into v_sess from training_sessions where id = p_session_id for update;
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
$function$;

-- ---------------------------------------------------------------------------
-- coach_add_athlete: same rule. Lock acquired unconditionally, including on the
-- p_allow_over_capacity=true path (see migration header for why).
-- ---------------------------------------------------------------------------
create or replace function public.coach_add_athlete(p_session_id uuid, p_user_id uuid, p_allow_over_capacity boolean default false, p_accept_extra_subscription_charge boolean default false)
returns json
language plpgsql
security definer
set search_path = 'public'
as $function$
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

  select * into v_sess from public.training_sessions where id = p_session_id for update;
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
$function$;

-- ---------------------------------------------------------------------------
-- add_manual_participant_to_session: same rule, same unconditional-lock /
-- conditional-rejection split as coach_add_athlete.
-- ---------------------------------------------------------------------------
create or replace function public.add_manual_participant_to_session(p_session_id uuid, p_manual_participant_id uuid, p_allow_over_capacity boolean default false, p_accept_extra_subscription_charge boolean default false)
returns json
language plpgsql
security definer
set search_path = 'public'
as $function$
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

  select * into v_sess from public.training_sessions where id = p_session_id for update;
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
$function$;

-- ---------------------------------------------------------------------------
-- staff_move_session_participant: lock BOTH session rows, in deterministic
-- ORDER BY id (independent of which is source/destination), before any
-- capacity-sensitive logic. Only the two initial reads of v_from/v_to change;
-- everything else in this function is unchanged from the current production
-- definition.
-- ---------------------------------------------------------------------------
create or replace function public.staff_move_session_participant(p_from_session_id uuid, p_to_session_id uuid, p_user_id uuid default null::uuid, p_manual_participant_id uuid default null::uuid, p_allow_over_capacity boolean default false, p_decrease_source_max boolean default false, p_increase_dest_max boolean default false, p_accept_extra_subscription_charge boolean default false)
returns json
language plpgsql
security definer
set search_path = 'public'
as $function$
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

  -- Lock both session rows in a fixed ORDER BY id, independent of which is source/destination,
  -- so two concurrent opposite-direction moves (A->B and B->A) can never deadlock against each
  -- other -- both always attempt to acquire the lower id first.
  if p_from_session_id < p_to_session_id then
    select * into v_from from public.training_sessions where id = p_from_session_id for update;
    if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
    select * into v_to from public.training_sessions where id = p_to_session_id for update;
    if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  else
    select * into v_to from public.training_sessions where id = p_to_session_id for update;
    if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
    select * into v_from from public.training_sessions where id = p_from_session_id for update;
    if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;
  end if;

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
  -- add_manual_participant_to_session -- no eligibility logic is reimplemented here.
  --
  -- Ordering, found and fixed during testing: the source registration is released FIRST, THEN
  -- the destination is evaluated. Evaluating the destination before releasing the source would
  -- make subscription_reserve_or_reject's count still include the source's own covered=true row
  -- (same subscription/tier/week pool for a same-tier move) and INCORRECTLY reject even the most
  -- common case -- an athlete simply relocating their one already-used allowance slot to a
  -- different day, with no other registrant involved at all. Releasing first works correctly
  -- because of the companion fix in subscription_reserve_or_reject's counting query (see that
  -- function): a cancelled-without-charge row is now excluded from the count, exactly the state
  -- the source is in immediately after being released here.
  --
  -- If the destination is then rejected, the release is explicitly compensated (restored) below
  -- so the net effect is "nothing happened" -- the athlete ends up exactly where they started.
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
    -- existing registration in that subscription/tier/week -- no extra call needed.

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
    -- registration and the move -- judged an acceptable, narrow trade-off for a staff-
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
    -- Capture the source coverage row (if any) before deleting it -- needed both to reconcile the
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
    -- registration in that subscription/tier/week -- deferred here (unlike the app-athlete
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
$function$;

-- ---------------------------------------------------------------------------
-- manager_revert_activity_event: the two branches that delegate to
-- coach_add_athlete / add_manual_participant_to_session ('session_registration_cancelled',
-- 'session_manual_participant_removed') inherit the fix automatically via those functions and
-- need no direct edit here. Only the inline 'session_registration_status_changed' branch's
-- active-restoring path is changed, adding the session-row lock and capacity check it previously
-- lacked entirely (it only performed a subscription-entitlement check). This path is currently
-- unreachable -- the only trigger that produces this event type always logs a transition INTO
-- 'cancelled' (never out of it), so v_from_status is always 'cancelled' in every event this
-- trigger can currently produce, meaning the `else` (raw revert, cancelled->cancelled) branch
-- always executes today, exactly as the function's own pre-existing comment states. This change
-- is defense-in-depth for if that ever becomes reachable, not a behavior change today.
-- ---------------------------------------------------------------------------
create or replace function public.manager_revert_activity_event(p_event_id uuid, p_accept_extra_subscription_charge boolean default false)
returns json
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  ev public.user_activity_events%rowtype;
  info json;
  v_changes jsonb;
  v_sid uuid;
  v_uid uuid;
  v_manual_id uuid;
  v_reg_id uuid;
  v_res json;
  v_prev public.approval_status;
  v_from_status public.registration_status;
  v_row public.session_registrations%rowtype;
  v_decision public.subscription_reserve_decision;
  v_sess_lock public.training_sessions%rowtype;
  v_count int;
begin
  if not public.is_manager(auth.uid()) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  info := public.manager_activity_revert_info(p_event_id);
  if coalesce((info->>'ok')::boolean, false) is not true then
    return info;
  end if;
  if coalesce((info->>'can_revert')::boolean, false) is not true then
    return json_build_object('ok', false, 'error', coalesce(info->>'reason', 'not_revertible'));
  end if;

  select * into ev from public.user_activity_events where id = p_event_id for update;
  if ev.reverted_at is not null then
    return json_build_object('ok', false, 'error', 'already_reverted');
  end if;

  v_changes := coalesce(ev.metadata->'changes', '{}'::jsonb);
  perform set_config('shira.skip_activity_log', 'on', true);

  case ev.event_type
    when 'profile_updated' then
      update public.profiles p
      set
        full_name = case when v_changes ? 'full_name' then v_changes->'full_name'->>'from' else p.full_name end,
        phone = case when v_changes ? 'phone' then v_changes->'phone'->>'from' else p.phone end,
        gender = case when v_changes ? 'gender' then v_changes->'gender'->>'from' else p.gender end,
        date_of_birth = case
          when v_changes ? 'date_of_birth' and nullif(v_changes->'date_of_birth'->>'from', '') is not null
            then (v_changes->'date_of_birth'->>'from')::date
          when v_changes ? 'date_of_birth' then null
          else p.date_of_birth
        end,
        username = case when v_changes ? 'username' then v_changes->'username'->>'from' else p.username end
      where p.user_id = ev.target_id::uuid;

    when 'athlete_approved', 'athlete_rejected', 'athlete_approval_updated' then
      v_prev := (ev.metadata->>'previous_approval_status')::public.approval_status;
      update public.profiles
      set approval_status = v_prev
      where user_id = ev.target_id::uuid and role = 'athlete';

    when 'session_updated' then
      update public.training_sessions s
      set
        session_date = case when v_changes ? 'session_date' then (v_changes->'session_date'->>'from')::date else s.session_date end,
        start_time = case when v_changes ? 'start_time' then (v_changes->'start_time'->>'from')::time else s.start_time end,
        coach_id = case when v_changes ? 'coach_id' then (v_changes->'coach_id'->>'from')::uuid else s.coach_id end,
        max_participants = case when v_changes ? 'max_participants' then (v_changes->'max_participants'->>'from')::int else s.max_participants end,
        is_open_for_registration = case when v_changes ? 'is_open_for_registration' then (v_changes->'is_open_for_registration'->>'from')::boolean else s.is_open_for_registration end,
        duration_minutes = case when v_changes ? 'duration_minutes' then (v_changes->'duration_minutes'->>'from')::int else s.duration_minutes end,
        is_hidden = case when v_changes ? 'is_hidden' then (v_changes->'is_hidden'->>'from')::boolean else s.is_hidden end,
        custom_slot_price_ils = case
          when v_changes ? 'custom_slot_price_ils' and v_changes->'custom_slot_price_ils'->'from' = 'null'::jsonb then null
          when v_changes ? 'custom_slot_price_ils' then (v_changes->'custom_slot_price_ils'->>'from')::numeric
          else s.custom_slot_price_ils
        end
      where s.id = ev.target_id::uuid;

    when 'session_created' then
      delete from public.training_sessions where id = ev.target_id::uuid;

    when 'session_registration' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_uid := (ev.metadata->>'user_id')::uuid;
      v_res := public.manager_remove_athlete(v_sid, v_uid);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'remove_failed'));
      end if;

    when 'session_registration_cancelled' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_uid := (ev.metadata->>'user_id')::uuid;
      v_res := public.coach_add_athlete(v_sid, v_uid);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'restore_failed'));
      end if;

    when 'session_registration_status_changed' then
      v_reg_id := ev.target_id::uuid;
      v_from_status := (ev.metadata->>'from')::public.registration_status;

      select * into v_row from public.session_registrations where id = v_reg_id;
      if not found then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', 'registration_missing');
      end if;

      if v_from_status = 'active'::public.registration_status
        and v_row.status is distinct from 'active'::public.registration_status
      then
        -- Restoring into active/chargeable state: lock the session row and enforce capacity the
        -- same way every other path that can reactivate occupancy does, before the authoritative
        -- subscription/entitlement decision (same function as every other confirmed-registration
        -- path). Undo is not consent -- neither an over-capacity nor a non-covered outcome
        -- without explicit p_accept_extra_subscription_charge may proceed, leaving the cancelled
        -- state fully intact.
        select * into v_sess_lock from public.training_sessions where id = v_row.session_id for update;
        v_count := public.active_registration_count(v_row.session_id);
        if v_count >= v_sess_lock.max_participants then
          perform set_config('shira.skip_activity_log', 'off', true);
          return json_build_object('ok', false, 'error', 'full');
        end if;

        v_decision := public.subscription_reserve_or_reject(
          v_row.user_id, false, v_row.session_id, coalesce(p_accept_extra_subscription_charge, false)
        );
        if not v_decision.ok then
          perform set_config('shira.skip_activity_log', 'off', true);
          return json_build_object(
            'ok', false,
            'error', 'subscription_limit_exceeded',
            'reason', v_decision.non_coverage_reason::text
          );
        end if;

        update public.session_registrations
        set status = 'active'
        where id = v_reg_id;

        if v_decision.outcome <> 'not_subscribed' then
          insert into public.subscription_registration_coverage(
            subscription_id, version_id, registration_id, manual_participant_id,
            session_date, week_start, tier, covered, non_coverage_reason, decided_at, decided_by
          )
          values (
            v_decision.subscription_id, v_decision.version_id, v_reg_id, null,
            (select session_date from public.training_sessions where id = v_row.session_id),
            v_decision.week_start, v_decision.tier,
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
        -- Not a transition into active/chargeable state (the only case reachable under the
        -- current event-producing trigger: reverting active->cancelled back to cancelled) --
        -- unchanged, raw-update behavior.
        update public.session_registrations
        set status = v_from_status
        where id = v_reg_id;
      end if;

    when 'session_manual_participant_added' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_manual_id := (ev.metadata->>'manual_participant_id')::uuid;
      delete from public.session_manual_participants
      where session_id = v_sid and manual_participant_id = v_manual_id;

    when 'session_manual_participant_removed' then
      v_sid := (ev.metadata->>'session_id')::uuid;
      v_manual_id := (ev.metadata->>'manual_participant_id')::uuid;
      v_res := public.add_manual_participant_to_session(v_sid, v_manual_id);
      if coalesce((v_res->>'ok')::boolean, false) is not true then
        perform set_config('shira.skip_activity_log', 'off', true);
        return json_build_object('ok', false, 'error', coalesce(v_res->>'error', 'restore_failed'));
      end if;

    when 'registration_attendance_updated' then
      update public.session_registrations r
      set
        attended = case when v_changes ? 'attended'
          then public._activity_jsonb_to_boolean(v_changes->'attended'->'from') else r.attended end,
        payment_method = case when v_changes ? 'payment_method'
          then nullif(v_changes->'payment_method'->>'from', '') else r.payment_method end,
        amount_paid = case when v_changes ? 'amount_paid'
          then public._activity_jsonb_to_numeric(v_changes->'amount_paid'->'from') else r.amount_paid end,
        charge_no_show = case when v_changes ? 'charge_no_show'
          then coalesce(public._activity_jsonb_to_boolean(v_changes->'charge_no_show'->'from'), false) else r.charge_no_show end
      where id = ev.target_id::uuid;

    when 'manual_participant_attendance_updated' then
      update public.session_manual_participants r
      set
        attended = case when v_changes ? 'attended'
          then public._activity_jsonb_to_boolean(v_changes->'attended'->'from') else r.attended end,
        payment_method = case when v_changes ? 'payment_method'
          then nullif(v_changes->'payment_method'->>'from', '') else r.payment_method end,
        amount_paid = case when v_changes ? 'amount_paid'
          then public._activity_jsonb_to_numeric(v_changes->'amount_paid'->'from') else r.amount_paid end,
        charge_no_show = case when v_changes ? 'charge_no_show'
          then coalesce(public._activity_jsonb_to_boolean(v_changes->'charge_no_show'->'from'), false) else r.charge_no_show end
      where id = ev.target_id::uuid;

    when 'user_role_changed' then
      update public.profiles
      set role = (ev.metadata->>'previous_role')::public.user_role
      where user_id = ev.target_id::uuid;

    when 'cancellation_charge_updated' then
      update public.cancellations
      set
        charged_full_price = coalesce(public._activity_jsonb_to_boolean(v_changes->'charged_full_price'->'from'), false),
        penalty_collected_ils = coalesce(public._activity_jsonb_to_numeric(v_changes->'penalty_collected_ils'->'from'), 0)
      where id = ev.target_id::uuid;

    when 'cancellation_penalty_collected_updated' then
      update public.cancellations
      set penalty_collected_ils = coalesce(public._activity_jsonb_to_numeric(v_changes->'penalty_collected_ils'->'from'), 0)
      where id = ev.target_id::uuid;

    when 'registration_opening_schedule_updated' then
      update public.app_settings
      set
        registration_open_weekday = (v_changes->'registration_open_weekday'->>'from')::int,
        registration_open_time = (v_changes->'registration_open_time'->>'from')::time,
        updated_at = now()
      where id = 1;

    when 'session_note_created' then
      delete from public.session_notes where id = ev.target_id::uuid;

    when 'session_note_deleted' then
      insert into public.session_notes (id, session_id, author_id, body)
      values (
        ev.target_id::uuid,
        (ev.metadata->>'session_id')::uuid,
        (ev.metadata->>'author_id')::uuid,
        ev.metadata->>'body'
      );

    else
      perform set_config('shira.skip_activity_log', 'off', true);
      return json_build_object('ok', false, 'error', 'not_revertible');
  end case;

  update public.user_activity_events
  set reverted_at = now(), reverted_by = auth.uid()
  where id = p_event_id;

  perform set_config('shira.skip_activity_log', 'off', true);

  perform public._insert_activity_event(
    auth.uid(),
    'activity_event_reverted',
    'user_activity_event',
    p_event_id::text,
    jsonb_build_object('reverted_event_type', ev.event_type)
  );

  return json_build_object('ok', true);
exception
  when others then
    perform set_config('shira.skip_activity_log', 'off', true);
    return json_build_object('ok', false, 'error', sqlerrm);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Close the direct-insert bypass on session_manual_participants: creation is now RPC-only,
-- matching session_registrations (reg_insert_self, dropped 20260409120000) and
-- waitlist_requests (waitlist_insert_self, same migration). SELECT/UPDATE/DELETE policies are
-- untouched -- only INSERT is removed, since that's the only occupancy-CREATING operation.
-- ---------------------------------------------------------------------------
drop policy if exists session_manual_participants_insert_staff on public.session_manual_participants;

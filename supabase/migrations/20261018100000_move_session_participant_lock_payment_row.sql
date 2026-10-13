-- Concurrency fix for 20261017100000_move_past_session_participant_unpaid.sql: close a real
-- read-then-write race between staff_move_session_participant's payment check and any concurrent
-- transaction that records a payment (or issues a receipt) for the exact row being moved.
--
-- The bug (proven with two real, separately-committed connections -- see
-- supabase/tests/177_move_payment_race_tests.sh): the function's initial SELECT of v_reg / v_man
-- (which the payment-recorded / roster_locked check reads) took no lock. Under READ COMMITTED
-- (Postgres's default), that SELECT only ever sees the last COMMITTED row version -- so if a
-- concurrent set_registration_attendance / set_manual_participant_attendance call (or a direct
-- table UPDATE of amount_paid, or a receipt being issued -- see below) has started writing the
-- same row but not committed yet, the move's read sees the OLD (pre-payment) values and the check
-- passes. The move then proceeds to its own UPDATE (status='cancelled') or DELETE of that same
-- row. Because that statement's WHERE clause never re-checks payment (by design -- it only
-- targets the row the earlier check already approved), once the concurrent payment-recording
-- transaction commits, the move's write still goes through: the payment ends up permanently
-- stamped on a row the move has already cancelled/deleted, while the move itself reports ok:true,
-- never having seen the payment it raced against. Demonstrated end-to-end: a committed recorded
-- payment (amount_paid=100, payment_method='cash') landed on a row the move had already flipped to
-- status='cancelled' -- exactly the outcome requirement 2 (payment safety) forbids.
--
-- Fix: take `for update` on the SAME row the payment check reads, at the exact point it is first
-- read -- before the payment check, for BOTH branches (registered-athlete and manual-participant),
-- and regardless of whether the source has started (this also hardens the pre-existing, formerly
-- future-only roster_locked check against the identical class of race, which existed before this
-- feature and is not specific to past sessions). This closes the race against every writer of that
-- row because Postgres row-level locking does not care which statement or caller takes the lock:
--   - set_registration_attendance / set_manual_participant_attendance's own UPDATE ... where id =
--     v_row.id takes the same kind of row lock. Whichever transaction (the move's SELECT ... FOR
--     UPDATE, or the attendance RPC's UPDATE) gets there first now makes the other wait for it to
--     finish, so the loser always re-reads (or is read from) a value that already reflects the
--     winner's fully committed result -- never a stale pre-commit snapshot.
--   - A direct table UPDATE of amount_paid/payment_method (the path coaches use for
--     session_manual_participants per the receipt-lock tests) is an ordinary UPDATE and is
--     serialized the exact same way.
--   - Receipt/document creation (_create_document_from_payment_row inserting into `documents`,
--     mark_payment_receipt_external inserting into `external_manual_receipts`, which
--     _payment_has_active_document reads) is ALREADY designed to serialize against exactly this
--     kind of row lock: the `documents_lock_session_payment` / `external_manual_receipts_lock_...`
--     triggers (20261013140000_lock_receipted_session_payments_for_coaches.sql) take `for update`
--     on the SAME session_registrations/session_manual_participants row before a receipt is
--     allowed to be created, specifically so it serializes with "the row lock of the UPDATE /
--     DELETE" on that row (the migration's own words). Taking that same lock here makes the move
--     a participant in that already-established protocol, not a new one.
--
-- Only the two initial reads change (`for update` added); every other line, including the
-- training_sessions-level locking/ordering that already avoids deadlock between two opposite-
-- direction moves, Decision A (destination must still be not-started) and Decision B (no new
-- attendance/accounting semantics), is preserved verbatim from
-- supabase/migrations/20261017100000_move_past_session_participant_unpaid.sql.

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
  v_from_started boolean;
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

  -- The DESTINATION must still be a session that hasn't started -- unchanged. The SOURCE may have
  -- already started; whether that's allowed is decided per-participant below (payment-recorded
  -- check) instead of being blocked unconditionally here.
  v_from_started := public._session_has_started(v_from);
  if public._session_has_started(v_to) then
    return json_build_object('ok', false, 'error', 'session_started');
  end if;
  if not public._sessions_same_studio_week(v_from.session_date, v_to.session_date) then
    return json_build_object('ok', false, 'error', 'same_week');
  end if;

  if p_user_id is not null then
    -- `for update`: lock this exact row before reading the payment/attendance fields the checks
    -- below rely on, so it serializes against any concurrent payment write on the same row
    -- (attendance RPC, direct table update, or receipt issuance -- see migration header).
    select * into v_reg
    from public.session_registrations
    where session_id = p_from_session_id and user_id = p_user_id and status = 'active'
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    if v_from_started then
      -- Past session: only an actually recorded payment blocks the move (see migration header).
      if coalesce(v_reg.amount_paid, 0) > 0
        or public._payment_has_active_document('session_reg', v_reg.id) then
        return json_build_object('ok', false, 'error', 'payment_recorded');
      end if;
    else
      if v_reg.attended is not null
        or v_reg.payment_method is not null
        or v_reg.amount_paid is not null
        or coalesce(v_reg.charge_no_show, false) then
        return json_build_object('ok', false, 'error', 'roster_locked');
      end if;
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
    -- `for update`: same reasoning as the registered-athlete branch above.
    select * into v_man
    from public.session_manual_participants
    where session_id = p_from_session_id and manual_participant_id = p_manual_participant_id
    for update;
    if not found then
      return json_build_object('ok', false, 'error', 'not_on_source');
    end if;
    if v_from_started then
      -- Past session: only an actually recorded payment blocks the move (see migration header).
      if coalesce(v_man.amount_paid, 0) > 0
        or public._payment_has_active_document('session_manual', v_man.id) then
        return json_build_object('ok', false, 'error', 'payment_recorded');
      end if;
    else
      if v_man.attended is not null
        or v_man.payment_method is not null
        or v_man.amount_paid is not null
        or coalesce(v_man.charge_no_show, false) then
        return json_build_object('ok', false, 'error', 'roster_locked');
      end if;
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
      -- Compensate: restore the source exactly as it was. Only status was ever touched here --
      -- attended/payment_method/amount_paid/charge_no_show/payment_recorded_by/at were never
      -- modified by this function (and, for a not-yet-started source, were already confirmed
      -- null/false by the roster_locked check above), so a plain status flip back is exact.
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
      -- Compensate: re-insert the participant on the source exactly as before -- including
      -- attended/payment_method/amount_paid/charge_no_show/payment_recorded_by/payment_recorded_at,
      -- captured on v_man before the delete above (fixed here: previously these columns were
      -- dropped on this path, which was harmless only while roster_locked guaranteed they were
      -- already null/false for every move that could reach this point; a past, unpaid-but-
      -- attended/no-show-flagged move can reach it now, so they must be restored explicitly to
      -- avoid silently discarding that historical data on a subscription rejection-and-restore)
      -- -- and restore its coverage row's prior decision, since the DELETE cascaded it away.
      insert into public.session_manual_participants (
        session_id, manual_participant_id, added_at,
        attended, payment_method, amount_paid, charge_no_show,
        payment_recorded_by, payment_recorded_at
      )
      values (
        p_from_session_id, p_manual_participant_id, v_man.added_at,
        v_man.attended, v_man.payment_method, v_man.amount_paid, v_man.charge_no_show,
        v_man.payment_recorded_by, v_man.payment_recorded_at
      );
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

-- Self-check: function still exists with the same signature/grants as before (CREATE OR REPLACE
-- preserves existing grants; nothing to re-grant).
do $$
begin
  if to_regprocedure(
    'public.staff_move_session_participant(uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean)'
  ) is null then
    raise exception 'self-check: staff_move_session_participant missing after replace';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.staff_move_session_participant(uuid, uuid, uuid, uuid, boolean, boolean, boolean, boolean)'::regprocedure,
    'EXECUTE'
  ) then
    raise exception 'self-check: authenticated lost EXECUTE on staff_move_session_participant';
  end if;
end $$;

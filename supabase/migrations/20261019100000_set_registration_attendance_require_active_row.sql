-- Close a read-then-write race in set_registration_attendance, found while hardening
-- staff_move_session_participant (20261018100000_move_session_participant_lock_payment_row.sql):
-- the function's initial read already filters `status = 'active'` (returning
-- 'not_active_registration' if the registration isn't found that way), but its FINAL update
-- targeted the row by id only -- `where id = v_row.id`, with no re-check of status. Under READ
-- COMMITTED, if a concurrent transaction (most commonly staff_move_session_participant, but
-- equally an ordinary self-cancellation) changes that same row's status to 'cancelled' and commits
-- in the window between this function's initial read and its own UPDATE, the UPDATE still matches
-- the row by id regardless of status and silently succeeds -- writing attendance/payment fields
-- onto a registration that is no longer active, with no error returned. Proven end to end with two
-- real, separately-committed connections (see supabase/tests/178_set_registration_attendance_race_tests.sh):
-- a payment call whose own SELECT ran while a move still held the row lock went on to record a
-- $100 cash payment onto a registration the move had, by the time the UPDATE actually ran,
-- already flipped to status='cancelled' -- reporting ok:true with no hint anything was wrong. That
-- payment then becomes invisible to every status='active'-filtered financial surface (weekly
-- collections stats, the payments-received list, the pending-receipts list that drives receipt
-- generation) while the registration itself was already moved elsewhere.
--
-- public.set_manual_participant_attendance does NOT need the equivalent fix: removing a manual
-- participant is a hard DELETE (no status column to begin with), so the identical
-- `where id = v_row.id` update, in the same race, already matches zero rows, and the function's
-- existing `get diagnostics v_n = row_count; if v_n = 0 then return 'update_failed'` already
-- catches that case correctly (verified with the same two-connection methodology). This migration
-- touches set_registration_attendance only.
--
-- Fix: add `and status = 'active'` to the final UPDATE's WHERE clause, so a status change that
-- happened after the initial read (by a move, a cancellation, or anything else) makes the UPDATE
-- match zero rows instead of silently succeeding. Zero rows is already treated as failure by the
-- existing `get diagnostics`/`if v_n = 0` check right below it -- only the error code returned by
-- that branch changes, from 'update_failed' to the more accurate 'not_active_registration': both
-- codes were already registered client-side (mobile/src/lib/rpcOutcomes/registry.ts) with no
-- required client change either way, but 'not_active_registration' is the exact, already-used code
-- for "this registration is not active" -- the SAME condition the function's own initial read
-- checks for, just discovered one step later. Reusing it means the error now consistently means
-- the same thing regardless of when the non-active state is discovered, and keeps the outcome
-- classified "business" (its initial-read sibling) rather than "uncertain" (update_failed's
-- current classification, which was written without realising this specific path was reachable).
--
-- Every other line -- permission checks (manager OR the session's own coach, unchanged for both
-- roles), validation, the attendance/payment value computation, the activity-log audit entry -- is
-- preserved verbatim from the current production definition
-- (supabase/migrations/20260628200000_activity_log_full_coverage.sql).

create or replace function public.set_registration_attendance(
  p_session_id uuid,
  p_user_id uuid,
  p_status text,
  p_payment_method text default null,
  p_amount_paid numeric default null,
  p_charge_no_show boolean default false
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_sess public.training_sessions%rowtype;
  v_row public.session_registrations%rowtype;
  v_att boolean;
  v_n int;
  v_pay text := nullif(trim(coalesce(p_payment_method, '')), '');
  v_amt numeric(12, 2) := null;
  v_charge_ns boolean := coalesce(p_charge_no_show, false);
  v_payment_changed boolean := false;
  v_changes jsonb := '{}'::jsonb;
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if p_status is null or p_status not in ('unset', 'arrived', 'absent') then
    return json_build_object('ok', false, 'error', 'invalid_status');
  end if;

  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then
    return json_build_object('ok', false, 'error', 'session_not_found');
  end if;

  if not public.is_coach_or_manager(v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  if public.is_manager(v_uid) then
    null;
  elsif v_sess.coach_id = v_uid
    and exists (select 1 from public.profiles p where p.user_id = v_uid and p.role = 'coach') then
    null;
  else
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;

  select * into v_row
  from public.session_registrations
  where session_id = p_session_id and user_id = p_user_id and status = 'active';
  if not found then
    return json_build_object('ok', false, 'error', 'not_active_registration');
  end if;

  if p_status = 'unset' then
    v_att := null;
    v_pay := null;
    v_amt := null;
    v_charge_ns := false;
  elsif p_status = 'arrived' then
    v_att := true;
    v_charge_ns := false;
    if v_pay is null then
      v_amt := null;
    else
      if p_amount_paid is not null and p_amount_paid < 0 then
        return json_build_object('ok', false, 'error', 'invalid_amount');
      end if;
      v_amt := case
        when p_amount_paid is null then null
        else round(p_amount_paid::numeric, 2)::numeric(12, 2)
      end;
    end if;
  else
    v_att := false;
    if not v_charge_ns then
      v_pay := null;
      v_amt := null;
    else
      if v_pay is null then
        v_amt := null;
      else
        if p_amount_paid is not null and p_amount_paid < 0 then
          return json_build_object('ok', false, 'error', 'invalid_amount');
        end if;
        v_amt := case
          when p_amount_paid is null then null
          else round(p_amount_paid::numeric, 2)::numeric(12, 2)
        end;
      end if;
    end if;
  end if;

  if v_row.attended is distinct from v_att then
    v_changes := v_changes || jsonb_build_object(
      'attended', jsonb_build_object('from', v_row.attended, 'to', v_att)
    );
  end if;
  if nullif(trim(coalesce(v_row.payment_method, '')), '') is distinct from v_pay then
    v_changes := v_changes || jsonb_build_object(
      'payment_method', jsonb_build_object('from', v_row.payment_method, 'to', v_pay)
    );
  end if;
  if v_row.amount_paid is distinct from v_amt then
    v_changes := v_changes || jsonb_build_object(
      'amount_paid', jsonb_build_object('from', v_row.amount_paid, 'to', v_amt)
    );
  end if;
  if v_row.charge_no_show is distinct from (case when p_status = 'absent' then v_charge_ns else false end) then
    v_changes := v_changes || jsonb_build_object(
      'charge_no_show', jsonb_build_object('from', v_row.charge_no_show, 'to', case when p_status = 'absent' then v_charge_ns else false end)
    );
  end if;

  v_payment_changed :=
    v_pay is distinct from nullif(trim(coalesce(v_row.payment_method, '')), '')
    or v_amt is distinct from v_row.amount_paid;

  -- `and status = 'active'` is the one-line fix: if a concurrent transaction (a move, a
  -- cancellation, or anything else) changed this row's status since the read above, this UPDATE
  -- now matches zero rows instead of silently writing onto a no-longer-active registration.
  update public.session_registrations
  set
    attended = v_att,
    payment_method = v_pay,
    amount_paid = v_amt,
    charge_no_show = case when p_status = 'absent' then v_charge_ns else false end,
    payment_recorded_by = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then v_uid
      else v_row.payment_recorded_by
    end,
    payment_recorded_at = case
      when v_pay is null then null
      when v_row.payment_recorded_by is null or v_payment_changed then now()
      else v_row.payment_recorded_at
    end
  where id = v_row.id and status = 'active';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    -- Zero rows affected is always treated as failure -- never return ok:true here. Reuses the
    -- same code the initial read above already returns for "this registration is not active";
    -- see migration header for why this is more accurate than the previous 'update_failed'.
    return json_build_object('ok', false, 'error', 'not_active_registration');
  end if;

  if v_changes <> '{}'::jsonb then
    perform public._insert_activity_event(
      v_uid,
      'registration_attendance_updated',
      'session_registration',
      v_row.id::text,
      jsonb_build_object('session_id', p_session_id, 'user_id', p_user_id, 'changes', v_changes)
    );
  end if;

  return json_build_object('ok', true);
end;
$$;

-- Self-check: function still exists with the same signature/grants as before (CREATE OR REPLACE
-- preserves existing grants; nothing to re-grant).
do $$
begin
  if to_regprocedure(
    'public.set_registration_attendance(uuid, uuid, text, text, numeric, boolean)'
  ) is null then
    raise exception 'self-check: set_registration_attendance missing after replace';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.set_registration_attendance(uuid, uuid, text, text, numeric, boolean)'::regprocedure,
    'EXECUTE'
  ) then
    raise exception 'self-check: authenticated lost EXECUTE on set_registration_attendance';
  end if;
end $$;

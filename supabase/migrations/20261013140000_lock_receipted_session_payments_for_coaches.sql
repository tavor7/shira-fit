-- Authorization: a coach may record / correct a session payment only while no receipt has been issued for it.
--
-- Business rule (owner, 2026-10-11): coaches keep managing payment status for participants of the sessions they manage
-- (set_registration_attendance / set_manual_participant_attendance already limit a coach to the sessions they coach), but
-- once a receipt has been issued for that specific payment -- a non-cancelled document, or a payment marked as receipted
-- externally -- the payment is read-only for coaches: no change of amount, method, recorded-by/at or no-show charge
-- (which includes marking it unpaid), and no deletion of the row that carries it. Managers keep their existing
-- capabilities (subject to the existing document-integrity rules); system jobs (no end user) are not affected.
--
-- Enforcement is a row trigger on the two tables that carry session payments, so it applies to EVERY path -- the attendance
-- RPCs, staff_move_session_participant, remove_manual_participant_from_session, direct PostgREST updates the RLS allows
-- (session_manual_participants for the session's coach) and anything added later. The trigger is SECURITY DEFINER so the
-- receipt lookup sees documents regardless of the caller's RLS.
--
-- Atomicity: the trigger runs after the row lock of the UPDATE / DELETE is taken, and its receipt lookup takes a fresh
-- snapshot (plpgsql, volatile). Receipt issuance (documents insert / reactivation, external-receipt marker) first locks the
-- same payment row FOR UPDATE. So either the coach's change commits first and the receipt is issued afterwards, or the
-- receipt exists by the time the coach's statement holds the row and the change is refused -- never both unordered.

create or replace function public._guard_receipted_session_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_kind text := case tg_table_name when 'session_registrations' then 'session_reg' else 'session_manual' end;
begin
  -- managers keep their capabilities; system / cron / service paths have no end user
  if v_uid is null or public.is_manager(v_uid) then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE'
     and (new.amount_paid, new.payment_method, new.payment_recorded_at, new.payment_recorded_by, new.charge_no_show)
         is not distinct from
         (old.amount_paid, old.payment_method, old.payment_recorded_at, old.payment_recorded_by, old.charge_no_show) then
    return new;  -- attendance-only or other non-payment change
  end if;
  if public._payment_has_active_document(v_kind, old.id) then
    raise exception 'payment_locked_receipt_issued'
      using errcode = 'P0001',
            detail = 'A receipt has been issued for this payment; only a manager can change it.';
  end if;
  return coalesce(new, old);
end;
$$;

comment on function public._guard_receipted_session_payment() is
  'Refuses non-manager changes to a session payment (amount, method, recorded-by/at, no-show charge) or deletion of its row once a receipt has been issued for it.';

drop trigger if exists session_registrations_receipted_payment_guard on public.session_registrations;
create trigger session_registrations_receipted_payment_guard
  before update or delete on public.session_registrations
  for each row execute function public._guard_receipted_session_payment();

drop trigger if exists session_manual_participants_receipted_payment_guard on public.session_manual_participants;
create trigger session_manual_participants_receipted_payment_guard
  before update or delete on public.session_manual_participants
  for each row execute function public._guard_receipted_session_payment();

-- Receipt issuance locks the payment row first (serialises with the guard above).
create or replace function public._lock_session_payment_for_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_kind text;
begin
  if tg_table_name = 'documents' then
    if new.source_type is distinct from 'session_payment' or new.source_id is null or new.status = 'CANCELLED' then
      return new;
    end if;
    v_id := new.source_id;
    perform 1 from public.session_registrations where id = v_id for update;
    perform 1 from public.session_manual_participants where id = v_id for update;
  else
    v_kind := new.row_kind;
    v_id := new.record_id;
    if v_kind = 'session_reg' then
      perform 1 from public.session_registrations where id = v_id for update;
    elsif v_kind = 'session_manual' then
      perform 1 from public.session_manual_participants where id = v_id for update;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_lock_session_payment on public.documents;
create trigger documents_lock_session_payment
  before insert or update of status, source_id, source_type on public.documents
  for each row execute function public._lock_session_payment_for_receipt();

drop trigger if exists external_manual_receipts_lock_session_payment on public.external_manual_receipts;
create trigger external_manual_receipts_lock_session_payment
  before insert or update of row_kind, record_id on public.external_manual_receipts
  for each row execute function public._lock_session_payment_for_receipt();

-- Trigger functions are not RPCs.
revoke execute on function public._guard_receipted_session_payment() from public, anon, authenticated;
revoke execute on function public._lock_session_payment_for_receipt() from public, anon, authenticated;

-- Which payments of a session are locked (for the roster UI). Managers and the session's coach only; returns participant
-- keys only, never receipt data.
create or replace function public.session_payment_receipt_locks(p_session_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return json_build_object('ok', false, 'error', 'not_authenticated');
  end if;
  if not public.is_manager(v_uid)
     and not exists (select 1 from public.training_sessions s where s.id = p_session_id and s.coach_id = v_uid) then
    return json_build_object('ok', false, 'error', 'forbidden');
  end if;
  return json_build_object(
    'ok', true,
    'locked_user_ids', coalesce((
      select json_agg(r.user_id) from public.session_registrations r
      where r.session_id = p_session_id and public._payment_has_active_document('session_reg', r.id)), '[]'::json),
    'locked_manual_ids', coalesce((
      select json_agg(m.manual_participant_id) from public.session_manual_participants m
      where m.session_id = p_session_id and public._payment_has_active_document('session_manual', m.id)), '[]'::json)
  );
end;
$$;

revoke execute on function public.session_payment_receipt_locks(uuid) from public, anon;
grant execute on function public.session_payment_receipt_locks(uuid) to authenticated, service_role;

-- Self-check
do $$
begin
  if (select count(*) from pg_trigger where not tgisinternal and tgname in (
        'session_registrations_receipted_payment_guard', 'session_manual_participants_receipted_payment_guard',
        'documents_lock_session_payment', 'external_manual_receipts_lock_session_payment')) <> 4 then
    raise exception 'self-check: receipt-lock triggers missing';
  end if;
  if has_function_privilege('anon', 'public.session_payment_receipt_locks(uuid)'::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', 'public._guard_receipted_session_payment()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: unexpected privileges';
  end if;
end $$;

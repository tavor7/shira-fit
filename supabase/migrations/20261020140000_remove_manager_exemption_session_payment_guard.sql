-- Financial integrity: extend the receipted-session-payment lock to managers too (owner policy, 2026-10-20).
--
-- Policy (explicitly approved by the owner): "Once a receipt has been issued for a payment, no user --
-- including managers -- may modify or delete that payment while the receipt remains active." This closes the
-- one remaining asymmetry between the two receipt locks introduced on this branch: the account-payment guard
-- added by 20261020110000_guard_receipted_account_payments.sql already has no manager exemption; the
-- session-payment guard added earlier, by 20261013140000_lock_receipted_session_payments_for_coaches.sql
-- (a prior, separate release -- not touched here, only superseded by this forward-only migration), still had
-- one: `if v_uid is null or public.is_manager(v_uid) then return ...`. That exemption is removed below. The
-- `v_uid is null` branch is kept: it exists for system/cron/service paths that have no end user at all (no
-- legitimate write to these tables' payment fields ever happens from such a path today -- only
-- set_registration_attendance, set_manual_participant_attendance, staff_move_session_participant and
-- _revert_document_payment touch amount_paid/payment_method/payment_recorded_at/payment_recorded_by, and all
-- four require an authenticated end user), so removing it would have no effect except making the function
-- fragile against a hypothetical future internal caller; it is left exactly as-is.
--
-- Verified (read-only) before writing this migration, because the concern is real: does cancel_document's
-- existing `p_revert_payment = true` path (manager-only, per 20261013130000's patch) still work once managers
-- can no longer bypass this guard? Read cancel_document's full current body
-- (20260831130000_cancel_document_optional_payment_revert.sql) and _revert_document_payment's full body
-- (20260629160000_cancel_document_revert_payment.sql, the only definition of either function in the
-- repository). cancel_document always sets `documents.status = 'CANCELLED'` FIRST, in the same transaction,
-- and only THEN calls _revert_document_payment, which clears amount_paid/payment_method/payment_recorded_at/
-- payment_recorded_by on the session_registrations/session_manual_participants row (for a 'session_payment'
-- source) or hard-deletes the athlete_account_payments row (for an 'account_payment' source). By the time
-- either of those writes happens, _payment_has_active_document (which both this trigger and
-- _guard_receipted_account_payment call) already sees the document's status as 'CANCELLED' --
-- `status <> 'CANCELLED'` is false -- so the guard does not fire, for any caller, manager or otherwise. This is
-- re-verified by a dedicated regression test (supabase/tests/183) rather than relied on by inspection alone.
--
-- Requirements this satisfies (owner policy, section 1):
--   1/2. Managers cannot change a receipted payment's amount or method -- the manager early-return is gone, so
--        the function falls through to the same amount/method/date/recorded-by/no-show comparison every other
--        caller already goes through.
--   3. Managers cannot delete a receipted payment row -- same trigger, BEFORE DELETE, same removed exemption.
--   4. Coaches: unaffected -- they were never exempted by this trigger; this migration touches nothing in
--      their path.
--   5. Athletes: unaffected -- they have no write access to these tables at all (RLS), and never did.
--   6. Applies to both tables -- the same trigger function serves both (tg_table_name switches `v_kind`,
--      unchanged).
--   7/8/9. Unrelated session-management functionality, attendance-only changes and other non-payment-field
--      changes are preserved exactly: the existing "did a receipt-relevant field actually change" comparison
--      (lines unchanged) already lets anything else through; this migration does not touch that comparison.
--   10. All mutation paths: unchanged from before -- this is still a table-level trigger (not a change to any
--       RPC body), so it already covers every current and future write path uniformly.

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_receipted_session_payment') <> 1 then
    raise exception 'precondition: _guard_receipted_session_payment must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_receipted_session_payment')
     <> '69b802658874d48ce20f4f9f7080cda8' then
    raise exception 'precondition: source of _guard_receipted_session_payment differs from the reviewed version; refusing to change it';
  end if;
end $$;

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
  -- system / cron / service paths only (no end user); no legitimate end-user caller is exempted any more --
  -- see migration header for why managers lost their exemption.
  if v_uid is null then
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
            detail = 'A receipt has been issued for this payment; it can no longer be modified or deleted. Cancel the receipt first if a correction is required.';
  end if;
  return coalesce(new, old);
end;
$$;

comment on function public._guard_receipted_session_payment() is
  'Refuses ANY change (including by a manager, since 2026-10-20 -- see migration 20261020140000) to the receipt-relevant fields of a session_registrations/session_manual_participants row, or deletion of its row, once an active receipt has been issued for it.';

-- Self-check: the exemption is gone; the attendance-only / non-payment pass-through and the system/cron
-- exemption both survive untouched.
do $$
declare
  v_src text;
begin
  select prosrc into v_src from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_receipted_session_payment';
  if v_src like '%is_manager(v_uid)%' then
    raise exception 'self-check: the manager exemption is still present';
  end if;
  if v_src not like '%v_uid is null then%' then
    raise exception 'self-check: the system/cron no-end-user exemption was lost';
  end if;
  if v_src not like '%is not distinct from%' then
    raise exception 'self-check: the attendance-only / non-payment pass-through was lost';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'session_registrations' and t.tgname = 'session_registrations_receipted_payment_guard' and not t.tgisinternal
  ) or not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'session_manual_participants' and t.tgname = 'session_manual_participants_receipted_payment_guard' and not t.tgisinternal
  ) then
    raise exception 'self-check: one of the two guard triggers is missing';
  end if;
  if has_function_privilege('authenticated', 'public._guard_receipted_session_payment()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._guard_receipted_session_payment()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _guard_receipted_session_payment must stay client-unreachable as a direct call';
  end if;
end $$;

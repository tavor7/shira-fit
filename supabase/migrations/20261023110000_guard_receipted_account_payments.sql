-- Financial integrity (FIN-1): protect an account payment once a receipt has been issued for it.
--
-- Session payments (session_registrations / session_manual_participants) already get this protection from
-- _guard_receipted_session_payment (20261013140000_lock_receipted_session_payments_for_coaches.sql), but that
-- trigger explicitly EXEMPTS managers ("Managers keep their existing capabilities") -- a deliberate owner
-- decision from 2026-10-11 for that table. athlete_account_payments has no equivalent guard at all today
-- (verified: grepped every migration for "guard_receipted" / "guard_delete" -- the only hits are the
-- session-payment file above), so right now ANY manager can freely edit or delete an athlete_account_payments
-- row after a receipt has been issued against it (documents.source_type = 'account_payment',
-- source_id = the payment's id), silently desyncing the receipt from the payment it documents. Verified
-- read-only against production: zero orphaned account-payment receipts and zero amount/method mismatches exist
-- today, so this is preventative, not a repair.
--
-- Deliberate design choice, different from the session-payment precedent: the invariant requested for THIS
-- release ("an existing issued receipt must never become inconsistent with the payment it documents") is
-- stated with no manager exception anywhere in the requirements (the required error message is "the payment
-- cannot be modified or deleted", full stop), so this guard blocks EVERY role, including managers, once a
-- receipt exists. This is intentionally a separate, stricter guard rather than an extension of
-- _guard_receipted_session_payment -- re-read that function's "if v_uid is null or is_manager(v_uid) then
-- return" exemption before assuming the two tables behave identically; they do not, on purpose. If a manager
-- needs to correct a receipted account payment, the existing, already-audited path is: cancel_document (manager
-- only, requires a reason, keeps the cancelled document as an audit row) first, then edit the payment, then
-- optionally issue a new receipt -- exactly the workflow the session-payment lock already relies on, and
-- nothing new is introduced here.
--
-- Protected fields (every column this table has besides id/created_by/created_at, all of which the receipt is
-- derived from at issue time -- see _create_document_from_payment_row): amount_ils, payment_method, paid_at,
-- payee_id, payee_is_manual, payer_name, note (note is also read as the receipt's service_description
-- fallback, so it is receipt-relevant too). Any DELETE is blocked unconditionally while an active document
-- exists; an UPDATE is blocked only if one of these fields actually changes, so unrelated no-op saves still
-- pass.

create or replace function public._guard_receipted_account_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and (new.amount_ils, new.payment_method, new.paid_at, new.payee_id, new.payee_is_manual, new.payer_name, new.note)
         is not distinct from
         (old.amount_ils, old.payment_method, old.paid_at, old.payee_id, old.payee_is_manual, old.payer_name, old.note) then
    return new;  -- no receipt-relevant field changed
  end if;
  if public._payment_has_active_document('account', old.id) then
    raise exception 'account_payment_locked_receipt_issued'
      using errcode = 'P0001',
            detail = 'A receipt has been issued for this account payment; it can no longer be modified or deleted. Cancel the receipt first if a correction is required.';
  end if;
  return coalesce(new, old);
end;
$$;

comment on function public._guard_receipted_account_payment() is
  'Refuses ANY change (including by a manager) to the receipt-relevant fields of an athlete_account_payments row, or deletion of its row, once an active receipt has been issued for it. Unlike _guard_receipted_session_payment, there is no manager exemption here -- see migration header.';

drop trigger if exists athlete_account_payments_receipted_guard on public.athlete_account_payments;
create trigger athlete_account_payments_receipted_guard
  before update or delete on public.athlete_account_payments
  for each row execute function public._guard_receipted_account_payment();

-- Concurrency: serialise against receipt issuance exactly like the session-payment lock already does.
-- _lock_session_payment_for_receipt already runs BEFORE INSERT OR UPDATE OF status/source_id/source_type on
-- documents, and before insert/update of row_kind/record_id on external_manual_receipts, taking a FOR UPDATE
-- lock on the underlying payment row before the receipt commits. Extending it (rather than adding a second,
-- independently-ordered trigger on the same tables) keeps a single, well-understood lock-ordering point. The
-- existing session_payment branches are preserved verbatim; only an account_payment branch is added.
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
    if new.status = 'CANCELLED' or new.source_id is null then
      return new;
    end if;
    if new.source_type = 'session_payment' then
      v_id := new.source_id;
      perform 1 from public.session_registrations where id = v_id for update;
      perform 1 from public.session_manual_participants where id = v_id for update;
    elsif new.source_type = 'account_payment' then
      perform 1 from public.athlete_account_payments where id = new.source_id for update;
    end if;
  else
    v_kind := new.row_kind;
    v_id := new.record_id;
    if v_kind = 'session_reg' then
      perform 1 from public.session_registrations where id = v_id for update;
    elsif v_kind = 'session_manual' then
      perform 1 from public.session_manual_participants where id = v_id for update;
    elsif v_kind = 'account' then
      perform 1 from public.athlete_account_payments where id = v_id for update;
    end if;
  end if;
  return new;
end;
$$;

-- Trigger functions are not RPCs.
revoke execute on function public._guard_receipted_account_payment() from public, anon, authenticated;

-- Self-check.
do $$
begin
  if not exists (
    select 1 from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where c.relname = 'athlete_account_payments' and t.tgname = 'athlete_account_payments_receipted_guard' and not t.tgisinternal
  ) then
    raise exception 'self-check: athlete_account_payments_receipted_guard trigger missing';
  end if;
  if has_function_privilege('authenticated', 'public._guard_receipted_account_payment()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._guard_receipted_account_payment()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _guard_receipted_account_payment must stay client-unreachable as a direct call';
  end if;
  -- the session-payment lock function must still exist and still be a trigger on the same tables as before
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'documents' and t.tgname = 'documents_lock_session_payment' and not t.tgisinternal
  ) then
    raise exception 'self-check: documents_lock_session_payment trigger was lost';
  end if;
end $$;

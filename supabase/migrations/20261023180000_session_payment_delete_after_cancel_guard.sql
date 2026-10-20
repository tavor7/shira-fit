-- Financial integrity: apply the same "once receipted, never deletable" rule to session payments
-- (owner policy, 2026-10-22) -- narrowly scoped to DELETE only, per the explicit instruction not to
-- unnecessarily block attendance changes or redesign session-payment accounting.
--
-- Investigated first: session_registrations is never hard-deleted anywhere in this codebase (cancellation is
-- always a status change) -- confirmed by grepping every migration for a literal `delete from
-- public.session_registrations`: zero hits. session_manual_participants IS hard-deleted in normal operation
-- (removing/moving a quick-add participant: remove_manual_participant_from_session, staff_move_session_participant).
-- That is the one real gap this migration closes: today, _guard_receipted_session_payment blocks DELETE only
-- while an ACTIVE document exists (_payment_has_active_document); once that document is merely CANCELLED (not
-- reversed), the manual-participant row -- the only remaining link between "a receipt was issued" and "what was
-- actually paid" for a cancelled-but-unreversed session receipt -- could be deleted outright, destroying that
-- link. UPDATE behavior (ordinary attendance/payment corrections) is intentionally left exactly as it was: this
-- migration touches only the DELETE branch.
--
-- Session payments still have no reversed_at-style marker (not introduced here -- out of scope; see the final
-- report). A session payment reversed via _revert_document_payment is cleared in place, and that cleared row
-- remains covered by this same rule once any document (cancelled or not) has ever referenced it, so the
-- historical fact "a receipt existed for this row" is never lost even though the live amount_paid is now null.

do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_receipted_session_payment') <> 1 then
    raise exception 'precondition: _guard_receipted_session_payment must have exactly one overload';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_receipted_session_payment')
     like '%is_manager(v_uid)%' then
    raise exception 'precondition: _guard_receipted_session_payment still has the manager exemption (expected it removed by 20261023140000); refusing to change it';
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
  if v_uid is null then
    return coalesce(new, old);  -- system/cron/service paths only
  end if;

  if tg_op = 'DELETE' then
    if public._payment_has_any_document(v_kind, old.id) then
      raise exception 'session_payment_has_receipt_history'
        using errcode = 'P0001',
              detail = 'A receipt has been issued at some point for this participant''s session payment (even if later cancelled); the row cannot be removed. Move or cancel the session instead if a correction is required.';
    end if;
    return old;
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
  'Refuses ANY change to the receipt-relevant fields of a session_registrations/session_manual_participants row, or deletion of its row, once an active receipt has been issued for it (unchanged from 2026-10-20). As of 2026-10-22: DELETE is additionally refused once ANY document (including a cancelled one) has ever referenced this row, narrowly extending history protection to DELETE only, mirroring the account-payment rule.';

-- Self-check.
do $$
begin
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_guard_receipted_session_payment') not like '%session_payment_has_receipt_history%' then
    raise exception 'self-check: the ever-receipted delete guard is missing';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_guard_receipted_session_payment') like '%is_manager(v_uid)%' then
    raise exception 'self-check: the manager exemption regressed';
  end if;
end $$;

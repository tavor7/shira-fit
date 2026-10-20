-- Financial integrity: final four-state model for athlete_account_payments (owner policy, 2026-10-22).
--
-- State A (never receipted): edit/delete unchanged, subject to existing manager-only RLS -- no new restriction.
-- State B (active receipt): cannot edit, cannot delete -- unchanged from the prior release.
-- State C (receipt cancelled, payment still active -- reversed_at IS NULL): may still be corrected by a manager
--   (unchanged), but -- NEW this round -- can no longer be physically DELETED, because it has already been
--   associated with an issued financial document (even though that document is now cancelled, the document
--   itself, and its own audit trail, still reference this exact payment row by id; deleting the row would orphan
--   that reference). This was a real gap: before this migration, a cancelled-but-not-reversed payment could be
--   deleted outright once its receipt was cancelled (_payment_has_active_document returns false for a cancelled
--   document, and the prior guard only checked that).
-- State D (reversed_at IS NOT NULL): fully immutable -- cannot be edited (at all, not just the previously-checked
--   "receipt-relevant fields"), cannot be deleted, cannot be un-reversed by ordinary editing, and (companion
--   migration 20261022... already in place from the prior release) cannot receive a new receipt.
--
-- Mechanism for "only the authorized cancellation workflow may reverse a payment" (owner policy, section 5):
-- a transaction-local setting (set_config(..., true), auto-reset at COMMIT/ROLLBACK -- the same technique already
-- used by manager_revert_activity_event's shira.skip_activity_log) is set by _revert_document_payment
-- immediately before its one UPDATE statement, and checked by the trigger for the specific "reversed_at going
-- from null to not-null" transition only. No other function in this codebase sets it; it cannot be set through
-- PostgREST (set_config is not a client-exposed RPC and a REST request is a single statement, so a client cannot
-- smuggle it in before an UPDATE); a SECURITY DEFINER function that doesn't set it gets the same refusal as a
-- direct client update. This is a narrow, specific permission check, not an unrestricted SECURITY DEFINER bypass
-- -- the guard still runs unconditionally and still enforces every other rule in this migration.

create or replace function public._payment_has_any_document(p_row_kind text, p_record_id uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.documents d
    where d.source_id = p_record_id
      and d.source_type = public._payment_document_source_type(p_row_kind)
  )
  or exists (
    select 1
    from public.external_manual_receipts e
    where e.row_kind = p_row_kind
      and e.record_id = p_record_id
  );
$$;

comment on function public._payment_has_any_document(text, uuid) is
  'Unlike _payment_has_active_document, this is true even if the only document ever issued for this payment is now CANCELLED (status is not checked at all) -- used to decide whether a payment row may ever be physically deleted (it may not, once any in-system or external receipt has ever existed for it). Mirrors _payment_has_active_document''s two sources (documents + external_manual_receipts), just without the status filter on the former.';

-- Precondition: refuse to run against a database that doesn't already have this branch's prior guard/reversal
-- migrations applied (20261020110000, 20261021100000) -- checked by distinctive substrings from those migrations
-- rather than an exact source hash, since both are this branch's own prior output, not an unmodified production
-- function with one fixed, independently-knowable hash.
do $$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_receipted_account_payment') <> 1 then
    raise exception 'precondition: _guard_receipted_account_payment must have exactly one overload';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = '_guard_receipted_account_payment')
     not like '%account_payment_locked_receipt_issued%' then
    raise exception 'precondition: _guard_receipted_account_payment does not look like this branch''s prior version; refusing to change it';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_revert_document_payment') <> 1 then
    raise exception 'precondition: _revert_document_payment must have exactly one overload';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = '_revert_document_payment')
     not like '%reversed_at = now()%' then
    raise exception 'precondition: _revert_document_payment does not look like this branch''s prior (reversal-by-status) version; refusing to change it';
  end if;
end $$;

create or replace function public._guard_receipted_account_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
$$;

comment on function public._guard_receipted_account_payment() is
  'Enforces the four-state payment model (2026-10-22): never-receipted rows are unrestricted; an actively-receipted row cannot be touched; a cancelled-but-not-reversed row may still be corrected but can never again be deleted (it has receipt history); a reversed row (reversed_at is not null) is fully immutable and can only be transitioned into by the authorized cancel+revert workflow (shira.allow_payment_reversal, set only by _revert_document_payment).';

create or replace function public._revert_document_payment(
  p_source_type public.document_source_type,
  p_source_id uuid
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows int;
begin
  if p_source_id is null or p_source_type is null or p_source_type = 'manual' then
    return json_build_object('ok', true, 'reverted', false, 'reason', 'no_linked_payment');
  end if;

  case p_source_type
    when 'account_payment' then
      perform set_config('shira.allow_payment_reversal', 'on', true);
      update public.athlete_account_payments
      set reversed_at = now(), reversed_by = auth.uid()
      where id = p_source_id and reversed_at is null;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found_or_already_reversed');
      end if;
      return json_build_object('ok', true, 'reverted', true, 'kind', 'account_payment');

    when 'session_payment' then
      update public.session_registrations
      set
        amount_paid = null,
        payment_method = null,
        payment_recorded_at = null,
        payment_recorded_by = null
      where id = p_source_id
        and coalesce(amount_paid, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        return json_build_object('ok', true, 'reverted', true, 'kind', 'session_payment', 'target', 'registration');
      end if;

      update public.session_manual_participants
      set
        amount_paid = null,
        payment_method = null,
        payment_recorded_at = null,
        payment_recorded_by = null
      where id = p_source_id
        and coalesce(amount_paid, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows > 0 then
        return json_build_object('ok', true, 'reverted', true, 'kind', 'session_payment', 'target', 'manual');
      end if;
      return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found');

    when 'cancellation_penalty' then
      update public.cancellations
      set penalty_collected_ils = 0
      where id = p_source_id
        and coalesce(penalty_collected_ils, 0) > 0;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then
        return json_build_object('ok', true, 'reverted', false, 'reason', 'payment_not_found');
      end if;
      return json_build_object('ok', true, 'reverted', true, 'kind', 'cancellation_penalty');

    else
      return json_build_object('ok', true, 'reverted', false, 'reason', 'unsupported_source');
  end case;
end;
$$;

comment on function public._revert_document_payment(public.document_source_type, uuid) is
  'Reverses the financial effect of a payment whose receipt is being cancelled. For account payments, sets a transaction-local flag (shira.allow_payment_reversal) immediately before the one UPDATE that marks reversed_at/reversed_by, so _guard_receipted_account_payment can tell this authorized transition apart from any direct attempt. Session payments are cleared in place (unchanged, pre-existing behavior).';

-- Trigger function is not an RPC (unchanged grant posture from the prior release).
revoke execute on function public._guard_receipted_account_payment() from public, anon, authenticated;
revoke execute on function public._payment_has_any_document(text, uuid) from public, anon, authenticated;

-- Self-check.
do $$
begin
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_guard_receipted_account_payment') not like '%account_payment_reversed_immutable%' then
    raise exception 'self-check: the reversed-immutability rule is missing';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_guard_receipted_account_payment') not like '%account_payment_has_receipt_history%' then
    raise exception 'self-check: the ever-receipted delete guard is missing';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_guard_receipted_account_payment') not like '%shira.allow_payment_reversal%' then
    raise exception 'self-check: the authorized-reversal-only check is missing';
  end if;
  if (select prosrc from pg_proc where pronamespace='public'::regnamespace and proname='_revert_document_payment') not like '%shira.allow_payment_reversal%' then
    raise exception 'self-check: _revert_document_payment does not set the authorization flag';
  end if;
end $$;

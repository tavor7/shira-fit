-- Security (SEC-1): close a residual coach-authorization gap in receipt issuance.
--
-- 20261013130000_restrict_coach_financial_access.sql rewrote 12 finance RPCs from is_coach_or_manager to
-- is_manager, closing the studio-wide coach access that preceded it. create_documents_from_payments --
-- the bulk wrapper around _create_document_from_payment_row that actually inserts a real tax receipt
-- (`documents` row) for one or more existing payments -- was added one day later, in
-- 20261014170000_record_bulk_receipt_row_cap_500.sql, and was never added to that patch list. Its guard is
-- still `is_coach_or_manager`, so a coach (not just a manager) can call it directly over the REST API and
-- issue a real receipt for any payment row id it can obtain or enumerate, even though the one path that
-- would normally let staff discover un-receipted rows (staff_list_payments_without_receipt) has been
-- manager-only since 20261013130000. This is an oversight in that pass, not a deliberate exception: every
-- other receipt-issuance entry point (create_document, create_document_with_payment, cancel_document,
-- set_document_payment_method, mark/unmark_payment_receipt_external, list_documents,
-- staff_session_receipt_roster, staff_list_received_payments) is already manager-only.
--
-- Verified before this migration (read-only queries against production, vtngzvelcuagrfynzlfn):
--   - md5(prosrc) of the live function is 89d8644686313aae837d12b84cc235b5, matching the body committed in
--     20261014170000_record_bulk_receipt_row_cap_500.sql verbatim (that migration's own self-check already
--     pins md5(pg_get_functiondef(...)) = 'da1521698be186f75620d6ffeecb5826' for the same source).
--   - EXECUTE on create_documents_from_payments is granted to anon, authenticated, public, service_role and
--     postgres today -- the SAME grant shape as every sibling receipt RPC (create_document,
--     create_document_with_payment, cancel_document, staff_list_payments_without_receipt all show the
--     identical anon/public/authenticated/service_role/postgres grant set). This is the established house
--     pattern for these client entry points: authorization lives entirely in the internal auth.uid()/role
--     check inside the function body, not in the GRANT. This migration follows that same convention --
--     it does not revoke EXECUTE from anon/authenticated/public, which would be an inconsistent, one-off
--     deviation from every sibling RPC; it only fixes the internal guard, exactly as 20261013130000 did for
--     the other 12.
--   - Production currently has zero orphaned account-payment receipts and zero amount/method mismatches
--     between a document and the payment it documents (read-only verification queries run against
--     production), so there is no existing abuse to react to -- this is a preventative fix.
--
-- Requirement coverage (owner policy: managers may issue receipts; coaches, athletes and anonymous callers
-- may not):
--   1. Only authenticated managers may issue receipts via this RPC       -> is_manager(v_uid) guard below.
--   2. Coaches cannot issue receipts                                    -> same guard (coach fails is_manager).
--   3. Athletes cannot issue receipts                                   -> same guard.
--   4. Anonymous callers cannot issue receipts                          -> the existing `v_uid is null` check,
--                                                                          unchanged, still returns first.
--   5. Authorization enforced inside the RPC                            -> unchanged (SECURITY DEFINER body).
--   6. EXECUTE privileges restricted to the minimum required roles      -> unchanged from the established
--                                                                          pattern (see above); no new grant
--                                                                          introduced, none removed.
--   7. Internal helpers not independently callable                     -> already true:
--      _create_document_from_payment_row had client EXECUTE revoked by
--      20261013120000_revoke_client_execute_on_internal_functions.sql; re-verified by this migration's
--      self-check below.
--   8/9/10. Existing manager receipt functionality, numbering, batch-size cap (500) unchanged -- this
--      migration changes exactly one guard call and nothing else in the function body.

do $$
declare
  v_def text;
begin
  -- Precondition: refuse to touch a function whose source has drifted from what was reviewed above.
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments') <> 1 then
    raise exception 'precondition: create_documents_from_payments must have exactly one overload';
  end if;
  if (select md5(prosrc) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments')
     <> '89d8644686313aae837d12b84cc235b5' then
    raise exception 'precondition: source of create_documents_from_payments differs from the reviewed version; refusing to change it';
  end if;
  if (select (length(prosrc) - length(replace(prosrc, 'is_coach_or_manager(', ''))) / length('is_coach_or_manager(')
      from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments') <> 1 then
    raise exception 'precondition: create_documents_from_payments must contain exactly one is_coach_or_manager( guard';
  end if;
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'create_documents_from_payments';
  -- create or replace keeps owner, ACL, SECURITY DEFINER and search_path.
  execute replace(v_def, 'is_coach_or_manager(', 'is_manager(');
end $$;

comment on function public.create_documents_from_payments(jsonb) is
  'Bulk-create receipt documents for existing payments by staff_list_received_payments row_id values. Accepts up to 500 row ids per call. Manager-only (fixed 2026-10-20: previously admitted coaches, an oversight in the 2026-10-13 hardening pass).';

-- Self-check: the guard is now manager-only, the batch cap and internal-helper lockdown are untouched, and
-- every sibling receipt RPC this migration does not touch is still manager-only (regression guard against
-- this migration accidentally being the only one applied, or a future revert of 20261013130000).
do $$
begin
  if exists (
    select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments'
      and (prosrc like '%is_coach_or_manager(%' or prosrc not like '%is_manager(%' or not prosecdef)
  ) then
    raise exception 'self-check: create_documents_from_payments is not manager-only definer';
  end if;
  if (select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_documents_from_payments')
     not like '%jsonb_array_length(p_row_ids) > 500%' then
    raise exception 'self-check: the 500-row batch cap was not preserved';
  end if;
  if has_function_privilege('authenticated', 'public._create_document_from_payment_row(text)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._create_document_from_payment_row(text)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _create_document_from_payment_row must stay client-unreachable';
  end if;
  if exists (
    select 1 from pg_proc where pronamespace = 'public'::regnamespace
      and proname in ('cancel_document','create_document','create_document_with_payment','get_receipt_settings',
        'has_later_issued_receipt','list_documents','mark_payment_receipt_external','set_document_payment_method',
        'staff_list_payments_without_receipt','staff_list_received_payments','staff_session_receipt_roster',
        'unmark_payment_receipt_external')
      and prosrc like '%is_coach_or_manager(%'
  ) then
    raise exception 'self-check: a sibling receipt RPC regressed to admitting coaches';
  end if;
end $$;

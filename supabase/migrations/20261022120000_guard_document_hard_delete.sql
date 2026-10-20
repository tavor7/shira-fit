-- Financial integrity: close delete_document's destructive path by making documents/document_events append-only
-- at the database level (owner policy, 2026-10-22).
--
-- Investigation (read-only, production, full current body of delete_document read via pg_get_functiondef):
--   1. Who can invoke it: manager-only (`is_manager(auth.uid())` check inside the function body).
--   2. Accessible via PostgREST: yes, as an RPC (`supabase.rpc('delete_document', ...)`) -- there is no grant
--      restriction beyond the internal check (same "anon/authenticated granted, authorization lives in the body"
--      pattern as every other client-facing document RPC in this codebase).
--   3. Managers can invoke it: yes, when `receipt_settings.is_operational = false`; the function itself returns
--      `operational_mode_locked` otherwise. Verified read-only against production: is_operational is currently
--      false, so the function is live and callable today -- `is_operational=false` is NOT a safe production
--      barrier, exactly as the brief warns; it is a testing-mode feature flag the function's own author added,
--      not an infrastructure boundary.
--   4. UI paths: not located in the mobile app (grepped mobile/src for "delete_document" -- no call site found);
--      it exists only as a directly-callable RPC, presumably for manual/CLI use during setup.
--   5. Document types affected: it operates on any row in `documents` regardless of `service_type` or
--      `source_type` -- a real receipt, an invoice, or a freeform 'manual' document are all equally deletable.
--   6. Status: it does not check `status` at all -- an ACTIVE or a CANCELLED document can both be hard-deleted.
--   7/8. Payments: if `p_delete_payment` is true and `source_type = 'account_payment'`, it directly
--      `DELETE FROM athlete_account_payments` (bypassing the normal reversal workflow entirely -- no
--      reversed_at/reversed_by, no auditability); for `session_payment` it nulls the payment fields in place
--      (same effect _revert_document_payment already produces, not an additional risk by itself); for
--      `cancellation_penalty` it zeroes the penalty. It then unconditionally
--      `DELETE FROM document_events WHERE document_id = ...` and `DELETE FROM documents WHERE id = ...` --
--      the document and its entire audit trail vanish with no trace.
--   9. No other function in this codebase hard-deletes from `documents` or `document_events` -- confirmed by
--      grepping every migration for a literal `delete from public.documents` / `delete from
--      public.document_events`: the only two hits for each are delete_document's two historical definitions.
--
-- Decision (per the brief's own instruction): there is no reliable, safe way in the current schema to
-- distinguish "test fixture" documents from "real" financial documents -- both are ordinary rows in the same
-- table with the same columns. Rather than invent a fragile heuristic (e.g. a date cutoff, a business_id
-- pattern, or a manual allowlist) that could itself be wrong in either direction, this migration makes EVERY
-- document and EVERY document_events row permanently undeletable, unconditionally, for every caller including
-- delete_document itself and any future manager tooling -- the same choice already made for subscription/billing
-- history (20261020130000_guard_subscription_hard_delete.sql) and for sessions with a receipt
-- (20261020120000_guard_delete_receipted_sessions.sql). Accepted, explicit consequence: delete_document's
-- p_delete_payment=true account-payment branch was already independently blocked by
-- 20261022100000 (the document referencing that payment still exists at the moment that DELETE runs, so
-- _guard_receipted_account_payment's "ever had a receipt" rule refuses it before delete_document even reaches
-- its own `delete from documents` statement); this migration additionally makes delete_document fail outright
-- for every other case too (a document with no payment, or p_delete_payment=false), because its own final
-- `delete from public.documents` statement can no longer succeed -- and since that failure happens inside the
-- same transaction as everything delete_document already did (including the document_events delete and any
-- session-payment field clearing), the whole call rolls back atomically; nothing it touched is left half-done.
-- delete_document therefore becomes fully inert for every input, in every mode (testing or operational),
-- matching the brief's instruction to prioritize financial-history integrity over preserving any test-data
-- cleanup convenience when a safe distinction does not exist. cancel_document (status update only, never a
-- physical delete) remains the sole, correct way to void a document, and is completely unaffected by this
-- migration.

create or replace function public._reject_document_hard_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'document_record_immutable'
    using errcode = 'P0001',
          detail = format(
            'Rows in %I are append-only financial/audit history and cannot be hard-deleted, in any mode. Use cancel_document to void a document instead.',
            tg_table_name
          );
  return old;
end;
$$;

comment on function public._reject_document_hard_delete() is
  'Unconditionally refuses a hard DELETE on documents or document_events, regardless of caller, including delete_document and service_role. No legitimate client path needs this (cancel_document is a status update, never a physical delete) -- see migration header for the full investigation.';

drop trigger if exists documents_hard_delete_guard on public.documents;
create trigger documents_hard_delete_guard
  before delete on public.documents
  for each row execute function public._reject_document_hard_delete();

drop trigger if exists document_events_hard_delete_guard on public.document_events;
create trigger document_events_hard_delete_guard
  before delete on public.document_events
  for each row execute function public._reject_document_hard_delete();

revoke execute on function public._reject_document_hard_delete() from public, anon, authenticated;

-- Self-check.
do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'documents' and t.tgname = 'documents_hard_delete_guard' and not t.tgisinternal
  ) then
    raise exception 'self-check: documents_hard_delete_guard trigger missing';
  end if;
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'document_events' and t.tgname = 'document_events_hard_delete_guard' and not t.tgisinternal
  ) then
    raise exception 'self-check: document_events_hard_delete_guard trigger missing';
  end if;
  if has_function_privilege('authenticated', 'public._reject_document_hard_delete()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._reject_document_hard_delete()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _reject_document_hard_delete must stay client-unreachable as a direct call';
  end if;
end $$;

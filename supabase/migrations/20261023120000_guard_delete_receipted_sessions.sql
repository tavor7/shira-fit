-- Financial integrity: a session must not be deleted while an issued receipt documents a payment on it.
--
-- Session deletion in this codebase funnels through exactly one authoritative entry point,
-- staff_delete_session_series_scope (single session, series scope 'this', series scope 'future' -- all three
-- branches end in `delete from public.training_sessions ...`, verified by reading its full current body,
-- 20261005140000_series_delete_future_tombstone_occurrences.sql). There are, however, several OTHER paths that
-- also issue a raw `delete from public.training_sessions`, verified by grepping every migration:
--   - manager_clear_sessions_for_day(p_date)            -- bulk, whole-day delete, no receipt check at all today
--   - manager_revert_activity_event(...)                -- 'session_created' case: undoes session creation by
--                                                           deleting the row outright, bypassing every other guard
--   - reconcile_series_duplicate_sessions() and the series-slot duplicate-prevention logic -- these only ever
--     delete sessions with zero roster rows (_session_roster_size(...) = 0), so they can never be blocked by
--     this guard (no participants means no payment means no receipt); verified by reading their bodies.
--   - RLS also permits a manager to DELETE training_sessions directly over PostgREST (`sessions_manager_delete`
--     policy), entirely outside any RPC.
--
-- Rather than patch each entry point (and have to remember to patch the next one), this is enforced as a single
-- BEFORE DELETE row trigger on training_sessions, so it applies uniformly to every path above, present or
-- future, including direct PostgREST deletes.
--
-- Scope of the check: only payments actually belonging to the session being deleted (its own
-- session_registrations and session_manual_participants rows) -- never an unrelated account payment, a receipt
-- for a different session, a subscription payment, or another session's receipt. This avoids every false
-- positive the brief calls out explicitly.
--
-- Atomicity: no try/catch anywhere in this migration. A raised exception aborts the current SQL statement (and
-- with it, the whole enclosing function call and anything it already did in the same call -- e.g.
-- manager_clear_sessions_for_day's bulk DELETE, or staff_delete_session_series_scope's 'future' scope, which
-- first updates session_series and tombstones occurrences before deleting) -- Postgres's normal statement
-- atomicity, not a mechanism invented here. This is also the same convention _guard_receipted_session_payment
-- already uses for payment_locked_receipt_issued (an uncaught raise, not a caught-and-converted {ok:false,...}
-- JSON return), so the client-side handling pattern (match the raised message text, as
-- ParticipantAttendanceList.tsx already does for payment_locked_receipt_issued) is already established and
-- reused here rather than inventing a second error-surfacing convention.
--
-- Concurrency: locks the session's session_registrations / session_manual_participants rows FOR UPDATE before
-- checking them, serialising with _lock_session_payment_for_receipt (which takes the same FOR UPDATE lock on
-- the same rows before a receipt-issuing insert into documents/external_manual_receipts commits) -- identical
-- lock-ordering discipline to the existing receipted-session-payment guard. Whichever side reaches the row
-- first wins the race deterministically; there is no window where a receipt can be issued and a delete can
-- both succeed for the same payment.

create or replace function public._guard_delete_receipted_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  for v_id in
    select id from public.session_registrations where session_id = old.id for update
  loop
    if public._payment_has_active_document('session_reg', v_id) then
      raise exception 'session_has_receipted_payment'
        using errcode = 'P0001',
              detail = 'A receipt has been issued for a payment on this session; it cannot be deleted. Cancel the receipt first if a correction is required.';
    end if;
  end loop;

  for v_id in
    select id from public.session_manual_participants where session_id = old.id for update
  loop
    if public._payment_has_active_document('session_manual', v_id) then
      raise exception 'session_has_receipted_payment'
        using errcode = 'P0001',
              detail = 'A receipt has been issued for a payment on this session; it cannot be deleted. Cancel the receipt first if a correction is required.';
    end if;
  end loop;

  return old;
end;
$$;

comment on function public._guard_delete_receipted_session() is
  'Refuses to delete a training_sessions row while any of its registrations/manual participants has an active issued receipt. Applies to every delete path (BEFORE DELETE row trigger), including direct PostgREST deletes, bulk day-clear, series scope delete, and activity-log revert of session creation.';

drop trigger if exists training_sessions_delete_receipt_guard on public.training_sessions;
create trigger training_sessions_delete_receipt_guard
  before delete on public.training_sessions
  for each row execute function public._guard_delete_receipted_session();

-- Trigger function is not an RPC.
revoke execute on function public._guard_delete_receipted_session() from public, anon, authenticated;

-- Self-check.
do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'training_sessions' and t.tgname = 'training_sessions_delete_receipt_guard' and not t.tgisinternal
  ) then
    raise exception 'self-check: training_sessions_delete_receipt_guard trigger missing';
  end if;
  if has_function_privilege('authenticated', 'public._guard_delete_receipted_session()'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._guard_delete_receipted_session()'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: _guard_delete_receipted_session must stay client-unreachable as a direct call';
  end if;
end $$;

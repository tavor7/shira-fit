-- Revoke anon EXECUTE on the two new subscription RPCs (defense in depth; narrowly scoped).
--
-- stop_subscription_with_future_registrations and delete_subscription_with_future_registrations
-- (20261026180000) were granted `to authenticated` but, like every function in Postgres, also got an
-- implicit EXECUTE grant to PUBLIC at creation time -- and PUBLIC is inherited by every role,
-- including anon. A direct `revoke ... from anon` would NOT remove this: anon's effective privilege
-- comes from the PUBLIC entry, not a role-specific one, so revoking from anon alone leaves the PUBLIC
-- grant (and therefore anon's access) untouched. The actual fix is to revoke from PUBLIC itself, which
-- removes the blanket grant for anon (and anyone else without an explicit grant) while leaving
-- authenticated's own separate, explicit `grant ... to authenticated` (already in place from
-- 20261026180000, unchanged here) completely unaffected.
--
-- This is the exact `revoke execute on function ... from public, anon;` idiom already used throughout
-- this codebase for every authenticated-only RPC (e.g. get_my_subscription_terms,
-- accept_subscription_terms, save_subscription_terms_draft, discard_subscription_terms_draft,
-- session_payment_receipt_locks -- see their migrations for the identical pattern).
--
-- Scope: touches ONLY these two functions. No other RPC's grants are read or modified. The functions'
-- own internal `is_manager(auth.uid())` check (already present, unchanged) remains the actual
-- authorization boundary either way -- this migration narrows the transport-layer surface, it does not
-- change who can successfully USE either RPC (an anon caller was already rejected with
-- {ok:false,error:'forbidden'} before this; now PostgREST itself refuses the call before it reaches
-- the function body, one layer earlier). Consistent with every other subscription RPC's authorization
-- model (is_manager/is_authenticated inside the function body), this migration does not touch RLS or
-- any table-level policy.

revoke execute on function public.stop_subscription_with_future_registrations(uuid, date, boolean, text, uuid[], uuid[]) from public, anon;
revoke execute on function public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[]) from public, anon;

-- Self-check: anon loses access; authenticated keeps it; nothing else was touched.
do $$
begin
  if has_function_privilege('anon', 'public.stop_subscription_with_future_registrations(uuid,date,boolean,text,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: anon must not retain EXECUTE on stop_subscription_with_future_registrations';
  end if;
  if has_function_privilege('anon', 'public.delete_subscription_with_future_registrations(uuid,text,boolean,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: anon must not retain EXECUTE on delete_subscription_with_future_registrations';
  end if;
  if not has_function_privilege('authenticated', 'public.stop_subscription_with_future_registrations(uuid,date,boolean,text,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: authenticated must keep EXECUTE on stop_subscription_with_future_registrations';
  end if;
  if not has_function_privilege('authenticated', 'public.delete_subscription_with_future_registrations(uuid,text,boolean,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: authenticated must keep EXECUTE on delete_subscription_with_future_registrations';
  end if;
  -- The two original RPCs this migration must never touch.
  if not has_function_privilege('anon', 'public.stop_subscription(uuid,date,boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: unrelated function stop_subscription must be untouched (anon access unchanged)';
  end if;
  if not has_function_privilege('anon', 'public.delete_subscription(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: unrelated function delete_subscription must be untouched (anon access unchanged)';
  end if;
end $$;

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
--
-- Replay safety (added after this migration was already applied to production -- see
-- 20261026180000's own "(4) REPLAY SAFETY" note): this migration's filename timestamp sorts BEFORE
-- 20261026180000, the migration that actually creates these two functions. Production's real
-- execution order differed from the committed files' filename order (confirmed independently:
-- production's current grants are already correct), but a fresh `supabase db reset` replays strictly
-- by filename and used to fail here with "function ... does not exist" (42883), since the function
-- genuinely doesn't exist yet in a from-scratch replay at this point. Each revoke below is now guarded
-- by to_regprocedure(...) is not null -- Postgres's safe, non-throwing way to ask "does a function
-- with this exact signature exist" (unlike casting a string to regprocedure directly, which errors on
-- a miss) -- so a fresh replay skips both the revoke and its self-check here and relies on
-- 20261026180000's OWN explicit revoke (added in that same fix) for the actual permission-narrowing in
-- that case. Every environment where the function already existed when this migration runs still gets
-- the exact same revoke + self-check as before -- this is a no-op behavior change for any already-
-- migrated installation, including production, which is not being re-run against this edited file.

do $$
begin
  if to_regprocedure('public.stop_subscription_with_future_registrations(uuid,date,boolean,text,uuid[],uuid[])') is not null then
    revoke execute on function public.stop_subscription_with_future_registrations(uuid, date, boolean, text, uuid[], uuid[]) from public, anon;
    if has_function_privilege('anon', 'public.stop_subscription_with_future_registrations(uuid,date,boolean,text,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
      raise exception 'self-check: anon must not retain EXECUTE on stop_subscription_with_future_registrations';
    end if;
    if not has_function_privilege('authenticated', 'public.stop_subscription_with_future_registrations(uuid,date,boolean,text,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
      raise exception 'self-check: authenticated must keep EXECUTE on stop_subscription_with_future_registrations';
    end if;
  end if;

  if to_regprocedure('public.delete_subscription_with_future_registrations(uuid,text,boolean,uuid[],uuid[])') is not null then
    revoke execute on function public.delete_subscription_with_future_registrations(uuid, text, boolean, uuid[], uuid[]) from public, anon;
    if has_function_privilege('anon', 'public.delete_subscription_with_future_registrations(uuid,text,boolean,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
      raise exception 'self-check: anon must not retain EXECUTE on delete_subscription_with_future_registrations';
    end if;
    if not has_function_privilege('authenticated', 'public.delete_subscription_with_future_registrations(uuid,text,boolean,uuid[],uuid[])'::regprocedure, 'EXECUTE') then
      raise exception 'self-check: authenticated must keep EXECUTE on delete_subscription_with_future_registrations';
    end if;
  end if;

  -- The two original RPCs this migration must never touch. Unconditional: both always exist by this
  -- point in every environment (created in 20261013110000 / 20261026100000, long before this file).
  if not has_function_privilege('anon', 'public.stop_subscription(uuid,date,boolean)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: unrelated function stop_subscription must be untouched (anon access unchanged)';
  end if;
  if not has_function_privilege('anon', 'public.delete_subscription(uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'self-check: unrelated function delete_subscription must be untouched (anon access unchanged)';
  end if;
end $$;

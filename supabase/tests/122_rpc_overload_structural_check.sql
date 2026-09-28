-- Structural sanity check for the Sep 24-25 production incident (RPC overload ambiguity).
--
-- The subscriptions migrations added a trailing `p_accept_extra_subscription_charge boolean
-- default false` parameter to several existing RPCs via `CREATE OR REPLACE FUNCTION` with a new
-- signature, which creates a SECOND overload instead of replacing the old one -- every existing
-- call (having a default, both signatures match) then fails with "Could not choose the best
-- candidate function". 20260925120112_drop_pre_subscription_rpc_overloads.sql drops the five old
-- (pre-subscription) signatures to resolve this.
--
-- This is a pure structural check, not a new feature test: after applying the full migration
-- chain (00-03 stubs, PLUS 04_pre_subscription_rpc_stub.sql -- see that file's header for why it's
-- required for this check to have any teeth at all -- then every real migration through
-- 20260925120112), each of the five previously-ambiguous RPC names must resolve to EXACTLY ONE
-- function signature in pg_proc/information_schema.routines -- i.e. genuinely no ambiguous overload
-- remains, not just "the app happens to pass arguments that resolve one candidate."
--
-- Verified this check actually has teeth: run against the chain WITHOUT 04_pre_subscription_rpc_
-- stub.sql, every RPC trivially shows 1 signature regardless of the fix (the old signature never
-- existed in the stand-in schema to collide in the first place). WITH 04 loaded and the chain run
-- up to but NOT including 20260925120112, every one of the 5 names shows overload_count=2 (the
-- real incident, reproduced) confirmed via a manual query during this test's development; applying
-- 20260925120112 brings every count back to 1, which is what this file asserts.
set client_min_messages to notice;

do $$
declare
  r record;
  v_bad_count int := 0;
begin
  for r in
    select p.proname, count(*) as overload_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'register_for_session',
        'coach_add_athlete',
        'add_manual_participant_to_session',
        'staff_move_session_participant',
        'manager_revert_activity_event'
      )
    group by p.proname
  loop
    if r.overload_count <> 1 then
      v_bad_count := v_bad_count + 1;
      raise notice 'STRUCTURAL CHECK FAILED CANDIDATE: % has % overloads (expected exactly 1)', r.proname, r.overload_count;
    else
      raise notice 'STRUCTURAL CHECK OK: % has exactly 1 signature', r.proname;
    end if;
  end loop;

  -- Also confirm all five names were actually found at all (a name missing entirely would
  -- silently pass the count=1-per-group check above by never appearing in the loop).
  if (
    select count(distinct p.proname)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'register_for_session',
        'coach_add_athlete',
        'add_manual_participant_to_session',
        'staff_move_session_participant',
        'manager_revert_activity_event'
      )
  ) <> 5 then
    raise exception 'STRUCTURAL CHECK FAILED: one or more of the five expected RPC names was not found at all in public schema';
  end if;

  if v_bad_count > 0 then
    raise exception 'STRUCTURAL CHECK FAILED: % of the 5 RPC names have an ambiguous (not exactly 1) overload count', v_bad_count;
  end if;

  raise notice 'STRUCTURAL CHECK PASSED: all 5 previously-ambiguous RPC names resolve to exactly 1 signature each after the full migration chain (including 20260925120112)';
end $$;

-- information_schema cross-check (independent code path from pg_proc, same conclusion expected).
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from (
    select routine_name
    from information_schema.routines
    where routine_schema = 'public'
      and routine_name in (
        'register_for_session',
        'coach_add_athlete',
        'add_manual_participant_to_session',
        'staff_move_session_participant',
        'manager_revert_activity_event'
      )
    group by routine_name
    having count(*) <> 1
  ) ambiguous;

  if v_count > 0 then
    raise exception 'STRUCTURAL CHECK FAILED (information_schema cross-check): % RPC name(s) have more than one routine entry', v_count;
  end if;

  raise notice 'STRUCTURAL CHECK PASSED (information_schema cross-check): no ambiguous routine_name groups';
end $$;

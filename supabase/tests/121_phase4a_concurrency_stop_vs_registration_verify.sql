-- Race 3 verification: run after both 119 (stop) and 120 (registration) have completed.
--
-- Same design note as race 2's verify script: a registration's `covered` flag has no financial
-- effect until attendance is marked (see 117_..._verify.sql for the full explanation, confirmed by
-- inspecting _period_merged_athlete_finance and subscription_reconcile_week's gather predicate).
-- This script marks attendance (the real settlement event) rather than calling
-- subscription_reconcile_week directly on a still-pending row.
set client_min_messages to notice;

do $$
declare
  v_sub uuid; v_sess uuid; v_date date;
  v_cov record;
begin
  select v into v_sub from _p4a_race_ids where k = 'r3_sub';
  select v into v_sess from _p4a_race_ids where k = 'r3_sess';
  select v into v_date from _p4a_race_dates where k = 'r3_stop_date';

  if not exists (select 1 from subscription_versions where subscription_id = v_sub and stopped_effective_date = v_date) then
    raise exception 'RACE3 FAILED: expected stopped_effective_date to be set after the race';
  end if;

  -- Simulate the real settlement event (attendance marking) and assert the settled state is
  -- consistent: a session on/after the stop date can never end up covered=true once realized.
  update session_registrations set attended = true where session_id = v_sess;

  select * into v_cov from subscription_registration_coverage
  where subscription_id = v_sub and session_date = v_date;

  if found then
    if v_cov.covered = true then
      raise exception 'RACE3 FAILED: final reconciled state shows covered=true for a session on/after the stop date';
    end if;
    if v_cov.non_coverage_reason <> 'not_subscribed' then
      raise exception 'RACE3 FAILED: expected final non_coverage_reason = not_subscribed (stopped), got %', v_cov.non_coverage_reason;
    end if;
    raise notice 'RACE3 PASSED: final settled state is consistent (covered=false, reason=not_subscribed) regardless of race interleaving';
  else
    if not exists (select 1 from session_registrations sr join _p4a_race_ids r on r.v = sr.user_id and r.k = 'r3_athlete' where sr.session_id = (select v from _p4a_race_ids where k = 'r3_sess')) then
      raise exception 'RACE3 FAILED: no coverage row AND no registration row -- registration attempt appears to have been lost/crashed';
    end if;
    raise notice 'RACE3 PASSED: registration completed with no coverage row (consistent, no crash) and no post-stop phantom coverage';
  end if;
end $$;

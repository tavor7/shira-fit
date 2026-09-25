-- Race 2 verification: run after both 115 (freeze) and 116 (registration) have completed.
--
-- Design note confirmed by inspection (Phase 2's own tested behavior, not a Phase 4A change): a
-- registration's `covered` flag has ZERO financial effect until attendance is marked --
-- _period_merged_athlete_finance only ever counts rows where attended IS TRUE (or the no-show/
-- charged-cancellation variants); subscription_reconcile_week's own gather predicate deliberately
-- excludes not-yet-attended rows for the same reason (see its Phase 2 comment). So the real
-- "settlement point" that must be consistent is attendance-marking time (which the existing
-- _subscription_reconcile_after_registration_change trigger already reconciles against LIVE
-- freeze/subscription state at that moment) -- not an intermediate, not-yet-realized snapshot. This
-- verify script marks attendance (simulating the actual real-world event) rather than calling
-- subscription_reconcile_week directly on a still-pending row, which would never touch it (by
-- design) and produced a false alarm on the first pass of this test.
do $$
declare
  v_sub uuid; v_sess uuid; v_date date;
  v_cov record;
begin
  select v into v_sub from _p4a_race_ids where k = 'r2_sub';
  select v into v_sess from _p4a_race_ids where k = 'r2_sess';
  select v into v_date from _p4a_race_dates where k = 'r2_freeze_date';

  -- Real freeze row must exist regardless of interleaving (freeze_subscription always applies,
  -- since with no pre-existing coverage for that date the impact preview is always count=0).
  if not exists (select 1 from subscription_freezes where subscription_id = v_sub and freeze_from = v_date and freeze_until = v_date) then
    raise exception 'RACE2 FAILED: expected freeze row to exist after the race';
  end if;

  -- Simulate the real settlement event (attendance marking), which fires
  -- _subscription_reconcile_after_registration_change -> subscription_reconcile_week against the
  -- now-fully-committed freeze state. Assert the FINAL, settled state is consistent: a frozen date
  -- can never end up covered=true once actually realized, regardless of which side of the race
  -- committed first.
  update session_registrations set attended = true where session_id = v_sess;

  select * into v_cov from subscription_registration_coverage
  where subscription_id = v_sub and session_date = v_date;

  if found then
    if v_cov.covered = true then
      raise exception 'RACE2 FAILED: final reconciled state shows covered=true for a frozen date -- phantom allowance / silent paid-as-covered registration on a frozen day';
    end if;
    if v_cov.non_coverage_reason <> 'frozen' then
      raise exception 'RACE2 FAILED: expected final non_coverage_reason = frozen, got %', v_cov.non_coverage_reason;
    end if;
    raise notice 'RACE2 PASSED: final settled state is consistent (covered=false, reason=frozen), regardless of race interleaving';
  else
    -- No coverage row at all means the registration attempt itself either never went through or
    -- was recorded as not_subscribed/no coverage row (also a consistent, safe outcome) -- confirm
    -- the registration at least succeeded as SOME well-formed outcome (no crash) by checking a
    -- real session_registrations row exists.
    if not exists (select 1 from session_registrations sr join _p4a_race_ids r on r.v = sr.user_id and r.k = 'r2_athlete' where sr.session_id = (select v from _p4a_race_ids where k = 'r2_sess')) then
      raise exception 'RACE2 FAILED: no coverage row AND no registration row -- registration attempt appears to have been lost/crashed';
    end if;
    raise notice 'RACE2 PASSED: registration completed with no coverage row (consistent, no crash) and no frozen-date phantom coverage';
  end if;
end $$;

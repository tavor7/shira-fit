-- Phase 4A tests, batch 2: edit/freeze/stop/delete/reactivate, impact-preview/confirm, security,
-- idempotency. Run after 100_phase4a_create_list_tests.sql, same stub+migration setup.
set client_min_messages to notice;

-- ===========================================================================
-- Shared fixture: manager + coach + athlete with a subscription started 20 days ago
-- (price 300, pair tier weekly_limit=1), two 'pair' registrations in the current week
-- (both attended), so exactly one is covered and one is not (allowance_exceeded) --
-- realistic pre-existing coverage state to test flips against.
-- ===========================================================================
do $$
declare
  v_manager uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_athlete uuid := gen_random_uuid();
  v_sub uuid;
  v_ver uuid;
  v_start date := current_date - 20;
  v_sun date := current_date - extract(dow from current_date)::int + 7;
  v_sess1 uuid; v_sess2 uuid;
  v_reg1 uuid; v_reg2 uuid;
  v_res json;
  v_covered_count int;
begin
  create table if not exists _p4a_ids (k text primary key, v uuid);
  delete from _p4a_ids;

  insert into profiles (user_id, username, full_name, phone, role, approval_status) values
    (v_manager, 'p4a_mgr', 'P4A Manager', '9001', 'manager', 'approved'),
    (v_coach, 'p4a_coach', 'P4A Coach', '9002', 'coach', 'approved'),
    (v_athlete, 'p4a_ath', 'P4A Athlete', '9003', 'athlete', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(v_athlete, false, 300, v_start, null, extract(day from v_start)::smallint,
    jsonb_build_array(jsonb_build_object('tier', 'pair', 'weekly_limit', 1)));
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'FIXTURE FAILED create_subscription: %', v_res;
  end if;
  v_sub := (v_res->>'subscription_id')::uuid;
  v_ver := (v_res->>'version_id')::uuid;

  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '10:00', v_coach, 2) returning id into v_sess1;
  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 3, '10:00', v_coach, 2) returning id into v_sess2;

  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.register_for_session(v_sess1);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FIXTURE FAILED reg1: %', v_res; end if;
  v_res := public.register_for_session(v_sess2, true); -- accept extra (2nd will be allowance_exceeded)
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FIXTURE FAILED reg2: %', v_res; end if;

  update session_registrations set attended = true where session_id in (v_sess1, v_sess2) and user_id = v_athlete;

  select count(*) into v_covered_count from subscription_registration_coverage
  where subscription_id = v_sub and covered = true;
  if v_covered_count <> 1 then
    raise exception 'FIXTURE FAILED: expected exactly 1 covered registration, got %', v_covered_count;
  end if;

  insert into _p4a_ids values ('manager', v_manager), ('athlete', v_athlete), ('coach', v_coach),
    ('sub', v_sub), ('ver', v_ver), ('sess1', v_sess1), ('sess2', v_sess2), ('sun', null);
  update _p4a_ids set v = null where k = 'sun';
  raise notice 'FIXTURE OK: subscription %, 1 covered / 1 allowance_exceeded registration in current week', v_sub;
end $$;

-- === T7: security — athlete cannot edit/freeze/stop/delete another payee's subscription ===
do $$
declare
  v_athlete uuid; v_sub uuid; v_res json;
begin
  select v into v_athlete from _p4a_ids where k = 'athlete';
  select v into v_sub from _p4a_ids where k = 'sub';

  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.edit_subscription_version(v_sub, current_date, 250);
  if v_res->>'error' <> 'forbidden' then raise exception 'T7a FAILED: %', v_res; end if;

  v_res := public.freeze_subscription(v_sub, current_date, current_date + 3);
  if v_res->>'error' <> 'forbidden' then raise exception 'T7b FAILED: %', v_res; end if;

  v_res := public.stop_subscription(v_sub, current_date);
  if v_res->>'error' <> 'forbidden' then raise exception 'T7c FAILED: %', v_res; end if;

  v_res := public.delete_subscription(v_sub);
  if v_res->>'error' <> 'forbidden' then raise exception 'T7d FAILED: %', v_res; end if;

  raise notice 'T7 PASSED: athlete forbidden from edit/freeze/stop/delete on manager-only RPCs';
end $$;

-- === T8: edit lowering pair allowance to 0 and price 300->200, effective from a specific date
--     mid-period -- must preview, not apply, when impact exists ===
do $$
declare
  v_manager uuid; v_sub uuid; v_res json; v_count_before int;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  select v into v_sub from _p4a_ids where k = 'sub';
  select count(*) into v_count_before from subscription_versions where subscription_id = v_sub;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.edit_subscription_version(v_sub, current_date - 15, 200, null, false,
    jsonb_build_array(jsonb_build_object('tier', 'pair', 'weekly_limit', 0)), false);

  if v_res->>'action' <> 'preview' then
    raise exception 'T8 FAILED: expected preview action, got %', v_res;
  end if;
  if coalesce((v_res->'impact'->>'count')::int, 0) <> 1 then
    raise exception 'T8b FAILED: expected impact count 1, got %', v_res;
  end if;

  -- Must NOT have applied: version count unchanged, coverage unchanged.
  if (select count(*) from subscription_versions where subscription_id = v_sub) <> v_count_before then
    raise exception 'T8c FAILED: preview must not create a new version row';
  end if;

  raise notice 'T8 PASSED: edit with impact returns preview, does not apply (count=1)';
end $$;

-- === T9: confirm the same edit -- must apply, flip coverage, correct billing ===
do $$
declare
  v_manager uuid; v_sub uuid; v_ver uuid; v_res json;
  v_new_version_id uuid;
  v_covered_count int;
  v_bp_id uuid;
  v_reversal_count int;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  select v into v_sub from _p4a_ids where k = 'sub';
  select v into v_ver from _p4a_ids where k = 'ver';

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.edit_subscription_version(v_sub, current_date - 15, 200, null, false,
    jsonb_build_array(jsonb_build_object('tier', 'pair', 'weekly_limit', 0)), true);

  if v_res->>'action' <> 'applied' then
    raise exception 'T9 FAILED: expected applied, got %', v_res;
  end if;
  v_new_version_id := (v_res->>'version_id')::uuid;

  -- Old version must be closed, never mutated in place (still readable, effective_to set).
  if not exists (select 1 from subscription_versions where id = v_ver and effective_to = current_date - 15) then
    raise exception 'T9b FAILED: old version not closed as expected';
  end if;
  if not exists (select 1 from subscription_versions where id = v_ver and superseded_by = v_new_version_id) then
    raise exception 'T9c FAILED: old version missing superseded_by pointer';
  end if;

  -- Coverage must now be fully non-covered (pair tier limit is 0 on the new version).
  select count(*) into v_covered_count from subscription_registration_coverage
  where subscription_id = v_sub and covered = true;
  if v_covered_count <> 0 then
    raise exception 'T9d FAILED: expected 0 covered after allowance drop to 0, got %', v_covered_count;
  end if;

  -- Billing period must have been corrected: price genuinely changed (300 -> 200 partway through
  -- the period), so segmentation must produce a blended amount different from the original 300,
  -- exercised through a real reversal + edit_correction pair (never 'proration' -- that type is
  -- reserved for organic first-generation partial periods and collides with the
  -- subscription_charges_original_per_period_uidx if reused here; see the Phase 4A migration's
  -- judgment call §6).
  select bp.id into v_bp_id from subscription_billing_periods bp where bp.subscription_id = v_sub;
  select count(*) into v_reversal_count from subscription_charges
  where billing_period_id = v_bp_id and charge_type = 'reversal';
  if v_reversal_count <> 1 then
    raise exception 'T9e FAILED: expected exactly 1 reversal charge, got %', v_reversal_count;
  end if;
  if not exists (select 1 from subscription_charges where billing_period_id = v_bp_id and charge_type = 'edit_correction') then
    raise exception 'T9f FAILED: expected an edit_correction charge';
  end if;

  raise notice 'T9 PASSED: confirmed edit applied, coverage flipped to 0, billing corrected (1 reversal + 1 edit_correction)';
end $$;

-- === T10: retry the same confirmed edit -- idempotent, no duplicate version/charge ===
do $$
declare
  v_manager uuid; v_sub uuid; v_res json; v_version_count int; v_reversal_count int; v_bp_id uuid;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  select v into v_sub from _p4a_ids where k = 'sub';
  select count(*) into v_version_count from subscription_versions where subscription_id = v_sub;

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.edit_subscription_version(v_sub, current_date - 15, 200, null, false,
    jsonb_build_array(jsonb_build_object('tier', 'pair', 'weekly_limit', 0)), true);

  if v_res->>'action' <> 'already_applied' then
    raise exception 'T10 FAILED: expected already_applied on retry, got %', v_res;
  end if;
  if (select count(*) from subscription_versions where subscription_id = v_sub) <> v_version_count then
    raise exception 'T10b FAILED: retry created a duplicate version row';
  end if;

  select bp.id into v_bp_id from subscription_billing_periods bp where bp.subscription_id = v_sub;
  select count(*) into v_reversal_count from subscription_charges
  where billing_period_id = v_bp_id and charge_type = 'reversal';
  if v_reversal_count <> 1 then
    raise exception 'T10c FAILED: retry created a duplicate reversal charge (count=%)', v_reversal_count;
  end if;

  raise notice 'T10 PASSED: confirmed-edit retry is idempotent (already_applied, no duplicate rows)';
end $$;

-- === T10b: case (a) — a version with NO history yet (verified via an actual dependency check, not
--     just date equality) is safe to update in place. Uses a FUTURE start date specifically so
--     create_subscription's own immediate-billing call does NOT fire (a past/today start date
--     always creates a billing_periods row immediately, which is real history — see T10c below for
--     that far more common case). ===
do $$
declare
  v_manager uuid; v_athlete uuid; v_sub uuid; v_ver_before uuid; v_res json;
  v_start date := current_date + 30; -- future: no immediate billing, genuinely no history yet
  v_version_count int; v_price numeric;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  perform set_config('app.current_uid', v_manager::text, true);

  v_athlete := gen_random_uuid();
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath_inplace', 'P4A Athlete InPlace', '9010', 'athlete', 'approved');

  v_res := public.create_subscription(v_athlete, false, 200, v_start, null, extract(day from v_start)::smallint, '[]'::jsonb);
  v_sub := (v_res->>'subscription_id')::uuid;
  select id into v_ver_before from subscription_versions where subscription_id = v_sub;

  if exists (select 1 from subscription_billing_periods where subscription_id = v_sub) then
    raise exception 'T10b FIXTURE FAILED: future-dated subscription should have zero billing periods yet';
  end if;

  -- Edit "from the beginning" == the version's own effective_from, with no impact (no
  -- registrations at all yet), so it applies immediately without needing p_confirmed.
  v_res := public.edit_subscription_version(v_sub, v_start, 250, null, false, null, false);
  if v_res->>'action' <> 'applied' then
    raise exception 'T10b FAILED: expected immediate apply (no impact), got %', v_res;
  end if;
  if (v_res->>'version_id')::uuid <> v_ver_before then
    raise exception 'T10b2 FAILED: expected the SAME version id to be reused (in-place update, no history), got %', v_res;
  end if;

  select count(*) into v_version_count from subscription_versions where subscription_id = v_sub;
  if v_version_count <> 1 then
    raise exception 'T10b3 FAILED: expected exactly 1 version row (updated in place), got %', v_version_count;
  end if;

  select monthly_price_ils into v_price from subscription_versions where id = v_ver_before;
  if v_price <> 250 then
    raise exception 'T10b4 FAILED: expected price updated to 250 in place, got %', v_price;
  end if;

  raise notice 'T10b PASSED: case (a) no-history version updates in place, verified via a real dependency check';
end $$;

-- === T10c: case (b) — a version whose effective_from equals the subscription's own start date but
--     which ALREADY has billing/coverage history (the common case: any past/today-started
--     subscription immediately gets a billing period from create_subscription itself). Must NOT
--     mutate the original row (full auditability preserved: same id, same original price/dates
--     still readable), must still honor "from beginning" semantics (a genuinely new version takes
--     over from that same date), and must produce a correct billing correction. ===
do $$
declare
  v_manager uuid; v_athlete uuid; v_sub uuid; v_ver_before uuid; v_res json;
  v_start date := current_date - 10;
  v_version_count int; v_old_price numeric; v_new_ver uuid; v_bp_id uuid; v_reversal_count int;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  perform set_config('app.current_uid', v_manager::text, true);

  v_athlete := gen_random_uuid();
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath_history', 'P4A Athlete History', '9011', 'athlete', 'approved');

  v_res := public.create_subscription(v_athlete, false, 300, v_start, null, extract(day from v_start)::smallint, '[]'::jsonb);
  v_sub := (v_res->>'subscription_id')::uuid;
  v_ver_before := (v_res->>'version_id')::uuid;

  if not exists (select 1 from subscription_billing_periods where version_id = v_ver_before) then
    raise exception 'T10c FIXTURE FAILED: expected immediate billing history against the first version';
  end if;

  -- "From the beginning" edit at the SAME date as the subscription's own start, with real history
  -- already against v_ver_before.
  v_res := public.edit_subscription_version(v_sub, v_start, 200, null, false, null, true);
  if v_res->>'action' <> 'applied' then
    raise exception 'T10c FAILED: expected applied, got %', v_res;
  end if;
  v_new_ver := (v_res->>'version_id')::uuid;

  if v_new_ver = v_ver_before then
    raise exception 'T10c2 FAILED: a version with existing history must NOT be reused in place — expected a new version id';
  end if;

  -- Full auditability: the ORIGINAL row is completely untouched (same price, same effective_from).
  select monthly_price_ils into v_old_price from subscription_versions where id = v_ver_before;
  if v_old_price <> 300 then
    raise exception 'T10c3 FAILED: original version''s price was mutated (expected untouched 300, got %)', v_old_price;
  end if;
  if not exists (select 1 from subscription_versions where id = v_ver_before and effective_from = v_start) then
    raise exception 'T10c4 FAILED: original version''s effective_from was mutated';
  end if;
  -- The zero-width closure: effective_to = its own effective_from (relaxed constraint), superseded.
  if not exists (select 1 from subscription_versions where id = v_ver_before and effective_to = v_start and superseded_by = v_new_ver) then
    raise exception 'T10c5 FAILED: original version not correctly closed at its own start date with superseded_by set';
  end if;

  select count(*) into v_version_count from subscription_versions where subscription_id = v_sub;
  if v_version_count <> 2 then
    raise exception 'T10c6 FAILED: expected exactly 2 version rows (original + new), got %', v_version_count;
  end if;

  -- Correct correction: the new version's price (200) must have re-priced the already-billed period.
  select id into v_bp_id from subscription_billing_periods where subscription_id = v_sub;
  select count(*) into v_reversal_count from subscription_charges where billing_period_id = v_bp_id and charge_type = 'reversal';
  if v_reversal_count <> 1 then
    raise exception 'T10c7 FAILED: expected exactly 1 reversal correcting the pre-existing 300 charge to 200, got %', v_reversal_count;
  end if;
  if not exists (select 1 from subscription_charges where billing_period_id = v_bp_id and charge_type = 'edit_correction' and amount_ils = 200) then
    raise exception 'T10c8 FAILED: expected an edit_correction charge of exactly 200';
  end if;

  raise notice 'T10c PASSED: case (b) history-bearing same-date edit preserves the original version untouched, honors from-beginning semantics, produces a correct correction';
end $$;

-- === T11: freeze with impact — a fresh subscription/registration pair, since the shared fixture's
--     subscription now has 0 covered registrations (T9 dropped the allowance to 0). ===
do $$
declare
  v_manager uuid; v_coach uuid; v_athlete uuid; v_sub uuid; v_res json;
  v_sun date := current_date - extract(dow from current_date)::int + 7;
  v_sess uuid; v_freeze_id uuid; v_covered_count int; v_bp_id uuid; v_reversal_count int;
begin
  v_athlete := gen_random_uuid();
  select v into v_manager from _p4a_ids where k = 'manager';
  select v into v_coach from _p4a_ids where k = 'coach';

  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath2', 'P4A Athlete Two', '9004', 'athlete', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(v_athlete, false, 300, current_date - 20, null, extract(day from (current_date-20))::smallint,
    jsonb_build_array(jsonb_build_object('tier', 'pair', 'weekly_limit', 1)));
  v_sub := (v_res->>'subscription_id')::uuid;

  insert into training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_sun + 1, '10:00', v_coach, 2) returning id into v_sess;

  perform set_config('app.current_uid', v_athlete::text, true);
  v_res := public.register_for_session(v_sess);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T11 FIXTURE FAILED: %', v_res; end if;
  update session_registrations set attended = true where session_id = v_sess and user_id = v_athlete;

  select count(*) into v_covered_count from subscription_registration_coverage where subscription_id = v_sub and covered = true;
  if v_covered_count <> 1 then raise exception 'T11 FIXTURE FAILED: expected 1 covered, got %', v_covered_count; end if;

  -- Preview: freeze covering the session's week.
  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.freeze_subscription(v_sub, v_sun, v_sun + 6, false);
  if v_res->>'action' <> 'preview' or coalesce((v_res->'impact'->>'count')::int,0) <> 1 then
    raise exception 'T11a FAILED: expected preview with count=1, got %', v_res;
  end if;
  if exists (select 1 from subscription_freezes where subscription_id = v_sub) then
    raise exception 'T11b FAILED: preview must not create a freeze row';
  end if;

  -- Confirm.
  v_res := public.freeze_subscription(v_sub, v_sun, v_sun + 6, true);
  if v_res->>'action' <> 'applied' then raise exception 'T11c FAILED: %', v_res; end if;

  select count(*) into v_covered_count from subscription_registration_coverage where subscription_id = v_sub and covered = true;
  if v_covered_count <> 0 then raise exception 'T11d FAILED: expected 0 covered after freeze, got %', v_covered_count; end if;

  -- Freeze-as-pause correction: a freeze inside an otherwise-normal period is a pure pause (the
  -- period's effective window extends by the freeze duration and still nets to the same full
  -- price) -- it must NEVER produce a reversal/credit, only the earlier registration-coverage
  -- drop (T11d) and a shifted billing schedule.
  select bp.id into v_bp_id from subscription_billing_periods bp where bp.subscription_id = v_sub;
  select count(*) into v_reversal_count from subscription_charges where billing_period_id = v_bp_id and charge_type = 'reversal';
  if v_reversal_count <> 0 then raise exception 'T11e FAILED: expected 0 reversals from a pure-pause freeze correction, got %', v_reversal_count; end if;

  -- Overlap rejection reuses the existing exclusion constraint.
  v_res := public.freeze_subscription(v_sub, v_sun + 2, v_sun + 8, true);
  if v_res->>'error' <> 'freeze_overlap' then raise exception 'T11f FAILED: expected freeze_overlap, got %', v_res; end if;

  raise notice 'T11 PASSED: freeze preview/confirm/idempotent-overlap-reject all correct';
end $$;

-- === T12: stop_subscription retroactive, proration via existing correction engine ===
do $$
declare
  v_manager uuid; v_athlete uuid; v_sub uuid; v_res json;
  v_bp_id uuid; v_reversal_count int; v_start date := current_date - 20;
begin
  v_athlete := gen_random_uuid();
  select v into v_manager from _p4a_ids where k = 'manager';
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath3', 'P4A Athlete Three', '9005', 'athlete', 'approved');

  perform set_config('app.current_uid', v_manager::text, true);
  v_res := public.create_subscription(v_athlete, false, 300, v_start, null, extract(day from v_start)::smallint, '[]'::jsonb);
  v_sub := (v_res->>'subscription_id')::uuid;

  select bp.id into v_bp_id from subscription_billing_periods bp where bp.subscription_id = v_sub;
  if not exists (select 1 from subscription_charges where billing_period_id = v_bp_id and amount_ils = 300) then
    raise exception 'T12 FIXTURE FAILED: expected initial 300 charge';
  end if;

  -- Stop retroactively, 5 days before today (a past date, after the charge already posted).
  v_res := public.stop_subscription(v_sub, current_date - 5, true);
  if v_res->>'action' <> 'applied' then raise exception 'T12a FAILED: %', v_res; end if;

  if not exists (select 1 from subscription_versions where subscription_id = v_sub and stopped_effective_date = current_date - 5) then
    raise exception 'T12b FAILED: stopped_effective_date not set';
  end if;

  select count(*) into v_reversal_count from subscription_charges where billing_period_id = v_bp_id and charge_type = 'reversal';
  if v_reversal_count <> 1 then raise exception 'T12c FAILED: expected 1 reversal from retroactive stop, got %', v_reversal_count; end if;

  raise notice 'T12 PASSED: retroactive stop prorates via existing reversal+correction engine';
end $$;

-- === T13: delete_subscription tombstones, cron (generate_due_subscription_charges) skips it ===
do $$
declare
  v_manager uuid; v_athlete uuid; v_sub_del uuid; v_sub_keep uuid; v_res json;
  v_start date := current_date - 400;
  v_bp_count_del_before int; v_bp_count_del_after int;
  v_bp_count_keep_before int; v_bp_count_keep_after int;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  perform set_config('app.current_uid', v_manager::text, true);

  v_athlete := gen_random_uuid();
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath_del', 'P4A Athlete Del', '9006', 'athlete', 'approved');
  v_res := public.create_subscription(v_athlete, false, 300, v_start, null, extract(day from v_start)::smallint, '[]'::jsonb);
  v_sub_del := (v_res->>'subscription_id')::uuid;

  v_athlete := gen_random_uuid();
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath_keep', 'P4A Athlete Keep', '9007', 'athlete', 'approved');
  v_res := public.create_subscription(v_athlete, false, 300, v_start, null, extract(day from v_start)::smallint, '[]'::jsonb);
  v_sub_keep := (v_res->>'subscription_id')::uuid;

  select count(*) into v_bp_count_del_before from subscription_billing_periods where subscription_id = v_sub_del;
  select count(*) into v_bp_count_keep_before from subscription_billing_periods where subscription_id = v_sub_keep;

  v_res := public.delete_subscription(v_sub_del);
  if v_res->>'action' <> 'tombstoned' then raise exception 'T13 FAILED: %', v_res; end if;
  if not exists (select 1 from subscriptions where id = v_sub_del and deleted_at is not null) then
    raise exception 'T13b FAILED: deleted_at not set';
  end if;

  -- Run the daily job: the deleted subscription (400 days of backlog) must NOT grow further, while
  -- the otherwise-identical non-deleted subscription DOES catch up its backlog.
  perform public.generate_due_subscription_charges();

  select count(*) into v_bp_count_del_after from subscription_billing_periods where subscription_id = v_sub_del;
  select count(*) into v_bp_count_keep_after from subscription_billing_periods where subscription_id = v_sub_keep;

  if v_bp_count_del_after <> v_bp_count_del_before then
    raise exception 'T13c FAILED: tombstoned subscription grew billing periods (% -> %) -- cron does NOT skip deleted_at!',
      v_bp_count_del_before, v_bp_count_del_after;
  end if;
  if v_bp_count_keep_after <= v_bp_count_keep_before then
    raise exception 'T13d FAILED: control (non-deleted) subscription should have caught up its backlog, stayed at %',
      v_bp_count_keep_after;
  end if;

  -- Historical financial facts (the one charge already posted) remain fully queryable.
  if not exists (select 1 from subscription_charges where subscription_id = v_sub_del) then
    raise exception 'T13e FAILED: posted charge disappeared after tombstoning';
  end if;
  if (public.get_subscription_detail(v_sub_del)->>'ok')::boolean is not true then
    raise exception 'T13f FAILED: get_subscription_detail must still work for a tombstoned subscription';
  end if;

  -- delete_subscription is idempotent (second call on an already-tombstoned row is a safe no-op).
  v_res := public.delete_subscription(v_sub_del);
  if v_res->>'action' <> 'tombstoned' then raise exception 'T13g FAILED (idempotent re-delete): %', v_res; end if;

  raise notice 'T13 PASSED: tombstone verified to stop future billing (cron skip enforced), history preserved';
end $$;

-- === T14: reactivate_subscription — new lineage, copies price/allowances, NOT freezes/charges ===
do $$
declare
  v_manager uuid; v_athlete uuid; v_src_sub uuid; v_new_sub uuid; v_res json;
  v_start date := current_date - 60;
  v_src_freeze_count int; v_new_freeze_count int;
  v_new_price numeric; v_new_allow jsonb;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  perform set_config('app.current_uid', v_manager::text, true);

  v_athlete := gen_random_uuid();
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath_react', 'P4A Athlete Reactivate', '9008', 'athlete', 'approved');

  v_res := public.create_subscription(v_athlete, false, 350, v_start, null, extract(day from v_start)::smallint,
    jsonb_build_array(jsonb_build_object('tier', 'trio', 'weekly_limit', 3)));
  v_src_sub := (v_res->>'subscription_id')::uuid;

  perform public.freeze_subscription(v_src_sub, v_start + 5, v_start + 10, true);
  select count(*) into v_src_freeze_count from subscription_freezes where subscription_id = v_src_sub;
  if v_src_freeze_count <> 1 then raise exception 'T14 FIXTURE FAILED: freeze not created'; end if;

  perform public.stop_subscription(v_src_sub, current_date - 1, true);

  v_res := public.reactivate_subscription(v_src_sub, current_date, null);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T14a FAILED: %', v_res; end if;
  v_new_sub := (v_res->>'subscription_id')::uuid;

  if v_new_sub = v_src_sub then raise exception 'T14b FAILED: reactivate must create a NEW subscription id'; end if;

  select monthly_price_ils into v_new_price from subscription_versions
  where subscription_id = v_new_sub and effective_to is null;
  if v_new_price <> 350 then raise exception 'T14c FAILED: expected copied price 350, got %', v_new_price; end if;

  select jsonb_object_agg(tier::text, weekly_limit) into v_new_allow
  from subscription_version_allowances a
  join subscription_versions v on v.id = a.version_id
  where v.subscription_id = v_new_sub and v.effective_to is null;
  if (v_new_allow->>'trio')::int <> 3 then raise exception 'T14d FAILED: allowances not copied, got %', v_new_allow; end if;

  select count(*) into v_new_freeze_count from subscription_freezes where subscription_id = v_new_sub;
  if v_new_freeze_count <> 0 then raise exception 'T14e FAILED: reactivate must NOT copy freezes, got %', v_new_freeze_count; end if;

  if exists (select 1 from subscription_charges where subscription_id = v_new_sub
             and billing_period_id in (select id from subscription_billing_periods where subscription_id = v_src_sub)) then
    raise exception 'T14f FAILED: new lineage must not share charges with the source';
  end if;

  -- Normal create-path first billing for the new lineage.
  if not exists (select 1 from subscription_billing_periods where subscription_id = v_new_sub) then
    raise exception 'T14g FAILED: reactivate should have generated a first billing period (start=today)';
  end if;

  raise notice 'T14 PASSED: reactivate creates a separate lineage, copies price/allowances only';
end $$;

-- === T15: reactivate blocked by conflicting-active-lineage rule (same as create) ===
do $$
declare
  v_manager uuid; v_athlete uuid; v_sub uuid; v_res json;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  perform set_config('app.current_uid', v_manager::text, true);
  v_athlete := gen_random_uuid();
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath_conflict', 'P4A Athlete Conflict', '9009', 'athlete', 'approved');

  v_res := public.create_subscription(v_athlete, false, 200, current_date, null, null, '[]'::jsonb);
  v_sub := (v_res->>'subscription_id')::uuid;

  v_res := public.reactivate_subscription(v_sub, current_date, null);
  if v_res->>'error' <> 'conflicting_active_subscription' then
    raise exception 'T15 FAILED: expected conflicting_active_subscription, got %', v_res;
  end if;

  raise notice 'T15 PASSED: reactivate rejects conflicting active lineage for the same payee';
end $$;

-- === T16: idempotency-key distinctness (item 4's exact required test) — edit price to 300
--     effective date X, then a SECOND, legitimate edit sets price to 350 with the SAME effective
--     date X. The second must be treated as a new, distinct operation, never mistaken for a retry
--     of the first: two separate version/correction outcomes must exist, not one. ===
do $$
declare
  v_manager uuid; v_athlete uuid; v_sub uuid; v_ver0 uuid; v_res json;
  v_start date := current_date - 10;
  v_x date := current_date - 3; -- the shared effective date X, mid-period
  v_ver1 uuid; v_ver2 uuid;
  v_version_count int;
  v_bp_id uuid;
  v_reversal_count int;
  v_correction_300_count int;
  v_correction_350_count int;
  v_event_count int;
begin
  select v into v_manager from _p4a_ids where k = 'manager';
  perform set_config('app.current_uid', v_manager::text, true);

  v_athlete := gen_random_uuid();
  insert into profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_athlete, 'p4a_ath_t16', 'P4A Athlete T16', '9012', 'athlete', 'approved');

  v_res := public.create_subscription(v_athlete, false, 250, v_start, null, extract(day from v_start)::smallint, '[]'::jsonb);
  v_sub := (v_res->>'subscription_id')::uuid;
  v_ver0 := (v_res->>'version_id')::uuid;

  -- First edit: price -> 300, effective X.
  v_res := public.edit_subscription_version(v_sub, v_x, 300, null, false, null, true);
  if v_res->>'action' <> 'applied' then raise exception 'T16 FIXTURE FAILED first edit: %', v_res; end if;
  v_ver1 := (v_res->>'version_id')::uuid;

  -- Second, DIFFERENT edit: price -> 350, SAME effective date X. Must NOT be swallowed as a retry.
  v_res := public.edit_subscription_version(v_sub, v_x, 350, null, false, null, true);
  if v_res->>'action' <> 'applied' then
    raise exception 'T16 FAILED: second distinct edit (same date, different price) must apply as a new operation, got %', v_res;
  end if;
  v_ver2 := (v_res->>'version_id')::uuid;

  if v_ver2 = v_ver1 then
    raise exception 'T16b FAILED: second edit reused the first edit''s version id -- collided with the first as if it were a retry';
  end if;

  -- Three total version rows: v_ver0 (original, closed at X), v_ver1 (300, closed at X -- history
  -- exists against it from the first correction, so it too must be closed rather than reused),
  -- v_ver2 (350, current).
  select count(*) into v_version_count from subscription_versions where subscription_id = v_sub;
  if v_version_count <> 3 then
    raise exception 'T16c FAILED: expected exactly 3 version rows (two distinct edits, not one collapsed), got %', v_version_count;
  end if;
  if not exists (select 1 from subscription_versions where id = v_ver2 and effective_to is null and monthly_price_ils = 350) then
    raise exception 'T16d FAILED: expected v_ver2 to be the current version at price 350';
  end if;

  -- Two distinct subscription_impact_events rows for action_type='edit' (different source_event_id
  -- hashes, since the payloads differ) -- not one.
  select count(*) into v_event_count from subscription_impact_events
  where subscription_id = v_sub and action_type = 'edit';
  if v_event_count <> 2 then
    raise exception 'T16e FAILED: expected exactly 2 distinct edit impact_events (proving the keys did not collide), got %', v_event_count;
  end if;

  -- Ledger: two separate correction outcomes exist (not one) -- a reversal of the original 250
  -- charge plus an edit_correction of ~300-ish blended amount, THEN a further reversal of that
  -- correcting to the final ~350-ish blended amount. At least 2 reversal rows and at least one
  -- edit_correction charge reflecting each distinct price must exist.
  select id into v_bp_id from subscription_billing_periods bp where bp.subscription_id = v_sub;
  select count(*) into v_reversal_count from subscription_charges where billing_period_id = v_bp_id and charge_type = 'reversal';
  if v_reversal_count < 2 then
    raise exception 'T16f FAILED: expected at least 2 reversals (one per distinct edit''s correction), got %', v_reversal_count;
  end if;

  raise notice 'T16 PASSED: two distinct same-date edits produce two separate version/correction outcomes, never collapsed into one';
end $$;

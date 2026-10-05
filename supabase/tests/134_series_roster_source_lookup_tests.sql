-- Regression test for 20261005170000_series_roster_source_legacy_fallback.sql.
--
-- Reproduces the production failure: a copy_on_generate series that predates the occurrence ledger
-- (legacy sessions, no ledger rows) got its first ledger-era occurrence created with an EMPTY roster,
-- because the generator only looked at ledger rows. Runs the real generators (manager-authenticated
-- maintain_session_series_horizon and the no-auth core used by pg_cron) and checks source selection
-- case by case. Self-contained; everything is rolled back. Plain psql: any failure raises.
--
-- Cron note: pg_cron runs with auth.uid() null, where coach_add_athlete rejects every add
-- (not_authenticated). That is a separate issue; this test asserts the cron path only through MANUAL
-- participants (which do not depend on auth.uid()), proving the lookup reaches the copy step, and does
-- not assert anything about athletes on the cron path.
set client_min_messages to notice;
begin;

create temp table t134_fx(k text primary key, v uuid);
grant all on t134_fx to public;

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_mp uuid;
  v_res json;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values (v_mgr,   't134-mgr@test.local',   '0501340001'),
               (v_coach, 't134-coach@test.local', '0501340002'),
               (v_a,     't134-a@test.local',     '0501340003'),
               (v_b,     't134-b@test.local',     '0501340004')) u(id, e, p);
  update public.profiles set role = 'manager', approval_status = 'approved' where user_id = v_mgr;
  update public.profiles set role = 'coach',   approval_status = 'approved' where user_id = v_coach;
  update public.profiles set approval_status = 'approved' where user_id in (v_a, v_b);
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  v_res := public.upsert_manual_participant('T134 Manual', '0501349999');
  v_mp := (v_res->>'manual_participant_id')::uuid;
  perform set_config('request.jwt.claims', '', true);
  insert into t134_fx values ('mgr', v_mgr), ('coach', v_coach), ('a', v_a), ('b', v_b), ('mp', v_mp);
end $$;

-- Builds a LEGACY series (no ledger rows): weekly sessions at anchor+0/+7/+14/+21 where anchor is
-- today-14, i.e. dates today-14 .. today+7. The older sessions carry athlete B, the latest carries
-- athlete A plus the manual participant. Returns the series id.
create or replace function pg_temp.t134_legacy_series(p_cap int, p_policy text, p_start time) returns uuid language plpgsql as $f$
declare
  v_series uuid := gen_random_uuid();
  v_today date := public._studio_today_date();
  v_coach uuid := (select v from t134_fx where k = 'coach');
  v_i int; v_sid uuid;
begin
  insert into public.session_series (id, coach_id, anchor_date, start_time, duration_minutes, max_participants,
                                     is_open_for_registration, repeat_mode, roster_policy, status)
  values (v_series, v_coach, v_today - 14, p_start, 60, p_cap, true, 'ongoing', p_policy::public.session_series_roster_policy, 'active');
  for v_i in 0..3 loop
    v_sid := gen_random_uuid();
    insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration,
                                          duration_minutes, series_id, series_detached)
    values (v_sid, v_today - 14 + v_i * 7, p_start, v_coach, p_cap, true, 60, v_series, false);
    if v_i < 3 then
      insert into public.session_registrations (session_id, user_id, status) values (v_sid, (select v from t134_fx where k = 'b'), 'active');
    else
      insert into public.session_registrations (session_id, user_id, status) values (v_sid, (select v from t134_fx where k = 'a'), 'active');
      insert into public.session_manual_participants (session_id, manual_participant_id) values (v_sid, (select v from t134_fx where k = 'mp'));
    end if;
  end loop;
  return v_series;
end $f$;
grant execute on function pg_temp.t134_legacy_series(int, text, time) to public;

-- Roster summary of the session generated for (series, date).
create or replace function pg_temp.t134_roster(p_series uuid, p_date date, out has_a boolean, out has_b boolean, out has_mp boolean, out sess uuid)
language plpgsql as $f$
begin
  select id into sess from public.training_sessions where series_id = p_series and session_date = p_date;
  has_a := exists (select 1 from public.session_registrations where session_id = sess and status = 'active' and user_id = (select v from t134_fx where k = 'a'));
  has_b := exists (select 1 from public.session_registrations where session_id = sess and status = 'active' and user_id = (select v from t134_fx where k = 'b'));
  has_mp := exists (select 1 from public.session_manual_participants where session_id = sess and manual_participant_id = (select v from t134_fx where k = 'mp'));
end $f$;
grant execute on function pg_temp.t134_roster(uuid, date) to public;

-- ===== T1/T2: manager-authenticated generation of a legacy series =====
do $$
declare
  v_today date := public._studio_today_date();
  v_series uuid := pg_temp.t134_legacy_series(4, 'copy_on_generate', '05:00');
  v_none uuid := pg_temp.t134_legacy_series(4, 'none', '05:30');
  r record;
  v_res json;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', (select v from t134_fx where k = 'mgr'), 'role', 'authenticated')::text, true);
  v_res := public.maintain_session_series_horizon();
  perform set_config('request.jwt.claims', '', true);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T1 FAILED: horizon maintenance: %', v_res; end if;

  select * into r from pg_temp.t134_roster(v_series, v_today + 14);
  if r.sess is null then raise exception 'T1 FAILED: the first ledger-era occurrence was not generated'; end if;
  if not r.has_a or not r.has_mp then
    raise exception 'T1 FAILED: first ledger-era occurrence of a legacy series did not copy the latest legacy roster (athlete A: %, manual: %)', r.has_a, r.has_mp;
  end if;
  if r.has_b then raise exception 'T1 FAILED: copied from an OLDER legacy session (athlete B present)'; end if;
  raise notice 'T1 PASSED: manager path copies the latest earlier legacy session into the first ledger-era occurrence';

  select * into r from pg_temp.t134_roster(v_series, v_today + 21);
  if not r.has_a or not r.has_mp or r.has_b then
    raise exception 'T2 FAILED: the following occurrence did not copy from the ledger-era occurrence (a=%, mp=%, b=%)', r.has_a, r.has_mp, r.has_b;
  end if;
  raise notice 'T2 PASSED: the next occurrence copies from the ledger-era occurrence (chain continues)';

  -- T5: roster_policy none copies nothing, whatever the legacy roster is.
  select * into r from pg_temp.t134_roster(v_none, v_today + 14);
  if r.sess is null then raise exception 'T5 FAILED: none-policy series did not generate'; end if;
  if r.has_a or r.has_b or r.has_mp then raise exception 'T5 FAILED: roster copied although roster_policy = none'; end if;
  raise notice 'T5 PASSED: roster_policy none -> no copy';

  -- T7: ledger identity: exactly one ledger row per generated session, no duplicates anywhere.
  if (select count(*) from public.session_series_occurrences where series_id = v_series)
     <> (select count(*) from public.training_sessions where series_id = v_series and series_occurrence_id is not null) then
    raise exception 'T7 FAILED: ledger rows and ledger-linked sessions differ';
  end if;
  if exists (select 1 from public.training_sessions where series_id in (v_series, v_none) group by series_id, session_date having count(*) > 1)
     or exists (select 1 from public.session_registrations r2 join public.training_sessions t on t.id = r2.session_id
                where t.series_id in (v_series, v_none) and r2.status = 'active' group by r2.session_id, r2.user_id having count(*) > 1) then
    raise exception 'T7 FAILED: duplicate sessions or registrations';
  end if;
  if exists (select 1 from public.training_sessions where series_id = v_series and series_occurrence_id is null and session_date > v_today + 7) then
    raise exception 'T7 FAILED: generated session without a ledger link';
  end if;
  raise notice 'T7 PASSED: ledger identity intact, no duplicate sessions or registrations';
end $$;

-- ===== T3/T4: cron (no auth) generation, capacities 1, 7, 12 =====
do $$
declare
  v_today date := public._studio_today_date();
  v_cap int;
  v_series uuid;
  v_series_ids uuid[] := '{}';
  v_t time;
  r record;
  v_res json;
  i int := 0;
begin
  foreach v_cap in array array[1, 7, 12] loop
    i := i + 1;
    v_t := ('06:0' || i)::time;
    v_series_ids := v_series_ids || pg_temp.t134_legacy_series(v_cap, 'copy_on_generate', v_t);
  end loop;

  perform set_config('request.jwt.claims', '', true);
  if auth.uid() is not null then raise exception 'T3 setup: expected no authenticated user'; end if;
  v_res := public._maintain_session_series_horizon_core();
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T3 FAILED: cron core: %', v_res; end if;

  i := 0;
  foreach v_series in array v_series_ids loop
    i := i + 1;
    select * into r from pg_temp.t134_roster(v_series, v_today + 14);
    if r.sess is null then raise exception 'T3 FAILED: cron did not generate the occurrence (series %)', i; end if;
    if not r.has_mp then
      raise exception 'T3 FAILED: cron path did not reach the roster copy for series % (capacity %): manual participant missing', i, (array[1,7,12])[i];
    end if;
    if r.has_b then raise exception 'T3 FAILED: cron path copied from an older legacy session (series %)', i; end if;
    raise notice 'T3/T4 PASSED: cron path, capacity %: first ledger-era occurrence copied the latest legacy roster (manual participant); athlete copied = %',
      (array[1,7,12])[i], r.has_a;
  end loop;
end $$;

-- ===== T6: source selection, case by case (helper called directly) =====
do $$
declare
  v_coach uuid := (select v from t134_fx where k = 'coach');
  v_other_coach uuid := gen_random_uuid();
  v_today date := public._studio_today_date();
  v_target date := v_today + 100;
  v_series uuid := gen_random_uuid();
  v_other_series uuid := gen_random_uuid();
  v_t time := '09:00';
  v_exp uuid;
  v_got uuid;
  v_s_legacy uuid; v_s_legacy_det uuid; v_s_edited uuid; v_s_gen_det uuid; v_s_gen uuid; v_s_future uuid; v_s_other uuid; v_s_moved uuid;
  v_o uuid;

begin
  insert into public.session_series (id, coach_id, anchor_date, start_time, duration_minutes, max_participants, repeat_mode, roster_policy, status)
  values (v_series, v_coach, v_target - 70, v_t, 60, 4, 'ongoing', 'copy_on_generate', 'active');
  insert into public.session_series (id, coach_id, anchor_date, start_time, duration_minutes, max_participants, repeat_mode, roster_policy, status)
  values (v_other_series, v_coach, v_target - 70, '10:00', 60, 4, 'ongoing', 'copy_on_generate', 'active');

  -- No candidates at all -> null.
  if public._series_roster_source_session(v_series, v_target) is not null then raise exception 'T6 FAILED: expected null with no history'; end if;

  -- (a) legacy session (no ledger) -> selected.
  v_s_legacy := gen_random_uuid();
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached)
  values (v_s_legacy, v_target - 60, v_t, v_coach, 4, true, 60, v_series, false);
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_legacy then raise exception 'T6a FAILED: legacy fallback'; end if;
  raise notice 'T6a PASSED: legacy session is the fallback source';

  -- (b) detached legacy session, later than the valid one -> ignored.
  v_s_legacy_det := gen_random_uuid();
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached)
  values (v_s_legacy_det, v_target - 50, v_t, v_coach, 4, true, 60, v_series, true);
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_legacy then raise exception 'T6b FAILED: detached legacy session selected'; end if;
  raise notice 'T6b PASSED: detached session is never selected';

  -- (c) ledger 'edited' occurrence -> eligible, and wins over the older legacy session.
  v_s_edited := gen_random_uuid(); v_o := gen_random_uuid();
  insert into public.session_series_occurrences (id, series_id, template_occurrence_date, template_coach_id, template_start_time, state)
  values (v_o, v_series, v_target - 40, v_coach, v_t, 'claimed');
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached, series_occurrence_id)
  values (v_s_edited, v_target - 40, v_t, v_coach, 4, true, 60, v_series, false, v_o);
  update public.session_series_occurrences set state = 'edited', training_session_id = v_s_edited where id = v_o;
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_edited then raise exception 'T6c FAILED: edited occurrence not selected'; end if;
  raise notice 'T6c PASSED: an edited occurrence is a valid source';

  -- (d) deleted tombstone (no session), later -> ignored.
  insert into public.session_series_occurrences (series_id, template_occurrence_date, template_coach_id, template_start_time, state)
  values (v_series, v_target - 30, v_coach, v_t, 'deleted');
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_edited then raise exception 'T6d FAILED: tombstone affected selection'; end if;
  raise notice 'T6d PASSED: deleted/tombstoned occurrence is not a source';

  -- (e) ledger 'generated' occurrence whose session is detached, later -> ignored.
  v_s_gen_det := gen_random_uuid(); v_o := gen_random_uuid();
  insert into public.session_series_occurrences (id, series_id, template_occurrence_date, template_coach_id, template_start_time, state)
  values (v_o, v_series, v_target - 20, v_coach, v_t, 'claimed');
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached, series_occurrence_id)
  values (v_s_gen_det, v_target - 20, v_t, v_coach, 4, true, 60, v_series, true, v_o);
  update public.session_series_occurrences set state = 'generated', training_session_id = v_s_gen_det where id = v_o;
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_edited then raise exception 'T6e FAILED: detached ledger session selected'; end if;
  raise notice 'T6e PASSED: a ledger occurrence whose session is detached is not a source';

  -- (f) another series' sessions on later dates / same coach -> never selected.
  v_s_other := gen_random_uuid(); v_o := gen_random_uuid();
  insert into public.session_series_occurrences (id, series_id, template_occurrence_date, template_coach_id, template_start_time, state)
  values (v_o, v_other_series, v_target - 10, v_coach, '10:00', 'claimed');
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached, series_occurrence_id)
  values (v_s_other, v_target - 10, '10:00', v_coach, 4, true, 60, v_other_series, false, v_o);
  update public.session_series_occurrences set state = 'generated', training_session_id = v_s_other where id = v_o;
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached)
  values (gen_random_uuid(), v_target - 9, '10:00', v_coach, 4, true, 60, v_other_series, false);
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_edited then raise exception 'T6f FAILED: another series'' session selected'; end if;
  raise notice 'T6f PASSED: sessions of other series (same coach, closer dates) are never selected';

  -- (g) 'edited' occurrence whose session was moved AFTER the target -> ignored; a later-dated session is ignored.
  v_s_moved := gen_random_uuid(); v_o := gen_random_uuid();
  insert into public.session_series_occurrences (id, series_id, template_occurrence_date, template_coach_id, template_start_time, state)
  values (v_o, v_series, v_target - 5, v_coach, v_t, 'claimed');
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached, series_occurrence_id)
  values (v_s_moved, v_target + 3, v_t, v_coach, 4, true, 60, v_series, false, v_o);
  update public.session_series_occurrences set state = 'edited', training_session_id = v_s_moved where id = v_o;
  v_s_future := gen_random_uuid();
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached)
  values (v_s_future, v_target + 7, v_t, v_coach, 4, true, 60, v_series, false);
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_edited then raise exception 'T6g FAILED: a session dated after the target was selected'; end if;
  raise notice 'T6g PASSED: sessions dated after the target are never selected';

  -- (h) multiple valid earlier occurrences -> the latest logical one (ledger 'generated' at target-3).
  v_s_gen := gen_random_uuid(); v_o := gen_random_uuid();
  insert into public.session_series_occurrences (id, series_id, template_occurrence_date, template_coach_id, template_start_time, state)
  values (v_o, v_series, v_target - 3, v_coach, v_t, 'claimed');
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes, series_id, series_detached, series_occurrence_id)
  values (v_s_gen, v_target - 3, v_t, v_coach, 4, true, 60, v_series, false, v_o);
  update public.session_series_occurrences set state = 'generated', training_session_id = v_s_gen where id = v_o;
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_gen then raise exception 'T6h FAILED: latest earlier occurrence not selected'; end if;
  raise notice 'T6h PASSED: the latest valid earlier logical occurrence is selected';

  -- (i) capacity is irrelevant: change every session of the series to capacity 12 / 1 -> same selection.
  update public.training_sessions set max_participants = 12 where series_id = v_series;
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_gen then raise exception 'T6i FAILED: capacity 12 changed selection'; end if;
  update public.training_sessions set max_participants = 1 where series_id = v_series;
  if public._series_roster_source_session(v_series, v_target) is distinct from v_s_gen then raise exception 'T6i FAILED: capacity 1 changed selection'; end if;
  raise notice 'T6i PASSED: capacity does not affect source selection';

  -- (j) the target date itself is never its own source.
  if public._series_roster_source_session(v_series, v_target - 3) is distinct from v_s_edited then raise exception 'T6j FAILED: target date selected as own source'; end if;
  raise notice 'T6j PASSED: an occurrence never selects itself';

  -- (k) the helper is not client-callable.
  if has_function_privilege('authenticated', 'public._series_roster_source_session(uuid, date)'::regprocedure, 'EXECUTE')
     or has_function_privilege('anon', 'public._series_roster_source_session(uuid, date)'::regprocedure, 'EXECUTE') then
    raise exception 'T6k FAILED: helper is client-executable';
  end if;
  raise notice 'T6k PASSED: helper is not executable by anon/authenticated';

  raise notice 'ALL SERIES ROSTER-SOURCE LOOKUP TESTS PASSED';
end $$;

rollback;

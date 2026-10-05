-- Regression test for 20261005160000_revoke_client_execute_on_series_internals.sql.
--
-- The internal recurring-series functions perform no caller authorization of their own, so no client
-- role may be able to execute them: anon/authenticated used to be able to call them directly through
-- the REST API (e.g. insert a manual participant into any session). This test asserts (a) the
-- privileges, (b) that real anon/authenticated calls are rejected with insufficient_privilege and
-- change nothing, and (c) that the legitimate entry points that rely on them still work.
-- Self-contained (own users/series), runs as the migration owner, rolled back at the end.
set client_min_messages to notice;
begin;

create temp table t133_fx(k text primary key, v uuid);
grant all on t133_fx to public;

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_ath uuid := gen_random_uuid();
  v_mp uuid;
  v_series uuid;
  v_s1 uuid;
  v_res json;
  v_fn text;
  v_role text;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', u.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values (v_mgr,   't133-mgr@test.local',   '0501330001'),
               (v_coach, 't133-coach@test.local', '0501330002'),
               (v_ath,   't133-ath@test.local',   '0501330003')) u(id, e, p);
  update public.profiles set role = 'manager', approval_status = 'approved' where user_id = v_mgr;
  update public.profiles set role = 'coach',   approval_status = 'approved' where user_id = v_coach;
  update public.profiles set approval_status = 'approved' where user_id = v_ath;

  -- T1: catalog privileges.
  foreach v_fn in array array[
    'public._series_add_manual_participant_checked(uuid, uuid)',
    'public._copy_session_roster(uuid, uuid)',
    'public._generate_series_occurrence_claim(uuid, date)',
    'public._generate_series_occurrences(uuid, date, date)',
    'public._maintain_session_series_horizon_core()',
    'public.cron_maintain_session_series_horizon()'
  ] loop
    foreach v_role in array array['public', 'anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn::regprocedure, 'EXECUTE') then
        raise exception 'T1 FAILED: % is executable by %', v_fn, v_role;
      end if;
    end loop;
  end loop;
  foreach v_fn in array array[
    'public.maintain_session_series_horizon()',
    'public.coach_add_athlete(uuid, uuid, boolean, boolean)',
    'public.staff_create_session_series(date, time, uuid, integer, integer, boolean, boolean, boolean, numeric, text, integer, boolean, uuid[], uuid[])'
  ] loop
    if not has_function_privilege('authenticated', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'T1 FAILED: legitimate entry point % lost EXECUTE for authenticated', v_fn;
    end if;
  end loop;
  raise notice 'T1 PASSED: internals are not executable by public/anon/authenticated; entry points still are';

  -- Fixtures through the legitimate entry point (also exercises the internals as a definer caller).
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  v_res := public.upsert_manual_participant('T133 Manual', '0501339999');
  v_mp := (v_res->>'manual_participant_id')::uuid;
  v_res := public.staff_create_session_series(
    current_date + 2, '05:00'::time, v_coach, 5, 60, true, false, false, null,
    'ongoing', null, true, array[v_ath], array[v_mp]);
  if not coalesce((v_res->>'ok')::boolean, false) or coalesce((v_res->>'count')::int, 0) < 1 then
    raise exception 'T4 FAILED: staff_create_session_series (manager) did not create sessions: %', v_res;
  end if;
  v_series := (v_res->>'series_id')::uuid;
  select id into v_s1 from public.training_sessions where series_id = v_series order by session_date limit 1;
  if not exists (select 1 from public.session_registrations where session_id = v_s1 and user_id = v_ath and status = 'active')
     or not exists (select 1 from public.session_manual_participants where session_id = v_s1 and manual_participant_id = v_mp) then
    raise exception 'T4 FAILED: series creation did not add the selected athlete and manual participant';
  end if;
  perform set_config('request.jwt.claims', '', true);
  insert into t133_fx values ('mp', v_mp), ('series', v_series), ('s1', v_s1), ('ath', v_ath), ('mgr', v_mgr), ('coach', v_coach);
  raise notice 'T4a PASSED: manager series creation (athlete + manual roster) works through the revoked internals';
end $$;

-- T2/T3: real anon/authenticated calls are rejected and change nothing.
create or replace function pg_temp.t133_denied(p_role text, p_sql text) returns boolean language plpgsql as $f$
begin
  execute 'set local role ' || p_role;
  if p_role = 'authenticated' then
    perform set_config('request.jwt.claims',
      json_build_object('sub', (select v from t133_fx where k = 'ath'), 'role', 'authenticated')::text, true);
  end if;
  begin
    execute p_sql;
  exception when insufficient_privilege then
    execute 'reset role';
    return true;
  end;
  execute 'reset role';
  return false;
end $f$;
grant execute on function pg_temp.t133_denied(text, text) to public;

do $$
declare
  v_role text;
  v_sql text;
  v_mp uuid := (select v from t133_fx where k = 'mp');
  v_series uuid := (select v from t133_fx where k = 'series');
  v_s1 uuid := (select v from t133_fx where k = 's1');
  v_s2 uuid := gen_random_uuid();
  v_before_sessions int;
  v_before_manual int;
begin
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes)
  values (v_s2, current_date + 3, '07:00', (select v from t133_fx where k = 'coach'), 1, true, 60);
  select count(*) into v_before_sessions from public.training_sessions where series_id = v_series;
  select count(*) into v_before_manual from public.session_manual_participants where session_id = v_s2;

  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_sql in array array[
      format('select public._series_add_manual_participant_checked(%L, %L)', v_s2, v_mp),
      format('select public._copy_session_roster(%L, %L)', v_s1, v_s2),
      format('select public._generate_series_occurrence_claim(%L, %L)', v_series, current_date + 30),
      format('select public._generate_series_occurrences(%L, %L, %L)', v_series, current_date + 30, current_date + 30),
      'select public._maintain_session_series_horizon_core()',
      'select public.cron_maintain_session_series_horizon()'
    ] loop
      if not pg_temp.t133_denied(v_role, v_sql) then
        raise exception 'T2 FAILED: % could execute: %', v_role, v_sql;
      end if;
    end loop;
  end loop;
  raise notice 'T2 PASSED: anon and authenticated are rejected (42501) on all 6 internals';

  if (select count(*) from public.session_manual_participants where session_id = v_s2) <> v_before_manual
     or (select count(*) from public.training_sessions where series_id = v_series) <> v_before_sessions then
    raise exception 'T3 FAILED: a denied call changed data';
  end if;
  raise notice 'T3 PASSED: rejected calls changed no sessions or participants';
end $$;

-- T4: legitimate entry points and the owner/cron path still work.
do $$
declare
  v_res json;
  v_mgr uuid := (select v from t133_fx where k = 'mgr');
  v_ath uuid := (select v from t133_fx where k = 'ath');
  v_series uuid := (select v from t133_fx where k = 'series');
  v_s1 uuid := (select v from t133_fx where k = 's1');
begin
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  v_res := public.maintain_session_series_horizon();
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T4 FAILED: maintain_session_series_horizon (manager): %', v_res;
  end if;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'T4b PASSED: manager horizon maintenance works';

  -- Athlete callers are still refused by the entry points' own authorization (JSON, not a privilege error).
  perform set_config('request.jwt.claims', json_build_object('sub', v_ath, 'role', 'authenticated')::text, true);
  v_res := public.maintain_session_series_horizon();
  if (v_res->>'ok')::boolean is not false or v_res->>'error' <> 'forbidden' then
    raise exception 'T4 FAILED: athlete maintain_session_series_horizon should be forbidden: %', v_res;
  end if;
  v_res := public.coach_add_athlete(v_s1, v_ath, false, false);
  if (v_res->>'ok')::boolean is not false or v_res->>'error' <> 'forbidden' then
    raise exception 'T4 FAILED: athlete coach_add_athlete should be forbidden: %', v_res;
  end if;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'T4c PASSED: entry-point authorization unchanged (athlete -> forbidden)';

  -- Owner / pg_cron path (this script runs as the function owner, like the cron job).
  perform public.cron_maintain_session_series_horizon();
  perform public._generate_series_occurrences(v_series, current_date + 20, current_date + 20);
  raise notice 'T4d PASSED: owner/cron path can still execute the internals';

  raise notice 'ALL SERIES-INTERNALS EXECUTE-PRIVILEGE TESTS PASSED';
end $$;

rollback;

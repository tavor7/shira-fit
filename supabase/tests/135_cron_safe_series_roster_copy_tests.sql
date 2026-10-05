-- Regression test for 20261005180000_cron_safe_series_roster_copy.sql.
--
-- A copy_on_generate series must carry its athletes into the next occurrence whether the occurrence is
-- generated through the manager's client (authenticated) or by pg_cron (auth.uid() null). Before the
-- fix the cron path created the occurrence but every athlete add failed with not_authenticated.
-- The cron path is exercised with the exact statement the cron job runs
-- (select public.cron_maintain_session_series_horizon()) as the owning role with no JWT claims; the
-- manager path with maintain_session_series_horizon() and the manager's claims. Outcomes are compared
-- user by user, including rejected athletes, history and subscription coverage. Also asserts the
-- security model of the new internal core with real anon/authenticated roles.
-- Self-contained; everything is rolled back. Plain psql: any failure raises.
set client_min_messages to notice;
begin;

create temp table t135_fx(k text primary key, v uuid);
grant all on t135_fx to public;

do $$
declare
  v_mgr uuid := gen_random_uuid(); v_coach uuid := gen_random_uuid(); v_coach2 uuid := gen_random_uuid();
  v_a uuid := gen_random_uuid(); v_p uuid := gen_random_uuid(); v_d uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid(); v_c uuid := gen_random_uuid(); v_f uuid := gen_random_uuid(); v_z uuid := gen_random_uuid();
  v_mp uuid; v_res json; v_all jsonb;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
         jsonb_build_object('full_name', u.e, 'phone', '05013500' || lpad(u.n::text, 2, '0'), 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
  from (values (v_mgr,'t135-mgr@test.local',1),(v_coach,'t135-coach@test.local',2),(v_coach2,'t135-coach2@test.local',3),
               (v_a,'t135-a@test.local',4),(v_p,'t135-p@test.local',5),(v_d,'t135-d@test.local',6),
               (v_s,'t135-s@test.local',7),(v_c,'t135-c@test.local',8),(v_f,'t135-f@test.local',9),(v_z,'t135-z@test.local',10)) u(id, e, n);
  update public.profiles set role = 'manager', approval_status = 'approved' where user_id = v_mgr;
  update public.profiles set role = 'coach', approval_status = 'approved' where user_id in (v_coach, v_coach2);
  update public.profiles set approval_status = 'approved' where user_id in (v_a, v_p, v_d, v_s, v_c, v_f, v_z);

  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  v_res := public.upsert_manual_participant('T135 Manual', '0501359999');
  v_mp := (v_res->>'manual_participant_id')::uuid;
  -- S: subscribed, tier not included (rejected on copy). C: subscribed with every tier allowed (covered).
  v_res := public.create_subscription(v_s, false, 100, public._studio_today_date() - 1, null, 1::smallint, '[]'::jsonb);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T0 FAILED: subscription S: %', v_res; end if;
  select jsonb_agg(jsonb_build_object('tier', t, 'weekly_limit', 9)) into v_all from unnest(enum_range(null::public.subscription_tier)) t;
  v_res := public.create_subscription(v_c, false, 100, public._studio_today_date() - 1, null, 1::smallint, v_all);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T0 FAILED: subscription C: %', v_res; end if;
  perform set_config('request.jwt.claims', '', true);

  -- After they were registered (legacy data), P becomes pending and D disabled.
  insert into t135_fx values ('mgr', v_mgr), ('coach', v_coach), ('coach2', v_coach2), ('a', v_a), ('p', v_p), ('d', v_d),
                             ('s', v_s), ('c', v_c), ('f', v_f), ('z', v_z), ('mp', v_mp);
end $$;

-- Legacy copy series (no ledger rows): weekly sessions today-14 .. today+7. The latest session carries
-- athletes A, P, D, S, C and the manual participant.
create or replace function pg_temp.t135_legacy_series(p_cap int, p_policy text, p_start time) returns uuid language plpgsql as $f$
declare
  v_series uuid := gen_random_uuid(); v_today date := public._studio_today_date();
  v_coach uuid := (select v from t135_fx where k = 'coach'); v_i int; v_sid uuid; v_k text;
begin
  insert into public.session_series (id, coach_id, anchor_date, start_time, duration_minutes, max_participants,
                                     is_open_for_registration, repeat_mode, roster_policy, status)
  values (v_series, v_coach, v_today - 14, p_start, 60, p_cap, true, 'ongoing', p_policy::public.session_series_roster_policy, 'active');
  for v_i in 0..3 loop
    v_sid := gen_random_uuid();
    insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration,
                                          duration_minutes, series_id, series_detached)
    values (v_sid, v_today - 14 + v_i * 7, p_start, v_coach, p_cap, true, 60, v_series, false);
    if v_i = 3 then
      foreach v_k in array array['a', 'p', 'd', 's', 'c'] loop
        insert into public.session_registrations (session_id, user_id, status) values (v_sid, (select v from t135_fx where k = v_k), 'active');
      end loop;
      insert into public.session_manual_participants (session_id, manual_participant_id) values (v_sid, (select v from t135_fx where k = 'mp'));
    end if;
  end loop;
  return v_series;
end $f$;
grant execute on function pg_temp.t135_legacy_series(int, text, time) to public;

-- One-line, user-by-user description of a generated occurrence's roster (labels, not ids).
create or replace function pg_temp.t135_summary(p_series uuid, p_date date) returns text language plpgsql as $f$
declare v_sid uuid; v_out text := ''; r record;
begin
  select id into v_sid from public.training_sessions where series_id = p_series and session_date = p_date;
  if v_sid is null then return 'NO SESSION'; end if;
  for r in
    select x.k, reg.status::text st,
           (select count(*) from public.registration_history h where h.session_id = v_sid and h.user_id = x.v and h.event_type = 'registered') hist,
           (select cov.covered::text || '/' || coalesce(cov.non_coverage_reason::text, '-') || '/' || cov.tier::text
            from public.subscription_registration_coverage cov where cov.registration_id = reg.id) cov
    from t135_fx x left join public.session_registrations reg on reg.session_id = v_sid and reg.user_id = x.v
    where x.k in ('a', 'p', 'd', 's', 'c', 'f') order by x.k
  loop
    v_out := v_out || r.k || '=' || coalesce(r.st, '-') || ',h' || r.hist || ',' || coalesce(r.cov, 'nocov') || ' | ';
  end loop;
  v_out := v_out || 'manual=' || (exists (select 1 from public.session_manual_participants where session_id = v_sid and manual_participant_id = (select v from t135_fx where k = 'mp')))::text;
  return v_out;
end $f$;
grant execute on function pg_temp.t135_summary(uuid, date) to public;

do $$
declare
  v_today date := public._studio_today_date();
  v_pend uuid := (select v from t135_fx where k = 'p');
  v_dis uuid := (select v from t135_fx where k = 'd');
  v_mgr uuid := (select v from t135_fx where k = 'mgr');
  v_lm uuid; v_lc uuid; v_ln uuid;
  v_res json; sm text; sc text;
begin
  -- Twin legacy series; manager generation for one, the exact cron statement for the other.
  v_lm := pg_temp.t135_legacy_series(4, 'copy_on_generate', '05:00');
  update public.profiles set approval_status = 'pending' where user_id = v_pend;
  update public.profiles set disabled_at = now() - interval '3 days' where user_id = v_dis;

  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  v_res := public.maintain_session_series_horizon();
  perform set_config('request.jwt.claims', '', true);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T1 FAILED: manager horizon: %', v_res; end if;

  v_lc := pg_temp.t135_legacy_series(4, 'copy_on_generate', '05:30');
  v_ln := pg_temp.t135_legacy_series(4, 'none', '06:00');
  if auth.uid() is not null then raise exception 'T1 setup: expected no authenticated user for the cron run'; end if;
  perform public.cron_maintain_session_series_horizon();

  sm := pg_temp.t135_summary(v_lm, v_today + 14);
  sc := pg_temp.t135_summary(v_lc, v_today + 14);
  raise notice 'manager-generated: %', sm;
  raise notice 'cron-generated   : %', sc;
  if sm like 'NO SESSION%' or sc like 'NO SESSION%' then raise exception 'T1 FAILED: occurrence not generated (manager: %, cron: %)', sm, sc; end if;
  if sc not like 'a=active,h1,nocov | %' or sc not like '% c=active,h1,true/-/%' or sc not like '%manual=true' then
    raise exception 'T1 FAILED: cron-generated occurrence did not copy the athletes: %', sc;
  end if;
  raise notice 'T1 PASSED: cron path copies the athletes (and manual participant) into the generated occurrence';

  -- T2: identical outcome user by user on both paths: eligible athletes copied, pending / disabled /
  -- subscription-limited rejected, exactly one history event, coverage recorded for the covered athlete.
  if sm is distinct from sc then
    raise exception 'T2 FAILED: manager and cron outcomes differ -- manager: [%] cron: [%]', sm, sc;
  end if;
  if sc not like '%d=-,h0,nocov |%' or sc not like '%p=-,h0,nocov |%' or sc not like '%s=-,h0,nocov |%' then
    raise exception 'T2 FAILED: ineligible athletes were copied: %', sc;
  end if;
  if pg_temp.t135_summary(v_lm, v_today + 21) is distinct from pg_temp.t135_summary(v_lc, v_today + 21) then
    raise exception 'T2 FAILED: the following occurrence differs between paths';
  end if;
  raise notice 'T2 PASSED: manager and cron produce identical rosters, history and coverage; pending/disabled/limited athletes rejected on both';

  -- T3: roster_policy none copies nothing, athletes or manual.
  sc := pg_temp.t135_summary(v_ln, v_today + 14);
  if sc like 'NO SESSION%' then raise exception 'T3 FAILED: none-policy series not generated'; end if;
  if sc like '%=active%' or sc like '%manual=true' then raise exception 'T3 FAILED: roster copied although roster_policy = none: %', sc; end if;
  raise notice 'T3 PASSED: roster_policy none copies neither athletes nor manual participants';
end $$;

-- T4: capacity does not decide whether copying happens.
do $$
declare
  v_today date := public._studio_today_date();
  v_cap int; v_series uuid; v_ids uuid[] := '{}'; i int := 0; sc text;
begin
  foreach v_cap in array array[1, 4, 7, 12] loop
    i := i + 1;
    v_ids := v_ids || pg_temp.t135_legacy_series(v_cap, 'copy_on_generate', ('07:0' || i)::time);
  end loop;
  perform public.cron_maintain_session_series_horizon();
  i := 0;
  foreach v_series in array v_ids loop
    i := i + 1;
    sc := pg_temp.t135_summary(v_series, v_today + 14);
    if sc not like 'a=active,h1,nocov | %' or sc not like '% c=active,h1,true/-/%' or sc not like '%manual=true' then
      raise exception 'T4 FAILED: capacity % did not copy the roster: %', (array[1,4,7,12])[i], sc;
    end if;
    raise notice 'T4 PASSED: capacity % (cron) copied athletes and manual participant', (array[1,4,7,12])[i];
  end loop;
end $$;

-- T5: duplicate and full-session behavior is the same in the cron and the manager context.
do $$
declare
  v_coach uuid := (select v from t135_fx where k = 'coach');
  v_a uuid := (select v from t135_fx where k = 'a');
  v_f uuid := (select v from t135_fx where k = 'f');
  v_mgr uuid := (select v from t135_fx where k = 'mgr');
  v_src uuid := gen_random_uuid();
  v_dst_c uuid := gen_random_uuid(); v_dst_m uuid := gen_random_uuid();
  v_full_c uuid := gen_random_uuid(); v_full_m uuid := gen_random_uuid();
  v_d date := public._studio_today_date() + 50;
  r_c text; r_m text;
begin
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes) values
    (v_src, v_d, '10:00', v_coach, 4, true, 60), (v_dst_c, v_d, '11:00', v_coach, 4, true, 60), (v_dst_m, v_d, '12:00', v_coach, 4, true, 60),
    (v_full_c, v_d, '13:00', v_coach, 1, true, 60), (v_full_m, v_d, '14:00', v_coach, 1, true, 60);
  insert into public.session_registrations (session_id, user_id, status) values (v_src, v_a, 'active');
  insert into public.session_registrations (session_id, user_id, status) values (v_full_c, v_f, 'active'), (v_full_m, v_f, 'active');

  -- cron context, twice (duplicate), then into a full session
  perform set_config('request.jwt.claims', '', true);
  perform public._copy_session_roster(v_src, v_dst_c);
  perform public._copy_session_roster(v_src, v_dst_c);
  perform public._copy_session_roster(v_src, v_full_c);
  -- manager context, same operations
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  perform public._copy_session_roster(v_src, v_dst_m);
  perform public._copy_session_roster(v_src, v_dst_m);
  perform public._copy_session_roster(v_src, v_full_m);
  perform set_config('request.jwt.claims', '', true);

  select count(*) || '/' || (select count(*) from public.registration_history where session_id = v_dst_c and user_id = v_a)
         || '/' || (select count(*) from public.session_registrations where session_id = v_full_c and status = 'active')
    into r_c from public.session_registrations where session_id = v_dst_c and user_id = v_a and status = 'active';
  select count(*) || '/' || (select count(*) from public.registration_history where session_id = v_dst_m and user_id = v_a)
         || '/' || (select count(*) from public.session_registrations where session_id = v_full_m and status = 'active')
    into r_m from public.session_registrations where session_id = v_dst_m and user_id = v_a and status = 'active';
  raise notice 'duplicate/full outcome (active A / history events / active in full session): cron=%  manager=%', r_c, r_m;
  if r_c is distinct from r_m then raise exception 'T5 FAILED: cron and manager contexts differ (cron %, manager %)', r_c, r_m; end if;
  if split_part(r_c, '/', 1) <> '1' then raise exception 'T5 FAILED: duplicate produced % active registrations', split_part(r_c, '/', 1); end if;
  if split_part(r_c, '/', 3) <> '2' then raise exception 'T5 FAILED: full session behavior changed (override copy expected, got %)', split_part(r_c, '/', 3); end if;
  raise notice 'T5 PASSED: duplicates and full-session (over-capacity copy) behave identically on both paths';
end $$;

-- ===== Security model, with real roles =====
create or replace function pg_temp.t135_denied(p_role text, p_claims_sub uuid, p_sql text) returns boolean language plpgsql as $f$
begin
  execute 'set local role ' || p_role;
  if p_claims_sub is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', p_claims_sub, 'role', p_role)::text, true);
  end if;
  begin
    execute p_sql;
  exception when insufficient_privilege then
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    return true;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return false;
end $f$;
grant execute on function pg_temp.t135_denied(text, uuid, text) to public;

do $$
declare
  v_fn text; v_role text;
  v_sess uuid := (select id from public.training_sessions order by session_date desc limit 1);
  v_z uuid := (select v from t135_fx where k = 'z');
  v_coach uuid := (select v from t135_fx where k = 'coach');
  v_mgr uuid := (select v from t135_fx where k = 'mgr');
  v_sql text;
begin
  -- T6: catalog: the internal core and everything from Phases A and B stay closed to client roles.
  foreach v_fn in array array[
    'public._coach_add_athlete_core(uuid, uuid, boolean, boolean, uuid)',
    'public._copy_session_roster(uuid, uuid)',
    'public._series_add_manual_participant_checked(uuid, uuid)',
    'public._generate_series_occurrence_claim(uuid, date)',
    'public._generate_series_occurrences(uuid, date, date)',
    'public._maintain_session_series_horizon_core()',
    'public.cron_maintain_session_series_horizon()',
    'public._series_roster_source_session(uuid, date)'
  ] loop
    foreach v_role in array array['public', 'anon', 'authenticated'] loop
      if has_function_privilege(v_role, v_fn::regprocedure, 'EXECUTE') then
        raise exception 'T6 FAILED: % is executable by %', v_fn, v_role;
      end if;
    end loop;
  end loop;
  if has_function_privilege('service_role', 'public._coach_add_athlete_core(uuid, uuid, boolean, boolean, uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'T6 FAILED: the core is executable by service_role';
  end if;
  raise notice 'T6 PASSED: internal core and Phase A/B internals are not executable by public/anon/authenticated';

  -- T7: real role calls to the core are rejected for anon, an athlete, a coach and a manager.
  v_sql := format('select public._coach_add_athlete_core(%L, %L, true, false, null)', v_sess, v_z);
  if not pg_temp.t135_denied('anon', null, v_sql) then raise exception 'T7 FAILED: anon executed the core'; end if;
  if not pg_temp.t135_denied('authenticated', v_z, v_sql) then raise exception 'T7 FAILED: an athlete executed the core'; end if;
  if not pg_temp.t135_denied('authenticated', v_coach, v_sql) then raise exception 'T7 FAILED: a coach executed the core'; end if;
  if not pg_temp.t135_denied('authenticated', v_mgr, v_sql) then raise exception 'T7 FAILED: a manager executed the core'; end if;
  v_sql := format('select public._copy_session_roster(%L, %L)', v_sess, v_sess);
  if not pg_temp.t135_denied('authenticated', v_mgr, v_sql) then raise exception 'T7 FAILED: a manager executed _copy_session_roster'; end if;
  raise notice 'T7 PASSED: anon, athlete, coach and manager client roles cannot execute the core or _copy_session_roster';
end $$;

do $$
declare
  v_z uuid := (select v from t135_fx where k = 'z'); v_mgr uuid := (select v from t135_fx where k = 'mgr');
  v_coach uuid := (select v from t135_fx where k = 'coach'); v_coach2 uuid := (select v from t135_fx where k = 'coach2');
  v_a uuid := (select v from t135_fx where k = 'a');
  v_s uuid := gen_random_uuid(); v_res json; v_regs int; v_sessions int;
begin
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, duration_minutes)
  values (v_s, public._studio_today_date() + 60, '15:00', v_coach, 5, true, 60);

  -- T8: coach_add_athlete authorization contract unchanged.
  perform set_config('request.jwt.claims', '', true);
  v_res := public.coach_add_athlete(v_s, v_a, false, false);
  if v_res->>'error' is distinct from 'not_authenticated' then raise exception 'T8 FAILED: unauthenticated -> %', v_res; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_z, 'role', 'authenticated')::text, true);
  v_res := public.coach_add_athlete(v_s, v_a, false, false);
  if v_res->>'error' is distinct from 'forbidden' then raise exception 'T8 FAILED: athlete -> %', v_res; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach2, 'role', 'authenticated')::text, true);
  v_res := public.coach_add_athlete(v_s, v_a, false, false);
  if v_res->>'error' is distinct from 'forbidden' then raise exception 'T8 FAILED: non-owner coach -> %', v_res; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_coach, 'role', 'authenticated')::text, true);
  v_res := public.coach_add_athlete(v_s, v_a, false, false);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T8 FAILED: owner coach -> %', v_res; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  v_res := public.coach_add_athlete(v_s, (select v from t135_fx where k = 'f'), false, false);
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'T8 FAILED: manager -> %', v_res; end if;
  perform set_config('request.jwt.claims', '', true);
  raise notice 'T8 PASSED: coach_add_athlete: unauthenticated/athlete/non-owner coach rejected, owner coach and manager allowed';

  -- T9: the only client-callable functions that reach the copy path refuse non-staff callers and do nothing.
  select count(*) into v_regs from public.session_registrations;
  select count(*) into v_sessions from public.training_sessions;
  execute 'set local role anon';
  v_res := public.staff_create_session_series(public._studio_today_date() + 3, '16:00'::time, v_coach, 4, 60, true, false, false, null, 'ongoing', null, true, array[v_a], '{}'::uuid[]);
  if v_res->>'error' is distinct from 'not_authenticated' then execute 'reset role'; raise exception 'T9 FAILED: anon staff_create_session_series -> %', v_res; end if;
  v_res := public.maintain_session_series_horizon();
  if v_res->>'error' is distinct from 'not_authenticated' then execute 'reset role'; raise exception 'T9 FAILED: anon maintain horizon -> %', v_res; end if;
  execute 'reset role';
  execute 'set local role authenticated';
  perform set_config('request.jwt.claims', json_build_object('sub', v_z, 'role', 'authenticated')::text, true);
  v_res := public.staff_create_session_series(public._studio_today_date() + 3, '16:00'::time, v_coach, 4, 60, true, false, false, null, 'ongoing', null, true, array[v_a], '{}'::uuid[]);
  if v_res->>'error' is distinct from 'forbidden' then execute 'reset role'; raise exception 'T9 FAILED: athlete staff_create_session_series -> %', v_res; end if;
  v_res := public.maintain_session_series_horizon();
  if v_res->>'error' is distinct from 'forbidden' then execute 'reset role'; raise exception 'T9 FAILED: athlete maintain horizon -> %', v_res; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  if (select count(*) from public.session_registrations) <> v_regs or (select count(*) from public.training_sessions) <> v_sessions then
    raise exception 'T9 FAILED: a rejected call changed data';
  end if;
  raise notice 'T9 PASSED: anon and athlete cannot reach the roster-copy path through the public series entry points';
end $$;

do $$
declare
  v_z uuid := (select v from t135_fx where k = 'z'); v_mgr uuid := (select v from t135_fx where k = 'mgr');
  v_s uuid := (select id from public.training_sessions order by session_date desc limit 1);
begin
  -- T10: direct INSERT into session_registrations stays blocked for athlete and manager roles.
  if not pg_temp.t135_denied('authenticated', v_z, format('insert into public.session_registrations(session_id,user_id,status) values (%L,%L,''active'')', v_s, v_z)) then
    raise exception 'T10 FAILED: an athlete inserted a registration directly';
  end if;
  if not pg_temp.t135_denied('authenticated', v_mgr, format('insert into public.session_registrations(session_id,user_id,status) values (%L,%L,''active'')', v_s, v_z)) then
    raise exception 'T10 FAILED: a manager inserted a registration directly';
  end if;
  if not pg_temp.t135_denied('authenticated', v_z, format('insert into public.waitlist_requests(session_id,user_id) values (%L,%L)', v_s, v_z)) then
    raise exception 'T10 FAILED: an athlete inserted a waitlist request directly';
  end if;
  raise notice 'T10 PASSED: direct registration / waitlist INSERT remains blocked';

  -- T11: profile privilege escalation stays blocked.
  if not pg_temp.t135_denied('authenticated', v_z, format('update public.profiles set role = ''manager'' where user_id = %L', v_z)) then
    raise exception 'T11 FAILED: an athlete changed their own role';
  end if;
  raise notice 'T11 PASSED: profile privilege escalation remains blocked';

  raise notice 'ALL CRON-SAFE ROSTER-COPY TESTS PASSED';
end $$;

rollback;

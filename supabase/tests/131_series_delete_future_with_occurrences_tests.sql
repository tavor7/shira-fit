-- Regression test for 20261005140000_series_delete_future_tombstone_occurrences.sql.
--
-- staff_delete_session_series_scope(..., 'future') used to fail with
-- "violates check constraint session_series_occurrences_materialized_requires_session" whenever a
-- deleted session was linked to a generated/edited ledger occurrence. Self-contained: creates its
-- own manager, coach, series, sessions and occurrences inside one transaction and rolls back.
-- Runs against the real migrated schema (plain psql: any failure raises an exception).
set client_min_messages to notice;
begin;

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_series uuid;
  v_s1 uuid; v_s2 uuid; v_s3 uuid;
  v_o1 uuid; v_o2 uuid; v_o3 uuid;
  v_res json;
  v_left int;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values
    (v_mgr,   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't131-mgr@test.local',
     '{"full_name":"T131 Mgr","phone":"0501310001","gender":"female","address":"A","zip_code":"1"}', now(), now()),
    (v_coach, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't131-coach@test.local',
     '{"full_name":"T131 Coach","phone":"0501310002","gender":"female","address":"A","zip_code":"1"}', now(), now());
  update public.profiles set role = 'manager', approval_status = 'approved' where user_id = v_mgr;
  update public.profiles set role = 'coach',   approval_status = 'approved' where user_id = v_coach;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);

  v_res := public.staff_create_session_series(
    current_date + 400, '09:00'::time, v_coach, 5, 60, true, false, false, null,
    'fixed', 3, false, '{}'::uuid[], '{}'::uuid[]);
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T0 FAILED: could not create series: %', v_res;
  end if;
  v_series := (v_res->>'series_id')::uuid;

  select id into v_s1 from public.training_sessions where series_id = v_series order by session_date limit 1 offset 0;
  select id into v_s2 from public.training_sessions where series_id = v_series order by session_date limit 1 offset 1;
  select id into v_s3 from public.training_sessions where series_id = v_series order by session_date limit 1 offset 2;

  -- Link every session to a materialized ledger row (the production state that triggers the bug).
  insert into public.session_series_occurrences (series_id, template_occurrence_date, template_coach_id, template_start_time, state, training_session_id)
  select v_series, t.session_date, t.coach_id, t.start_time, 'generated', t.id
  from public.training_sessions t where t.id in (v_s1, v_s2, v_s3)
  on conflict (series_id, template_occurrence_date) do update set state = 'generated', training_session_id = excluded.training_session_id;
  update public.training_sessions t set series_occurrence_id = o.id
  from public.session_series_occurrences o where o.training_session_id = t.id and t.id in (v_s1, v_s2, v_s3);
  update public.session_series_occurrences set state = 'edited' where training_session_id = v_s3;

  -- T1: 'future' from the 2nd session deletes sessions 2 and 3 only, with no constraint violation.
  v_res := public.staff_delete_session_series_scope(v_s2, 'future');
  if not coalesce((v_res->>'ok')::boolean, false) then
    raise exception 'T1 FAILED: future-scope delete returned %', v_res;
  end if;
  select count(*) into v_left from public.training_sessions where id in (v_s2, v_s3);
  if v_left <> 0 then raise exception 'T1 FAILED: % of the future sessions still exist', v_left; end if;
  if not exists (select 1 from public.training_sessions where id = v_s1) then
    raise exception 'T1 FAILED: the earlier session was deleted';
  end if;
  raise notice 'T1 PASSED: future-scope delete succeeds with linked occurrences and keeps earlier sessions';

  -- T2: deleted sessions' occurrences are tombstoned; the kept session's occurrence is untouched.
  if exists (select 1 from public.session_series_occurrences
             where series_id = v_series and template_occurrence_date in
               (select template_occurrence_date from public.session_series_occurrences o2 where o2.series_id = v_series)
               and state in ('generated','edited') and training_session_id is null) then
    raise exception 'T2 FAILED: a materialized occurrence has no session';
  end if;
  if (select count(*) from public.session_series_occurrences where series_id = v_series and state = 'deleted') <> 2 then
    raise exception 'T2 FAILED: expected exactly 2 tombstoned occurrences';
  end if;
  if (select state from public.session_series_occurrences where training_session_id = v_s1) <> 'generated' then
    raise exception 'T2 FAILED: the kept session''s occurrence changed';
  end if;
  if (select status from public.session_series where id = v_series) <> 'ended' then
    raise exception 'T2 FAILED: series was not marked ended';
  end if;
  raise notice 'T2 PASSED: occurrences tombstoned, kept occurrence intact, series ended';

  raise notice 'ALL SERIES DELETE-FUTURE TESTS (T1-T2) PASSED';
end $$;

rollback;

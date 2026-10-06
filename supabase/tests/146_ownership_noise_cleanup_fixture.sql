-- Production-shaped fixture for 20261008100000_cleanup_series_unresolved_ownership_noise.sql (test 146).
--
-- SCRATCH DATABASES ONLY: commits data. Recreates, from the read-only investigation of production:
--   * the 3 coaches and the 21 reviewed series of the 11 duplicate pairs (exact ids, templates, anchors, skip dates,
--     status and ended_from_date as left by the recovery), with the survivors' sessions generated through the horizon
--     by the real generator (so every recurring-series invariant holds);
--   * 38,132 series_unresolved_ownership rows in the exact 55 raw metadata groups of production (54 logical
--     conflicts; one conflict was logged with two candidate orders), with the exact per-group counts and first/last
--     timestamps -- so count, window and grouping equal production. Row ids are random, so the two md5
--     fingerprints differ from production; the harness substitutes ONLY those two constants in its test copy;
--   * ~1,000 unrelated events plus deliberate near-miss rows that must survive the cleanup.
-- No personal data: coach/series ids, times and dates only.
set client_min_messages to warning;
select set_config('shira.skip_activity_log', 'on', false);

-- coaches (profiles are created by the auth trigger)
insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.e,
       jsonb_build_object('full_name', u.e, 'phone', '0501460' || u.n, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now()
from (values ('358d14ba-9971-4a6b-b317-1a435001ea83'::uuid, 't146-coach-1@test.local', '001'),
             ('6c142117-438d-402d-be9e-8407900836b0'::uuid, 't146-coach-2@test.local', '002'),
             ('e1ef1a40-d2cb-418c-8ef1-c3fd142e6336'::uuid, 't146-coach-3@test.local', '003')) u(id, e, n)
on conflict (id) do nothing;
update public.profiles set role = 'coach', approval_status = 'approved'
where user_id in ('358d14ba-9971-4a6b-b317-1a435001ea83', '6c142117-438d-402d-be9e-8407900836b0', 'e1ef1a40-d2cb-418c-8ef1-c3fd142e6336');

-- the 21 reviewed series, as in production after the recovery
insert into public.session_series (id, coach_id, start_time, anchor_date, skip_dates, ended_from_date, status, repeat_mode,
                                   duration_minutes, max_participants, is_hidden, is_open_for_registration, is_kickbox,
                                   custom_slot_price_ils, roster_policy)
select (j->>'id')::uuid, (j->>'coach_id')::uuid, (j->>'start_time')::time, (j->>'anchor_date')::date,
       coalesce((select array_agg(d::date) from jsonb_array_elements_text(j->'skip_dates') d), '{}'),
       (j->>'ended_from_date')::date, (j->>'status')::public.session_series_status, 'ongoing',
       (j->>'duration_minutes')::int, (j->>'max_participants')::int, (j->>'is_hidden')::boolean, false, false, null,
       (j->>'roster_policy')::public.session_series_roster_policy
from jsonb_array_elements($j$[
 {"id":"a8928386-7b0d-48c9-be77-2af3e0355f0e","coach_id":"e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","start_time":"09:00","anchor_date":"2026-07-02","skip_dates":["2026-07-09","2026-07-16","2026-07-23","2026-08-06","2026-08-13","2026-09-10"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":1,"is_hidden":true,"roster_policy":"copy_on_generate"},
 {"id":"37ea7bce-01e7-4a07-825c-1bfa63f86c2f","coach_id":"6c142117-438d-402d-be9e-8407900836b0","start_time":"09:30","anchor_date":"2026-06-30","skip_dates":["2026-07-14","2026-07-21","2026-07-28","2026-09-01","2026-09-22"],"ended_from_date":"2026-09-09","status":"ended","duration_minutes":55,"max_participants":1,"is_hidden":true,"roster_policy":"copy_on_generate"},
 {"id":"8714c05d-bf0f-44f6-ad42-2454b6cad92b","coach_id":"6c142117-438d-402d-be9e-8407900836b0","start_time":"18:00","anchor_date":"2026-08-11","skip_dates":["2026-08-25","2026-09-15","2026-09-29","2026-10-06"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"18b50099-f164-4003-a98a-9ce70e9c634f","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"18:00","anchor_date":"2026-08-12","skip_dates":["2026-09-02","2026-09-09","2026-09-30"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"30208b0d-a870-48e8-a3a4-d435de13f03b","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"09:00","anchor_date":"2026-09-16","skip_dates":["2026-09-30"],"ended_from_date":"2026-09-24","status":"ended","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"copy_on_generate"},
 {"id":"34eb4cae-3b61-4607-a55f-8a8bc21ac938","coach_id":"6c142117-438d-402d-be9e-8407900836b0","start_time":"19:00","anchor_date":"2026-07-12","skip_dates":["2026-07-12","2026-09-13","2026-09-20","2026-10-04"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"55d291e1-4f1c-492b-aa60-699ea42b408e","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"09:00","anchor_date":"2026-08-12","skip_dates":["2026-09-02","2026-09-09"],"ended_from_date":"2026-09-03","status":"ended","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"194db8c6-9733-43a3-b944-d6d504ec610a","coach_id":"e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","start_time":"09:00","anchor_date":"2026-09-24","skip_dates":[],"ended_from_date":"2026-10-02","status":"ended","duration_minutes":55,"max_participants":1,"is_hidden":true,"roster_policy":"copy_on_generate"},
 {"id":"f87738b8-dd0d-4be0-a765-aceaa35121b3","coach_id":"6c142117-438d-402d-be9e-8407900836b0","start_time":"18:00","anchor_date":"2026-06-02","skip_dates":["2026-06-02","2026-06-16","2026-06-23","2026-07-07","2026-07-14","2026-07-21","2026-07-28","2026-09-15","2026-10-06"],"ended_from_date":"2026-08-05","status":"ended","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"afc49504-e2d0-4e53-8b03-555763974b70","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"09:00","anchor_date":"2026-06-03","skip_dates":["2026-08-05"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"bf756f0b-b4e7-435d-8a05-3cda60d3e021","coach_id":"e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","start_time":"08:00","anchor_date":"2026-08-20","skip_dates":["2026-09-10"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"df74284d-add2-4c46-913b-4ad6cbfd1c48","coach_id":"e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","start_time":"08:00","anchor_date":"2026-09-17","skip_dates":[],"ended_from_date":"2026-10-02","status":"ended","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"c6a208b5-7f22-4757-8ec9-fdbe36b6ee40","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"18:00","anchor_date":"2026-09-16","skip_dates":["2026-09-23","2026-09-30"],"ended_from_date":"2026-09-17","status":"ended","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"ead14374-a7ea-4ac0-b874-f84f1f6f51ba","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"18:00","anchor_date":"2026-06-11","skip_dates":["2026-06-18","2026-06-25","2026-07-09","2026-07-23","2026-08-06"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"d889634f-5d05-488c-8f42-1ce703104a44","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"10:00","anchor_date":"2026-05-31","skip_dates":["2026-09-13","2026-10-04"],"ended_from_date":"2026-09-28","status":"ended","duration_minutes":55,"max_participants":1,"is_hidden":true,"roster_policy":"copy_on_generate"},
 {"id":"d9d19473-29f1-4501-9edb-f57b3ea890a8","coach_id":"6c142117-438d-402d-be9e-8407900836b0","start_time":"09:30","anchor_date":"2026-09-15","skip_dates":["2026-09-22"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":1,"is_hidden":true,"roster_policy":"copy_on_generate"},
 {"id":"f5c2c55a-4da4-411c-9541-e0d8155d1e29","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"09:00","anchor_date":"2026-08-09","skip_dates":["2026-08-30","2026-09-06","2026-09-13","2026-09-20"],"ended_from_date":"2026-08-24","status":"ended","duration_minutes":55,"max_participants":1,"is_hidden":true,"roster_policy":"copy_on_generate"},
 {"id":"00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"09:00","anchor_date":"2026-05-31","skip_dates":["2026-09-13","2026-09-20"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":1,"is_hidden":true,"roster_policy":"copy_on_generate"},
 {"id":"b52db63b-93f7-491d-953e-97e907270980","coach_id":"6c142117-438d-402d-be9e-8407900836b0","start_time":"19:00","anchor_date":"2026-08-16","skip_dates":["2026-08-16","2026-08-30","2026-09-06","2026-09-13","2026-09-20"],"ended_from_date":"2026-10-05","status":"ended","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"8a6c9d3f-9adb-44a6-bbf3-1454d24e7838","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"18:00","anchor_date":"2026-08-13","skip_dates":["2026-08-20","2026-08-27","2026-09-03","2026-09-10"],"ended_from_date":"2026-08-28","status":"ended","duration_minutes":55,"max_participants":12,"is_hidden":false,"roster_policy":"none"},
 {"id":"bd535cac-0b53-495b-b3a1-33005d6d00ba","coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","start_time":"10:00","anchor_date":"2026-08-09","skip_dates":["2026-08-30","2026-09-06","2026-09-13"],"ended_from_date":null,"status":"active","duration_minutes":55,"max_participants":1,"is_hidden":true,"roster_policy":"copy_on_generate"}
]$j$::jsonb) j;

-- survivors' sessions through the horizon, generated by the real generator (activity logging is off)
do $$
declare v json;
begin
  v := public._maintain_session_series_horizon_core();
  if (v->>'unresolved_ownership')::int <> 0 or (v->>'failed')::int <> 0 or (v->>'created')::int = 0 then
    raise exception 'fixture: horizon generation unexpected: %', v;
  end if;
end $$;

-- 38,132 incident rows: the exact 55 raw (metadata-level) groups of production, linearly spread between each
-- group's real first and last timestamp (so the global window equals production exactly).
insert into public.user_activity_events (id, created_at, actor_user_id, event_type, target_type, target_id, metadata)
select gen_random_uuid(),
       case when g.n = 1 then g.mn else g.mn + (g.mx - g.mn) * (k::double precision / (g.n - 1)) end,
       null, 'series_unresolved_ownership', 'session_series', null,
       jsonb_build_object('template_coach_id', g.c, 'template_start_time', g.st, 'template_occurrence_date', g.d,
                          'candidate_series_ids', g.cand)
from (select (x->>'c')::uuid c, (x->>'st')::time st, (x->>'d')::date d, x->'cand' cand, (x->>'n')::int n,
             (x->>'mn')::timestamptz mn, (x->>'mx')::timestamptz mx
      from jsonb_array_elements($g$[
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-04",["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","f5c2c55a-4da4-411c-9541-e0d8155d1e29"],635,"2026-10-01 11:58:45.570209+00","2026-10-04 20:24:43.65627+00"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-04",["f5c2c55a-4da4-411c-9541-e0d8155d1e29","00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2"],57,"2026-10-01 11:50:05.054777+00","2026-10-01 12:18:17.25317+00"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-07",["afc49504-e2d0-4e53-8b03-555763974b70","30208b0d-a870-48e8-a3a4-d435de13f03b","55d291e1-4f1c-492b-aa60-699ea42b408e"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-11",["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","f5c2c55a-4da4-411c-9541-e0d8155d1e29"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-14",["afc49504-e2d0-4e53-8b03-555763974b70","30208b0d-a870-48e8-a3a4-d435de13f03b","55d291e1-4f1c-492b-aa60-699ea42b408e"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-18",["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","f5c2c55a-4da4-411c-9541-e0d8155d1e29"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-21",["afc49504-e2d0-4e53-8b03-555763974b70","30208b0d-a870-48e8-a3a4-d435de13f03b","55d291e1-4f1c-492b-aa60-699ea42b408e"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-25",["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","f5c2c55a-4da4-411c-9541-e0d8155d1e29"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-10-28",["afc49504-e2d0-4e53-8b03-555763974b70","30208b0d-a870-48e8-a3a4-d435de13f03b","55d291e1-4f1c-492b-aa60-699ea42b408e"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-11-01",["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","f5c2c55a-4da4-411c-9541-e0d8155d1e29"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-11-04",["afc49504-e2d0-4e53-8b03-555763974b70","30208b0d-a870-48e8-a3a4-d435de13f03b","55d291e1-4f1c-492b-aa60-699ea42b408e"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","09:00:00","2026-11-08",["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","f5c2c55a-4da4-411c-9541-e0d8155d1e29"],539,"2026-10-04 02:15:00.174045+00","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","10:00:00","2026-10-04",["d889634f-5d05-488c-8f42-1ce703104a44","bd535cac-0b53-495b-b3a1-33005d6d00ba"],174,"F","2026-10-02 08:51:34.55758+00"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","10:00:00","2026-10-11",["d889634f-5d05-488c-8f42-1ce703104a44","bd535cac-0b53-495b-b3a1-33005d6d00ba"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","10:00:00","2026-10-18",["d889634f-5d05-488c-8f42-1ce703104a44","bd535cac-0b53-495b-b3a1-33005d6d00ba"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","10:00:00","2026-10-25",["d889634f-5d05-488c-8f42-1ce703104a44","bd535cac-0b53-495b-b3a1-33005d6d00ba"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","10:00:00","2026-11-01",["d889634f-5d05-488c-8f42-1ce703104a44","bd535cac-0b53-495b-b3a1-33005d6d00ba"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","10:00:00","2026-11-08",["d889634f-5d05-488c-8f42-1ce703104a44","bd535cac-0b53-495b-b3a1-33005d6d00ba"],539,"2026-10-04 02:15:00.174045+00","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-01",["8a6c9d3f-9adb-44a6-bbf3-1454d24e7838","ead14374-a7ea-4ac0-b874-f84f1f6f51ba"],153,"F","2026-10-01 17:18:47.220389+00"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-07",["c6a208b5-7f22-4757-8ec9-fdbe36b6ee40","18b50099-f164-4003-a98a-9ce70e9c634f"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-08",["8a6c9d3f-9adb-44a6-bbf3-1454d24e7838","ead14374-a7ea-4ac0-b874-f84f1f6f51ba"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-14",["c6a208b5-7f22-4757-8ec9-fdbe36b6ee40","18b50099-f164-4003-a98a-9ce70e9c634f"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-15",["8a6c9d3f-9adb-44a6-bbf3-1454d24e7838","ead14374-a7ea-4ac0-b874-f84f1f6f51ba"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-21",["c6a208b5-7f22-4757-8ec9-fdbe36b6ee40","18b50099-f164-4003-a98a-9ce70e9c634f"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-22",["8a6c9d3f-9adb-44a6-bbf3-1454d24e7838","ead14374-a7ea-4ac0-b874-f84f1f6f51ba"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-28",["c6a208b5-7f22-4757-8ec9-fdbe36b6ee40","18b50099-f164-4003-a98a-9ce70e9c634f"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-10-29",["8a6c9d3f-9adb-44a6-bbf3-1454d24e7838","ead14374-a7ea-4ac0-b874-f84f1f6f51ba"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-11-04",["c6a208b5-7f22-4757-8ec9-fdbe36b6ee40","18b50099-f164-4003-a98a-9ce70e9c634f"],765,"F","L"],
 ["358d14ba-9971-4a6b-b317-1a435001ea83","18:00:00","2026-11-05",["8a6c9d3f-9adb-44a6-bbf3-1454d24e7838","ead14374-a7ea-4ac0-b874-f84f1f6f51ba"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","09:30:00","2026-10-06",["d9d19473-29f1-4501-9edb-f57b3ea890a8","37ea7bce-01e7-4a07-825c-1bfa63f86c2f"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","09:30:00","2026-10-13",["d9d19473-29f1-4501-9edb-f57b3ea890a8","37ea7bce-01e7-4a07-825c-1bfa63f86c2f"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","09:30:00","2026-10-20",["d9d19473-29f1-4501-9edb-f57b3ea890a8","37ea7bce-01e7-4a07-825c-1bfa63f86c2f"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","09:30:00","2026-10-27",["d9d19473-29f1-4501-9edb-f57b3ea890a8","37ea7bce-01e7-4a07-825c-1bfa63f86c2f"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","09:30:00","2026-11-03",["d9d19473-29f1-4501-9edb-f57b3ea890a8","37ea7bce-01e7-4a07-825c-1bfa63f86c2f"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","18:00:00","2026-10-13",["f87738b8-dd0d-4be0-a765-aceaa35121b3","8714c05d-bf0f-44f6-ad42-2454b6cad92b"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","18:00:00","2026-10-20",["f87738b8-dd0d-4be0-a765-aceaa35121b3","8714c05d-bf0f-44f6-ad42-2454b6cad92b"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","18:00:00","2026-10-27",["f87738b8-dd0d-4be0-a765-aceaa35121b3","8714c05d-bf0f-44f6-ad42-2454b6cad92b"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","18:00:00","2026-11-03",["f87738b8-dd0d-4be0-a765-aceaa35121b3","8714c05d-bf0f-44f6-ad42-2454b6cad92b"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","19:00:00","2026-10-11",["34eb4cae-3b61-4607-a55f-8a8bc21ac938","b52db63b-93f7-491d-953e-97e907270980"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","19:00:00","2026-10-18",["34eb4cae-3b61-4607-a55f-8a8bc21ac938","b52db63b-93f7-491d-953e-97e907270980"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","19:00:00","2026-10-25",["34eb4cae-3b61-4607-a55f-8a8bc21ac938","b52db63b-93f7-491d-953e-97e907270980"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","19:00:00","2026-11-01",["34eb4cae-3b61-4607-a55f-8a8bc21ac938","b52db63b-93f7-491d-953e-97e907270980"],765,"F","L"],
 ["6c142117-438d-402d-be9e-8407900836b0","19:00:00","2026-11-08",["34eb4cae-3b61-4607-a55f-8a8bc21ac938","b52db63b-93f7-491d-953e-97e907270980"],539,"2026-10-04 02:15:00.174045+00","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","08:00:00","2026-10-01",["df74284d-add2-4c46-913b-4ad6cbfd1c48","bf756f0b-b4e7-435d-8a05-3cda60d3e021"],153,"F","2026-10-01 17:18:47.220389+00"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","08:00:00","2026-10-08",["df74284d-add2-4c46-913b-4ad6cbfd1c48","bf756f0b-b4e7-435d-8a05-3cda60d3e021"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","08:00:00","2026-10-15",["df74284d-add2-4c46-913b-4ad6cbfd1c48","bf756f0b-b4e7-435d-8a05-3cda60d3e021"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","08:00:00","2026-10-22",["df74284d-add2-4c46-913b-4ad6cbfd1c48","bf756f0b-b4e7-435d-8a05-3cda60d3e021"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","08:00:00","2026-10-29",["df74284d-add2-4c46-913b-4ad6cbfd1c48","bf756f0b-b4e7-435d-8a05-3cda60d3e021"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","08:00:00","2026-11-05",["df74284d-add2-4c46-913b-4ad6cbfd1c48","bf756f0b-b4e7-435d-8a05-3cda60d3e021"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","09:00:00","2026-10-01",["194db8c6-9733-43a3-b944-d6d504ec610a","a8928386-7b0d-48c9-be77-2af3e0355f0e"],153,"F","2026-10-01 17:18:47.220389+00"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","09:00:00","2026-10-08",["194db8c6-9733-43a3-b944-d6d504ec610a","a8928386-7b0d-48c9-be77-2af3e0355f0e"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","09:00:00","2026-10-15",["194db8c6-9733-43a3-b944-d6d504ec610a","a8928386-7b0d-48c9-be77-2af3e0355f0e"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","09:00:00","2026-10-22",["194db8c6-9733-43a3-b944-d6d504ec610a","a8928386-7b0d-48c9-be77-2af3e0355f0e"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","09:00:00","2026-10-29",["194db8c6-9733-43a3-b944-d6d504ec610a","a8928386-7b0d-48c9-be77-2af3e0355f0e"],765,"F","L"],
 ["e1ef1a40-d2cb-418c-8ef1-c3fd142e6336","09:00:00","2026-11-05",["194db8c6-9733-43a3-b944-d6d504ec610a","a8928386-7b0d-48c9-be77-2af3e0355f0e"],765,"F","L"]
]$g$::jsonb) a(x0),
      lateral (select jsonb_build_object('c', x0->>0, 'st', x0->>1, 'd', x0->>2, 'cand', x0->3, 'n', x0->>4,
                 'mn', case x0->>5 when 'F' then '2026-10-01 11:50:05.054777+00' else x0->>5 end,
                 'mx', case x0->>6 when 'L' then '2026-10-05 19:42:13.157028+00' else x0->>6 end) x) l
     ) g
cross join lateral generate_series(0, g.n - 1) k;

-- ~1,000 unrelated events (a mix of business types, actors and timestamps around the incident)
insert into public.user_activity_events (created_at, actor_user_id, event_type, target_type, target_id, metadata)
select timestamptz '2026-09-20 11:00+00' + (i * interval '21 minutes'),
       case when i % 4 = 0 then null else (array['358d14ba-9971-4a6b-b317-1a435001ea83','6c142117-438d-402d-be9e-8407900836b0','e1ef1a40-d2cb-418c-8ef1-c3fd142e6336']::uuid[])[1 + i % 3] end,
       (array['session_registration','registration_attendance_updated','auth_login','session_updated','session_created',
              'session_registration_cancelled','account_payment_created','session_manual_participant_added'])[1 + i % 8],
       (array['training_session','training_session','profile','training_session','training_session','training_session','profile','session_manual_participant'])[1 + i % 8],
       gen_random_uuid()::text,
       jsonb_build_object('i', i, 'after', jsonb_build_object('note', 'filler'))
from generate_series(1, 1000) i;

-- near misses: structurally similar but NOT the incident; every one must survive the cleanup
insert into public.user_activity_events (created_at, actor_user_id, event_type, target_type, target_id, metadata)
values
 -- other series diagnostics with the identical metadata shape inside the window
 ('2026-10-03 10:00+00', null, 'series_slot_conflict', 'session_series', null,
  '{"template_coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","template_start_time":"09:00:00","template_occurrence_date":"2026-10-11","candidate_series_ids":["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","f5c2c55a-4da4-411c-9541-e0d8155d1e29"]}'),
 ('2026-10-03 10:00+00', null, 'series_logical_conflict', 'session_series', null,
  '{"template_coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","template_start_time":"09:00:00","template_occurrence_date":"2026-10-11","candidate_series_ids":["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2","f5c2c55a-4da4-411c-9541-e0d8155d1e29"]}'),
 ('2026-10-03 10:00+00', null, 'series_horizon_generation_failed', 'session_series', 'afc49504-e2d0-4e53-8b03-555763974b70',
  '{"operation":"maintain_session_series_horizon","error":"x","sqlstate":"P0001"}'),
 ('2026-10-03 10:00+00', null, 'series_horizon_reconcile_failed', 'session_series', null, '{"operation":"reconcile"}'),
 -- text mentions of the incident in unrelated events
 ('2026-10-04 09:00+00', '358d14ba-9971-4a6b-b317-1a435001ea83', 'session_note_created', 'training_session', gen_random_uuid()::text,
  '{"note":"series_unresolved_ownership candidate_series_ids template_occurrence_date"}'),
 ('2026-10-04 09:00+00', null, 'session_created', 'session_series', null,
  '{"after":{"reason":"unresolved ownership"},"candidate_series_ids":["00f90fa5-de3e-4692-b2cb-d0e6dd82d0a2"]}'),
 -- odd metadata shapes must not break the predicate (CASE-guarded): array, scalar, empty object
 ('2026-10-04 09:00+00', null, 'session_updated', 'training_session', gen_random_uuid()::text, '[1,2,3]'),
 ('2026-10-04 09:00+00', null, 'session_updated', 'training_session', gen_random_uuid()::text, '"scalar"'),
 ('2026-10-04 09:00+00', null, 'session_updated', null, null, '{}'),
 -- an incident-shaped event of ANOTHER type with candidates outside the reviewed series
 ('2026-10-02 09:00+00', null, 'series_unresolved_ownership_preview', 'session_series', null,
  '{"template_coach_id":"358d14ba-9971-4a6b-b317-1a435001ea83","template_start_time":"07:00:00","template_occurrence_date":"2026-10-11","candidate_series_ids":["11111111-1111-1111-1111-111111111111","22222222-2222-2222-2222-222222222222"]}'),
 -- events after the recovery boundary
 ('2026-10-05 19:53:27+00', null, 'session_created', 'training_session', gen_random_uuid()::text, '{"after":{}}'),
 ('2026-10-06 02:15:00+00', null, 'session_manual_participant_added', 'session_manual_participant', gen_random_uuid()::text, '{"session_id":"x"}');
update public.user_activity_events set reverted_at = '2026-10-04 12:00+00', reverted_by = '358d14ba-9971-4a6b-b317-1a435001ea83'
where id = (select id from public.user_activity_events where event_type = 'session_registration' order by created_at limit 1);

analyze public.user_activity_events;

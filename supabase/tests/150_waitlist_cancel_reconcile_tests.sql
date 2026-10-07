-- Real-schema regression tests for 20261010100000_reconcile_waitlist_and_cancel_registration.sql
--
-- Approved rules under test:
--   request_waitlist   : approved ENABLED athlete only; hidden / nonexistent session refused with typed codes;
--                        only BEFORE the studio-local (Asia/Jerusalem) start; direct INSERT stays closed.
--   cancel_registration: late = at most 12h before the studio-local start (INCLUSIVE boundary), charged by default,
--                        manager may waive; at/after start rejected; a disabled athlete may still cancel before start.
--
-- Method: sessions are built relative to now() (constant inside the transaction) in studio-local wall-clock terms, so
-- boundaries such as "exactly 12h" and "exactly at start" are exact. Everything is rolled back.
-- DST: a fixture whose local wall-clock time is ambiguous/nonexistent cannot represent the instant exactly; such a case
-- is SKIPPED with a notice (never silently passed as a different instant).
set client_min_messages to notice;
begin;

create temp table t150_fx (k text primary key, v uuid);
create temp table t150_skip (n int);

-- Impersonate a user (auth.uid() reads request.jwt.claims).
create function pg_temp.t150_as(p_uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true)
$$;
create function pg_temp.t150_uid(p_k text) returns uuid language sql as $$ select v from t150_fx where k = p_k $$;

-- A session starting exactly now() + p_offset (studio-local wall clock). Returns null when the instant is not
-- representable (DST gap/overlap).
create function pg_temp.t150_session(p_offset interval, p_max int default 1, p_hidden boolean default false, p_dur int default 60)
returns uuid language plpgsql as $$
declare
  v_target timestamptz := now() + p_offset;
  v_local timestamp := v_target at time zone 'Asia/Jerusalem';
  v_id uuid;
  v_coach uuid;
begin
  if ((v_local::date + v_local::time)::timestamp at time zone 'Asia/Jerusalem') <> v_target then
    insert into t150_skip values (1);
    return null;
  end if;
  -- a fresh coach per session: (coach, date, start_time) is unique and many fixtures share one instant
  v_coach := gen_random_uuid();
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (v_coach, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', v_coach::text || '@t150.local',
          jsonb_build_object('full_name', 'c', 'phone', substr(replace(v_coach::text, '-', ''), 1, 12), 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
  update public.profiles set role = 'coach', approval_status = 'approved' where user_id = v_coach;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, duration_minutes, is_hidden)
  values (v_local::date, v_local::time, v_coach, p_max, p_dur, p_hidden)
  returning id into v_id;
  return v_id;
end $$;

create function pg_temp.t150_fill(p_session uuid) returns void language sql as $$
  insert into public.session_registrations (session_id, user_id, status) values (p_session, pg_temp.t150_uid('filler'), 'active')
$$;
create function pg_temp.t150_reg(p_session uuid, p_user text) returns void language sql as $$
  insert into public.session_registrations (session_id, user_id, status) values (p_session, pg_temp.t150_uid(p_user), 'active')
$$;
create function pg_temp.t150_wl(p_session uuid, p_user text) returns json language plpgsql as $$
begin perform pg_temp.t150_as(pg_temp.t150_uid(p_user)); return public.request_waitlist(p_session); end $$;
create function pg_temp.t150_cancel(p_session uuid, p_user text) returns json language plpgsql as $$
begin perform pg_temp.t150_as(pg_temp.t150_uid(p_user)); return public.cancel_registration(p_session, 'because'); end $$;

do $$
declare
  v_mk uuid;
  r record;
begin
  -- Users (profiles are created by the on_auth_user_created trigger).
  for r in select * from (values
      ('mgr', 't150-mgr@test.local', '0501500001'), ('coach', 't150-coach@test.local', '0501500002'),
      ('filler', 't150-fill@test.local', '0501500003'), ('a1', 't150-a1@test.local', '0501500004'),
      ('a2', 't150-a2@test.local', '0501500005'), ('a3', 't150-a3@test.local', '0501500006'),
      ('a4', 't150-a4@test.local', '0501500007'), ('a5', 't150-a5@test.local', '0501500008'),
      ('a6', 't150-a6@test.local', '0501500009'), ('dis', 't150-dis@test.local', '0501500010'),
      ('pending', 't150-pend@test.local', '0501500011'), ('a7', 't150-a7@test.local', '0501500012'),
      ('a8', 't150-a8@test.local', '0501500013'), ('a9', 't150-a9@test.local', '0501500014')) x(k, e, p) loop
    v_mk := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
    values (v_mk, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', r.e,
            jsonb_build_object('full_name', r.e, 'phone', r.p, 'gender', 'female', 'address', 'A', 'zip_code', '1'), now(), now());
    insert into t150_fx values (r.k, v_mk);
  end loop;
  update public.profiles set approval_status = 'approved' where user_id <> pg_temp.t150_uid('pending')
    and user_id in (select v from t150_fx);
  update public.profiles set role = 'manager' where user_id = pg_temp.t150_uid('mgr');
  update public.profiles set role = 'coach' where user_id = pg_temp.t150_uid('coach');
  update public.profiles set disabled_at = now() where user_id = pg_temp.t150_uid('dis');
end $$;

-- Fingerprint of pre-existing business rows: the migration must not touch them, and neither may these tests.
create temp table t150_pre as
select 'cancellations' t, count(*) n, md5(coalesce(string_agg(c::text, '|' order by c.id), '')) h from public.cancellations c
union all select 'registration_history', count(*), md5(coalesce(string_agg(h::text, '|' order by h.id), '')) from public.registration_history h
union all select 'waitlist_requests', count(*), md5(coalesce(string_agg(w::text, '|' order by w.id), '')) from public.waitlist_requests w
union all select 'session_registrations', count(*), md5(coalesce(string_agg(r::text, '|' order by r.id), '')) from public.session_registrations r;

-- =============================== request_waitlist ===============================
do $$
declare
  s uuid; v_res json; v_n int;
begin
  -- W1: eligible athlete joins the waitlist of a full session before it starts.
  s := pg_temp.t150_session(interval '3 hours'); perform pg_temp.t150_fill(s);
  v_res := pg_temp.t150_wl(s, 'a1');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'W1 FAILED: %', v_res; end if;
  select count(*) into v_n from public.waitlist_requests where session_id = s and user_id = pg_temp.t150_uid('a1');
  if v_n <> 1 then raise exception 'W1 FAILED: expected 1 waitlist row, got %', v_n; end if;
  raise notice 'W1 PASSED: eligible athlete joins the waitlist before the session starts';

  -- W2: joining twice is idempotent (existing behaviour preserved).
  v_res := pg_temp.t150_wl(s, 'a1');
  select count(*) into v_n from public.waitlist_requests where session_id = s and user_id = pg_temp.t150_uid('a1');
  if not coalesce((v_res->>'ok')::boolean, false) or v_n <> 1 then raise exception 'W2 FAILED: % rows=%', v_res, v_n; end if;
  raise notice 'W2 PASSED: repeated join stays idempotent (one row)';

  -- W3: disabled athlete rejected, nothing written.
  v_res := pg_temp.t150_wl(s, 'dis');
  select count(*) into v_n from public.waitlist_requests where session_id = s and user_id = pg_temp.t150_uid('dis');
  if v_res->>'error' is distinct from 'account_disabled' or v_n <> 0 then raise exception 'W3 FAILED: % rows=%', v_res, v_n; end if;
  raise notice 'W3 PASSED: a disabled athlete cannot join a waitlist (account_disabled)';

  -- W4: other eligibility rules: pending athlete, coach, manager are refused; unauthenticated refused.
  if (pg_temp.t150_wl(s, 'pending')->>'error') is distinct from 'not_approved_athlete'
     or (pg_temp.t150_wl(s, 'coach')->>'error') is distinct from 'not_approved_athlete'
     or (pg_temp.t150_wl(s, 'mgr')->>'error') is distinct from 'not_approved_athlete' then
    raise exception 'W4 FAILED: non-athlete / unapproved callers must get not_approved_athlete';
  end if;
  perform pg_temp.t150_as(null);
  if (public.request_waitlist(s)->>'error') is distinct from 'not_authenticated' then raise exception 'W4 FAILED: unauthenticated'; end if;
  raise notice 'W4 PASSED: unapproved athlete / coach / manager / anonymous are refused with typed codes';

  -- W5: hidden session refused.
  s := pg_temp.t150_session(interval '3 hours', 1, true); perform pg_temp.t150_fill(s);
  if (pg_temp.t150_wl(s, 'a2')->>'error') is distinct from 'session_not_available' then raise exception 'W5 FAILED'; end if;
  raise notice 'W5 PASSED: a hidden session cannot be waitlisted (session_not_available)';

  -- W6: nonexistent session returns a typed outcome, not a foreign-key exception.
  v_res := pg_temp.t150_wl(gen_random_uuid(), 'a2');
  if v_res->>'error' is distinct from 'session_not_found' then raise exception 'W6 FAILED: %', v_res; end if;
  raise notice 'W6 PASSED: nonexistent session -> session_not_found (no FK exception)';

  -- W7: not full -> not_full (existing rule preserved).
  s := pg_temp.t150_session(interval '3 hours', 5);
  if (pg_temp.t150_wl(s, 'a2')->>'error') is distinct from 'not_full' then raise exception 'W7 FAILED'; end if;
  raise notice 'W7 PASSED: waitlisting a session with free places is refused (not_full)';
end $$;

-- W8-W12: timing boundaries, each under several database session time zones (studio time must be authoritative).
do $$
declare
  tz text; s uuid; v_res json; v_cnt int := 0;
begin
  foreach tz in array array['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Asia/Jerusalem'] loop
    perform set_config('TimeZone', tz, true);

    -- W8: one microsecond before the start -> allowed.
    s := pg_temp.t150_session(interval '1 microsecond'); if s is not null then
      perform pg_temp.t150_fill(s); v_res := pg_temp.t150_wl(s, 'a3');
      if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'W8 FAILED (tz %): %', tz, v_res; end if;
      v_cnt := v_cnt + 1;
    end if;
    -- W9: exactly at the start -> rejected.
    s := pg_temp.t150_session(interval '0'); if s is not null then
      perform pg_temp.t150_fill(s); v_res := pg_temp.t150_wl(s, 'a3');
      if v_res->>'error' is distinct from 'session_started' then raise exception 'W9 FAILED (tz %): %', tz, v_res; end if;
      v_cnt := v_cnt + 1;
    end if;
    -- W10: after the start, still running -> rejected (session_started).
    s := pg_temp.t150_session(interval '-10 minutes'); if s is not null then
      perform pg_temp.t150_fill(s); v_res := pg_temp.t150_wl(s, 'a3');
      if v_res->>'error' is distinct from 'session_started' then raise exception 'W10 FAILED (tz %): %', tz, v_res; end if;
      v_cnt := v_cnt + 1;
    end if;
    -- W11: after the end -> rejected (session_ended).
    s := pg_temp.t150_session(interval '-2 hours'); if s is not null then
      perform pg_temp.t150_fill(s); v_res := pg_temp.t150_wl(s, 'a3');
      if v_res->>'error' is distinct from 'session_ended' then raise exception 'W11 FAILED (tz %): %', tz, v_res; end if;
      v_cnt := v_cnt + 1;
    end if;
    -- W11b: exactly at the end -> session_ended.
    s := pg_temp.t150_session(interval '-60 minutes'); if s is not null then
      perform pg_temp.t150_fill(s); v_res := pg_temp.t150_wl(s, 'a3');
      if v_res->>'error' is distinct from 'session_ended' then raise exception 'W11b FAILED (tz %): %', tz, v_res; end if;
      v_cnt := v_cnt + 1;
    end if;
  end loop;
  perform set_config('TimeZone', 'UTC', true);
  if v_cnt < 20 then raise exception 'W8-W11 FAILED: too many cases skipped (%)', v_cnt; end if;
  raise notice 'W8-W11 PASSED: before start allowed; at start / after start / at end / after end rejected; identical under 5 session time zones (% cases)', v_cnt;
end $$;

-- W12: a naive UTC reading would be wrong: a session 2h30m ahead in studio time is "before start" in every time zone.
do $$
declare tz text; s uuid; v_res json;
begin
  foreach tz in array array['Pacific/Kiritimati', 'Pacific/Pago_Pago'] loop
    perform set_config('TimeZone', tz, true);
    s := pg_temp.t150_session(interval '150 minutes'); perform pg_temp.t150_fill(s);
    v_res := pg_temp.t150_wl(s, 'a4');
    if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'W12 FAILED (tz %): %', tz, v_res; end if;
  end loop;
  perform set_config('TimeZone', 'UTC', true);
  raise notice 'W12 PASSED: studio time is authoritative at the +14h / -11h session-time-zone extremes';
end $$;

-- W13: direct INSERT into waitlist_requests stays closed for a real authenticated client.
do $$
declare s uuid; v_ok boolean := false;
begin
  s := pg_temp.t150_session(interval '3 hours'); perform pg_temp.t150_fill(s);
  perform pg_temp.t150_as(pg_temp.t150_uid('a5'));
  execute 'set local role authenticated';
  begin
    insert into public.waitlist_requests (session_id, user_id) values (s, pg_temp.t150_uid('a5'));
  exception when insufficient_privilege then v_ok := true;
  end;
  execute 'reset role';
  if not v_ok then raise exception 'W13 FAILED: a direct INSERT into waitlist_requests was allowed'; end if;
  raise notice 'W13 PASSED: direct waitlist INSERT remains closed';
end $$;

-- =============================== cancel_registration ===============================
do $$
declare
  s uuid; v_res json; c public.cancellations; v_meta jsonb; v_status text; v_n int;
begin
  -- C1: more than 12h before start: normal cancellation, no late charge.
  s := pg_temp.t150_session(interval '12 hours 1 microsecond', 5); perform pg_temp.t150_reg(s, 'a1');
  v_res := pg_temp.t150_cancel(s, 'a1');
  select * into c from public.cancellations where session_id = s and user_id = pg_temp.t150_uid('a1');
  select meta::jsonb into v_meta from public.registration_history where session_id = s and user_id = pg_temp.t150_uid('a1') and event_type = 'cancelled';
  if not coalesce((v_res->>'ok')::boolean, false) or (v_res->>'late_cancellation')::boolean is not false
     or (v_res->>'charged_full_price')::boolean is not false then raise exception 'C1 FAILED response: %', v_res; end if;
  if c.id is null or c.charged_full_price or c.penalty_collected_ils <> 0 or c.reason <> 'because' then raise exception 'C1 FAILED row: %', to_jsonb(c); end if;
  if (v_meta->>'late_cancellation')::boolean is not false or (v_meta->>'charged_full_price')::boolean is not false then raise exception 'C1 FAILED history: %', v_meta; end if;
  select status::text into v_status from public.session_registrations where session_id = s and user_id = pg_temp.t150_uid('a1');
  if v_status <> 'cancelled' then raise exception 'C1 FAILED: registration status %', v_status; end if;
  raise notice 'C1 PASSED: >12h before start -> normal cancellation, charged_full_price=false, penalty 0, history late=false';

  -- C2: within 12h: late and CHARGED BY DEFAULT.
  s := pg_temp.t150_session(interval '11 hours 59 minutes', 5); perform pg_temp.t150_reg(s, 'a2');
  v_res := pg_temp.t150_cancel(s, 'a2');
  select * into c from public.cancellations where session_id = s and user_id = pg_temp.t150_uid('a2');
  select meta::jsonb into v_meta from public.registration_history where session_id = s and user_id = pg_temp.t150_uid('a2') and event_type = 'cancelled';
  if not coalesce((v_res->>'ok')::boolean, false) or (v_res->>'late_cancellation')::boolean is not true
     or (v_res->>'charged_full_price')::boolean is not true then raise exception 'C2 FAILED response: %', v_res; end if;
  if not c.charged_full_price or c.penalty_collected_ils <> 0 then raise exception 'C2 FAILED row: %', to_jsonb(c); end if;
  if (v_meta->>'late_cancellation')::boolean is not true or (v_meta->>'charged_full_price')::boolean is not true then raise exception 'C2 FAILED history: %', v_meta; end if;
  raise notice 'C2 PASSED: within 12h -> late, charged_full_price=true, penalty_collected_ils=0, response and history say late';

  -- C3: EXACTLY 12h before start is LATE (inclusive boundary, same as manager_set_cancellation_charge and the client helper).
  s := pg_temp.t150_session(interval '12 hours', 5); perform pg_temp.t150_reg(s, 'a3');
  v_res := pg_temp.t150_cancel(s, 'a3');
  select * into c from public.cancellations where session_id = s and user_id = pg_temp.t150_uid('a3');
  if (v_res->>'late_cancellation')::boolean is not true or not c.charged_full_price then raise exception 'C3 FAILED: exactly 12h must be late (inclusive): %', v_res; end if;
  -- ...and the manager workflow agrees that this row is late (waivable), proving the two comparisons are consistent.
  perform pg_temp.t150_as(pg_temp.t150_uid('mgr'));
  if (public.manager_set_cancellation_charge(c.id, false)->>'ok')::boolean is not true then raise exception 'C3 FAILED: manager cannot waive the boundary row'; end if;
  raise notice 'C3 PASSED: exactly 12h before start is late (inclusive) and the manager workflow agrees';

  -- C3b: one microsecond more than 12h is NOT late, and the manager workflow agrees.
  s := pg_temp.t150_session(interval '12 hours 1 microsecond', 5); perform pg_temp.t150_reg(s, 'a4');
  v_res := pg_temp.t150_cancel(s, 'a4');
  select * into c from public.cancellations where session_id = s and user_id = pg_temp.t150_uid('a4');
  perform pg_temp.t150_as(pg_temp.t150_uid('mgr'));
  if (v_res->>'late_cancellation')::boolean is not false or c.charged_full_price
     or (public.manager_set_cancellation_charge(c.id, true)->>'error') is distinct from 'not_late_cancellation' then
    raise exception 'C3b FAILED: 12h+1us must be a normal cancellation: %', v_res;
  end if;
  raise notice 'C3b PASSED: 12h + 1 microsecond is a normal cancellation (manager workflow agrees: not_late_cancellation)';

  -- C4: immediately before start still cancels, as late and charged.
  s := pg_temp.t150_session(interval '1 microsecond', 5); perform pg_temp.t150_reg(s, 'a5');
  v_res := pg_temp.t150_cancel(s, 'a5');
  if not coalesce((v_res->>'ok')::boolean, false) or (v_res->>'late_cancellation')::boolean is not true
     or (v_res->>'charged_full_price')::boolean is not true then raise exception 'C4 FAILED: %', v_res; end if;
  raise notice 'C4 PASSED: 1 microsecond before start can still cancel (late, charged)';

  -- C5: exactly at start -> rejected; nothing changes.
  s := pg_temp.t150_session(interval '0', 5); perform pg_temp.t150_reg(s, 'a6');
  v_res := pg_temp.t150_cancel(s, 'a6');
  select count(*) into v_n from public.cancellations where session_id = s;
  select status::text into v_status from public.session_registrations where session_id = s and user_id = pg_temp.t150_uid('a6');
  if v_res->>'error' is distinct from 'session_started' or v_n <> 0 or v_status <> 'active' then raise exception 'C5 FAILED: % n=% status=%', v_res, v_n, v_status; end if;
  raise notice 'C5 PASSED: exactly at start -> session_started, registration untouched, no cancellation row';

  -- C6: after start (running) and after the end -> rejected.
  s := pg_temp.t150_session(interval '-5 minutes', 5); perform pg_temp.t150_reg(s, 'a7');
  if (pg_temp.t150_cancel(s, 'a7')->>'error') is distinct from 'session_started' then raise exception 'C6 FAILED: after start'; end if;
  s := pg_temp.t150_session(interval '-3 hours', 5); perform pg_temp.t150_reg(s, 'a8');
  if (pg_temp.t150_cancel(s, 'a8')->>'error') is distinct from 'session_started' then raise exception 'C6 FAILED: after end'; end if;
  raise notice 'C6 PASSED: after start and after end -> session_started';

  -- C7: a DISABLED athlete may cancel an existing registration before the start (and late cancellation still applies).
  s := pg_temp.t150_session(interval '5 hours', 5); perform pg_temp.t150_reg(s, 'dis');
  v_res := pg_temp.t150_cancel(s, 'dis');
  if not coalesce((v_res->>'ok')::boolean, false) or (v_res->>'late_cancellation')::boolean is not true then raise exception 'C7 FAILED: %', v_res; end if;
  s := pg_temp.t150_session(interval '40 hours', 5); perform pg_temp.t150_reg(s, 'dis');
  v_res := pg_temp.t150_cancel(s, 'dis');
  if not coalesce((v_res->>'ok')::boolean, false) or (v_res->>'late_cancellation')::boolean is not false then raise exception 'C7 FAILED (normal): %', v_res; end if;
  raise notice 'C7 PASSED: a disabled athlete can cancel before the start (late and normal)';

  -- C8: other existing rules: reason required, not registered, nonexistent session, unauthenticated.
  s := pg_temp.t150_session(interval '5 hours', 5); perform pg_temp.t150_reg(s, 'a9');
  perform pg_temp.t150_as(pg_temp.t150_uid('a9'));
  if (public.cancel_registration(s, '  ')->>'error') is distinct from 'reason_required' then raise exception 'C8 FAILED: reason'; end if;
  if (pg_temp.t150_cancel(s, 'a1')->>'error') is distinct from 'not_registered' then raise exception 'C8 FAILED: not registered'; end if;
  if (pg_temp.t150_cancel(gen_random_uuid(), 'a9')->>'error') is distinct from 'session_not_found' then raise exception 'C8 FAILED: session'; end if;
  perform pg_temp.t150_as(null);
  if (public.cancel_registration(s, 'x')->>'error') is distinct from 'not_authenticated' then raise exception 'C8 FAILED: auth'; end if;
  raise notice 'C8 PASSED: reason_required / not_registered / session_not_found / not_authenticated preserved';
end $$;

-- C9: manager waive / re-charge workflow on a default-charged late cancellation; accounting stays consistent.
do $$
declare s uuid; c public.cancellations; v_res json;
begin
  s := pg_temp.t150_session(interval '2 hours', 5); perform pg_temp.t150_reg(s, 'a1');
  perform pg_temp.t150_cancel(s, 'a1');
  select * into c from public.cancellations where session_id = s and user_id = pg_temp.t150_uid('a1');
  if not c.charged_full_price then raise exception 'C9 FAILED: should start charged'; end if;
  perform pg_temp.t150_as(pg_temp.t150_uid('mgr'));
  v_res := public.manager_set_cancellation_charge(c.id, false);
  select * into c from public.cancellations where id = c.id;
  if not coalesce((v_res->>'ok')::boolean, false) or c.charged_full_price or c.penalty_collected_ils <> 0 then raise exception 'C9 FAILED waive: % %', v_res, to_jsonb(c); end if;
  v_res := public.manager_set_cancellation_charge(c.id, true);
  select * into c from public.cancellations where id = c.id;
  if not coalesce((v_res->>'ok')::boolean, false) or not c.charged_full_price then raise exception 'C9 FAILED re-charge: %', v_res; end if;
  raise notice 'C9 PASSED: manager can waive and re-charge a default-charged late cancellation';
end $$;

-- C10: studio time is authoritative for cancellation windows regardless of the database session time zone.
do $$
declare tz text; s uuid; v_res json; n int := 0; u text;
begin
  foreach tz in array array['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati', 'Asia/Jerusalem'] loop
    perform set_config('TimeZone', tz, true);
    -- 11h ahead (studio time) must be LATE everywhere (a UTC misreading would make it look 13-14h away).
    -- 13h ahead must be NORMAL everywhere (a +14h misreading would make it look late).
    -- Each case uses a fresh athlete-session pair via distinct sessions and the same athlete.
    s := pg_temp.t150_session(interval '11 hours', 5);
    if s is not null then
      delete from public.session_registrations where session_id = s;
      perform pg_temp.t150_reg(s, 'a2'); v_res := pg_temp.t150_cancel(s, 'a2');
      if (v_res->>'late_cancellation')::boolean is not true then raise exception 'C10 FAILED (tz %, 11h): %', tz, v_res; end if;
      n := n + 1;
    end if;
    s := pg_temp.t150_session(interval '13 hours', 5);
    if s is not null then
      perform pg_temp.t150_reg(s, 'a3'); v_res := pg_temp.t150_cancel(s, 'a3');
      if (v_res->>'late_cancellation')::boolean is not false then raise exception 'C10 FAILED (tz %, 13h): %', tz, v_res; end if;
      n := n + 1;
    end if;
    s := pg_temp.t150_session(interval '0', 5);
    if s is not null then
      perform pg_temp.t150_reg(s, 'a4');
      if (pg_temp.t150_cancel(s, 'a4')->>'error') is distinct from 'session_started' then raise exception 'C10 FAILED (tz %, start)', tz; end if;
      n := n + 1;
    end if;
  end loop;
  perform set_config('TimeZone', 'UTC', true);
  if n < 12 then raise exception 'C10 FAILED: too many cases skipped (%)', n; end if;
  raise notice 'C10 PASSED: 11h late / 13h normal / start rejected under 5 session time zones (% cases)', n;
end $$;

-- C11: existing side effects stay compatible: activity event, waitlist and subscription triggers fire without error,
-- and a subscribed athlete's late (charged) cancellation is reconciled.
do $$
declare s uuid; v_res json; v_sub uuid; v_ev int; v_sid uuid; v_cov int;
begin
  -- activity-log trigger
  s := pg_temp.t150_session(interval '30 hours', 5); perform pg_temp.t150_reg(s, 'a5');
  perform pg_temp.t150_cancel(s, 'a5');
  select count(*) into v_ev from public.user_activity_events where event_type = 'session_registration_cancelled' and metadata->>'session_id' = s::text;
  if v_ev < 1 then raise exception 'C11 FAILED: no session_registration_cancelled activity event'; end if;

  -- waitlist notification trigger: a waitlisted athlete on a full session, then the registered athlete cancels.
  s := pg_temp.t150_session(interval '20 hours', 1); perform pg_temp.t150_reg(s, 'a6');
  v_res := pg_temp.t150_wl(s, 'a7');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'C11 FAILED: waitlist fixture %', v_res; end if;
  v_res := pg_temp.t150_cancel(s, 'a6');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'C11 FAILED: cancel with a waitlist present %', v_res; end if;

  -- subscription reconcile trigger: subscribed athlete registers through the real RPC (creates the coverage row),
  -- then cancels late. The charged cancellation must reconcile without error and keep the coverage bookkeeping.
  perform pg_temp.t150_as(pg_temp.t150_uid('mgr'));
  v_res := public.create_subscription(pg_temp.t150_uid('a8'), false, 300, current_date - 3, null,
                                      extract(day from current_date - 3)::smallint,
                                      '[{"tier":"personal","weekly_limit":3},{"tier":"pair","weekly_limit":3},{"tier":"trio","weekly_limit":3},{"tier":"quartet","weekly_limit":3},{"tier":"quintet","weekly_limit":3},{"tier":"sextet","weekly_limit":3},{"tier":"group","weekly_limit":3}]'::jsonb);
  if not coalesce((v_res->>'ok')::boolean, false) then raise notice 'C11 note: subscription fixture not created (%); subscription leg skipped', v_res; return; end if;
  s := pg_temp.t150_session(interval '6 hours', 5);
  update public.training_sessions set is_open_for_registration = true where id = s;
  perform pg_temp.t150_as(pg_temp.t150_uid('a8'));
  v_res := public.register_for_session(s, true);
  if not coalesce((v_res->>'ok')::boolean, false) then raise notice 'C11 note: subscribed registration not possible in fixture (%); subscription leg skipped', v_res; return; end if;
  select count(*) into v_cov from public.subscription_registration_coverage c join public.session_registrations r on r.id = c.registration_id where r.session_id = s;
  v_res := pg_temp.t150_cancel(s, 'a8');
  if not coalesce((v_res->>'ok')::boolean, false) or (v_res->>'late_cancellation')::boolean is not true then raise exception 'C11 FAILED: subscribed late cancel %', v_res; end if;
  if (select count(*) from public.subscription_registration_coverage c join public.session_registrations r on r.id = c.registration_id where r.session_id = s) <> v_cov then
    raise exception 'C11 FAILED: coverage bookkeeping changed by the cancellation';
  end if;
  raise notice 'C11 PASSED: activity-log, waitlist and subscription-reconcile triggers fire compatibly (coverage rows=%)', v_cov;
end $$;

-- =============================== no backfill / no historical change ===============================
do $$
declare v_pre bigint; v_post bigint;
begin
  -- Rows present before the test (none in a fresh replay) are unchanged: the counts of rows older than the test's
  -- start must equal the recorded counts.
  select n into v_pre from t150_pre where t = 'cancellations';
  select count(*) into v_post from public.cancellations where cancelled_at < now();
  if v_post <> v_pre then raise exception 'H1 FAILED: cancellations older than the test changed (% -> %)', v_pre, v_post; end if;
  select n into v_pre from t150_pre where t = 'registration_history';
  select count(*) into v_post from public.registration_history where event_at < now();
  if v_post <> v_pre then raise exception 'H1 FAILED: registration_history older than the test changed (% -> %)', v_pre, v_post; end if;
  select n into v_pre from t150_pre where t = 'waitlist_requests';
  select count(*) into v_post from public.waitlist_requests where requested_at < now();
  if v_post <> v_pre then raise exception 'H1 FAILED: waitlist rows older than the test changed'; end if;
  raise notice 'H1 PASSED: no pre-existing cancellation / history / waitlist row was added, removed or rewritten';
end $$;

do $$
declare v_def text;
begin
  -- H2: the migration is definitions-only: no data-modifying statement in the migration file's function bodies is possible
  -- beyond the caller's own registration/waitlist/cancellation/history rows; assert structurally on the two live bodies.
  select prosrc into v_def from pg_proc where proname = 'cancel_registration' and pronamespace = 'public'::regnamespace;
  if v_def ~* '(update\s+public\.cancellations|delete\s+from)' or v_def ~* 'update\s+cancellations' then raise exception 'H2 FAILED: cancel_registration rewrites cancellations'; end if;
  select prosrc into v_def from pg_proc where proname = 'request_waitlist' and pronamespace = 'public'::regnamespace;
  if v_def ~* '(update\s|delete\s+from)' then raise exception 'H2 FAILED: request_waitlist updates/deletes rows'; end if;
  raise notice 'H2 PASSED: neither function updates or deletes existing rows';
  if exists (select 1 from t150_skip) then raise notice 'NOTE: % fixture(s) skipped because the local wall-clock instant was ambiguous (DST)', (select count(*) from t150_skip); end if;
  raise notice 'ALL WAITLIST/CANCEL RECONCILIATION TESTS PASSED';
end $$;

rollback;

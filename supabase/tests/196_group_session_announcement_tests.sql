-- Task 1: manager_announce_group_session -- manager-only, idempotent, group-only, bookable-only
-- optional Hebrew push announcement for a newly created group session.
set client_min_messages to notice;

do $$
declare
  v_mgr uuid := gen_random_uuid();
  v_coach uuid := gen_random_uuid();
  v_ath1 uuid := gen_random_uuid();
  v_ath2 uuid := gen_random_uuid();
  v_ath_pending uuid := gen_random_uuid();
  v_ath_disabled uuid := gen_random_uuid();
  v_group_sess uuid;
  v_pair_sess uuid;
  v_hidden_sess uuid;
  v_not_open_sess uuid;
  v_series_id uuid := gen_random_uuid();
  v_series_sess uuid;
  v_sun date := current_date - extract(dow from current_date)::int + 14;
  v_res json;
  v_count int;
begin
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status, disabled_at, expo_push_token, gender) values
    (v_mgr, 'ann_mgr', 'Ann Manager', '9601', 'manager', 'approved', null, null, 'female'),
    (v_coach, 'ann_coach', 'Ann Coach', '9602', 'coach', 'approved', null, null, 'female'),
    (v_ath1, 'ann_ath1', 'Ann Athlete One', '9604', 'athlete', 'approved', null, 'ExponentPushToken[ann1]', 'male'),
    (v_ath2, 'ann_ath2', 'Ann Athlete Two', '9605', 'athlete', 'approved', null, 'ExponentPushToken[ann2]', 'female'),
    (v_ath_pending, 'ann_ath_pending', 'Ann Pending', '9606', 'athlete', 'pending', null, 'ExponentPushToken[pending]', 'male'),
    (v_ath_disabled, 'ann_ath_disabled', 'Ann Disabled', '9607', 'athlete', 'approved', now(), 'ExponentPushToken[disabled]', 'male');

  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, is_hidden)
  values
    (gen_random_uuid(), v_sun, '18:00', v_coach, 10, true, false),
    (gen_random_uuid(), v_sun, '19:00', v_coach, 2, true, false),
    (gen_random_uuid(), v_sun, '20:00', v_coach, 10, true, true),
    (gen_random_uuid(), v_sun, '21:00', v_coach, 10, false, false);

  select id into v_group_sess from public.training_sessions where coach_id = v_coach and start_time = '18:00' and session_date = v_sun;
  select id into v_pair_sess from public.training_sessions where coach_id = v_coach and start_time = '19:00' and session_date = v_sun;
  select id into v_hidden_sess from public.training_sessions where coach_id = v_coach and start_time = '20:00' and session_date = v_sun;
  select id into v_not_open_sess from public.training_sessions where coach_id = v_coach and start_time = '21:00' and session_date = v_sun;

  -- A group, visible, open-for-registration occurrence that belongs to a weekly series -- must be
  -- treated as not-bookable for this one-shot announcement too (Task 2 server-side guard,
  -- 20261028120000_group_session_announcement_series_guard.sql).
  insert into public.session_series (id, coach_id, anchor_date, start_time, max_participants, is_open_for_registration, is_hidden, repeat_mode)
  values (v_series_id, v_coach, v_sun, '22:00', 10, true, false, 'ongoing');
  insert into public.training_sessions (id, session_date, start_time, coach_id, max_participants, is_open_for_registration, is_hidden, series_id)
  values (gen_random_uuid(), v_sun, '22:00', v_coach, 10, true, false, v_series_id);
  select id into v_series_sess from public.training_sessions where coach_id = v_coach and start_time = '22:00' and session_date = v_sun;

  -- === A: non-manager (coach) is forbidden, nothing dispatched ===
  perform set_config('app.current_uid', v_coach::text, true);
  v_res := public.manager_announce_group_session(v_group_sess);
  if (v_res->>'ok')::boolean is distinct from false or v_res->>'error' <> 'forbidden' then
    raise exception 'A FAILED: expected forbidden, got %', v_res;
  end if;
  select count(*) into v_count from public.group_session_announcements where session_id = v_group_sess;
  if v_count <> 0 then raise exception 'A FAILED: non-manager call must not write a dedupe row'; end if;
  raise notice 'A PASSED: non-manager caller is forbidden';

  perform set_config('app.current_uid', v_mgr::text, true);

  -- === B: non-group (pair) session is a no-op ===
  v_res := public.manager_announce_group_session(v_pair_sess);
  if (v_res->>'ok')::boolean is distinct from false or v_res->>'error' <> 'not_group' then
    raise exception 'B FAILED: expected not_group, got %', v_res;
  end if;
  select count(*) into v_count from public.group_session_announcements where session_id = v_pair_sess;
  if v_count <> 0 then raise exception 'B FAILED: non-group no-op must not write a dedupe row'; end if;
  raise notice 'B PASSED: non-group session is a no-op';

  -- === C: hidden group session is a no-op ===
  v_res := public.manager_announce_group_session(v_hidden_sess);
  if (v_res->>'ok')::boolean is distinct from false or v_res->>'error' <> 'not_bookable' then
    raise exception 'C FAILED: expected not_bookable (hidden), got %', v_res;
  end if;
  raise notice 'C PASSED: hidden group session is a no-op';

  -- === D: not-open-for-registration group session is a no-op ===
  v_res := public.manager_announce_group_session(v_not_open_sess);
  if (v_res->>'ok')::boolean is distinct from false or v_res->>'error' <> 'not_bookable' then
    raise exception 'D FAILED: expected not_bookable (not open), got %', v_res;
  end if;
  raise notice 'D PASSED: not-open-for-registration group session is a no-op';

  -- === D2: a group, visible, open session that is part of a weekly series is a no-op -- the
  --         client only ever arms this for a single/non-recurring session, and the server must
  --         refuse it too even if a client bug or a direct RPC call submits a series occurrence ===
  v_res := public.manager_announce_group_session(v_series_sess);
  if (v_res->>'ok')::boolean is distinct from false or v_res->>'error' <> 'not_bookable' then
    raise exception 'D2 FAILED: expected not_bookable (series occurrence), got %', v_res;
  end if;
  select count(*) into v_count from public.group_session_announcements where session_id = v_series_sess;
  if v_count <> 0 then raise exception 'D2 FAILED: series-occurrence no-op must not write a dedupe row'; end if;
  raise notice 'D2 PASSED: recurring-series occurrence is a no-op';

  -- === E: a bookable group session dispatches to every eligible athlete, excluding
  --        pending-approval and disabled athletes, and records recipients_notified ===
  v_res := public.manager_announce_group_session(v_group_sess);
  if (v_res->>'ok')::boolean is distinct from true then
    raise exception 'E FAILED: expected ok=true, got %', v_res;
  end if;
  if (v_res->>'recipients_notified')::int <> 2 then
    raise exception 'E FAILED: expected 2 eligible recipients (ath1, ath2), got %', v_res;
  end if;
  select recipients_notified into v_count from public.group_session_announcements where session_id = v_group_sess;
  if v_count <> 2 then raise exception 'E FAILED: dedupe row recipients_notified mismatch, got %', v_count; end if;
  raise notice 'E PASSED: bookable group session dispatches to exactly the eligible athletes';

  -- === F: calling it again (retry/duplicate request) is idempotent -- no second dispatch ===
  v_res := public.manager_announce_group_session(v_group_sess);
  if (v_res->>'ok')::boolean is distinct from true or (v_res->>'already_sent')::boolean is distinct from true then
    raise exception 'F FAILED: expected ok=true, already_sent=true on retry, got %', v_res;
  end if;
  select count(*) into v_count from public.group_session_announcements where session_id = v_group_sess;
  if v_count <> 1 then raise exception 'F FAILED: retry must not create a second dedupe row, got count=%', v_count; end if;
  raise notice 'F PASSED: duplicate/retry call is idempotent';

  -- === G: unknown session id returns not_found ===
  v_res := public.manager_announce_group_session(gen_random_uuid());
  if (v_res->>'ok')::boolean is distinct from false or v_res->>'error' <> 'not_found' then
    raise exception 'G FAILED: expected not_found, got %', v_res;
  end if;
  raise notice 'G PASSED: unknown session id returns not_found';
end $$;

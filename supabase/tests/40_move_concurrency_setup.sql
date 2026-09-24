set client_min_messages to notice;

-- Concurrency setup: athlete H has a pair-tier subscription, weekly_limit=1, currently used by
-- one covered registration at session W. Two concurrent operations race against each other for
-- the SAME subscription's SAME tier/week allowance pool:
--   (A) staff moves H from W to session Y (release W's slot, then re-claim at Y) — since a move's
--       release-then-reclaim is atomic within its own transaction, it is structurally
--       self-consistent and will complete successfully regardless of ordering relative to (B).
--   (B) H (independently, e.g. via the app) tries to freshly register for session Z — a second,
--       unrelated claim on the SAME payee/tier/week pool that has no slot to draw on unless (A)'s
--       release happens to free one, which it never durably does (the freed slot is immediately
--       re-claimed by the move in the same transaction).
-- Both call subscription_reserve_or_reject, which takes the same subscription_lock_key for this
-- payee/week/tier regardless of which RPC calls it — the property under test is that Z can never
-- observe a stale/incorrect count that lets it ALSO become covered while the move is in flight
-- (which would double-book the single allowance slot); the deterministic "the move always wins"
-- outcome is expected and correct (a move's own release+reclaim is inherently self-consistent),
-- not a 50/50 coin flip — the coin-flip case (two independent fresh registrations) is already
-- covered by the original Phase 1/2 concurrency test.
drop table if exists _move_conc_ids;
create table _move_conc_ids (k text primary key, v uuid);

do $$
declare
  v_coach uuid; v_manager uuid; v_h uuid; v_sub uuid; v_ver uuid;
  v_week_sun date; v_w uuid; v_y uuid; v_z uuid; v_res json;
begin
  select v into v_coach from _move_ids where k='coach';
  select v into v_manager from _move_ids where k='manager';

  v_h := gen_random_uuid();
  insert into public.profiles (user_id, username, full_name, phone, role, approval_status)
  values (v_h, 'athlete_h', 'Athlete H', '0500000201', 'athlete', 'approved');

  v_week_sun := (current_date + 100) - extract(dow from (current_date + 100))::int;

  insert into public.subscriptions (payee_id, payee_is_manual) values (v_h, false) returning id into v_sub;
  insert into public.subscription_versions (subscription_id, version_no, effective_from, monthly_price_ils, anchor_day, plan_start_date)
  values (v_sub, 1, v_week_sun - 10, 300, 1, v_week_sun - 10) returning id into v_ver;
  insert into public.subscription_version_allowances (version_id, tier, weekly_limit) values (v_ver, 'pair', 1);

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 1, '09:00', v_coach, 2) returning id into v_w; -- H's source, pair
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 2, '09:00', v_coach, 2) returning id into v_y; -- move destination, pair
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants)
  values (v_week_sun + 3, '09:00', v_coach, 2) returning id into v_z; -- competing fresh-registration target, pair

  perform set_config('app.current_uid', v_h::text, true);
  v_res := public.register_for_session(v_w);
  if coalesce((v_res->>'ok')::boolean,false) is not true then
    raise exception 'concurrency setup FAILED: %', v_res;
  end if;

  insert into _move_conc_ids values
    ('manager', v_manager), ('h', v_h), ('w', v_w), ('y', v_y), ('z', v_z);
end $$;

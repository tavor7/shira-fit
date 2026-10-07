-- Reconcile request_waitlist(uuid) and cancel_registration(uuid, text) with the approved product rules.
--
-- WHY: production was found running the ORIGINAL 20250314000000_initial.sql bodies of these two functions.
-- The initial migration (functions, policies, triggers) was re-executed against production on the night of
-- 2026-06-10/11 and nothing afterwards redefined these two functions, silently undoing
-- 20260408120000 / 20260531120000 / 20260628230000. The initial cancel_registration also read the session start
-- in the database session's time zone (UTC) instead of the studio's, which shifted the late-cancel window by 2-3 hours.
--
-- This is NOT a copy of either previous definition. It encodes the product rules decided after the investigation:
--
--   request_waitlist
--     * only an approved, ENABLED athlete may join; a disabled athlete is rejected (account_disabled)
--     * a nonexistent session returns session_not_found (the old body fell through to a foreign-key exception)
--     * a hidden session is not available (session_not_available)
--     * only BEFORE the session starts: at or after the studio-local start -> session_started
--       (after the end -> session_ended, which takes precedence); Asia/Jerusalem is authoritative
--     * waitlisting is still only for a full session (not_full); joining twice stays idempotent
--
--   cancel_registration
--     * late-cancellation threshold: exactly 12 hours before the studio-local start, INCLUSIVE:
--         start - now() > 12h         -> normal cancellation, no charge
--         0 < start - now() <= 12h    -> late; CHARGED BY DEFAULT (charged_full_price = true), management may waive it
--                                        afterwards through manager_set_cancellation_charge (unchanged)
--         now() >= start              -> athlete self-cancellation rejected (session_started)
--       The inclusive boundary matches manager_set_cancellation_charge ((start - cancelled_at) <= interval '12 hours')
--       and the client helper isCancellationWithinHoursBeforeSession (<=), so a row this function marks late can
--       always be waived by the manager.
--     * accounting model unchanged: charged_full_price = the fee applies; penalty_collected_ils = 0 (nothing
--       collected yet; only the manager records collection)
--     * the response and the registration_history meta carry late_cancellation + charged_full_price
--     * a disabled athlete MAY still cancel before the session starts (no account check by design)
--
-- FORWARD-ONLY, DEFINITIONS ONLY. No table, index, trigger, policy, grant or ACL is changed, and no row of any
-- table is read-modified: there is no INSERT/UPDATE/DELETE/backfill in this file. Existing cancellations (including
-- those already marked charged), registrations, history and waitlist rows are untouched. CREATE OR REPLACE keeps the
-- existing function ACLs exactly as they are.

create or replace function public.request_waitlist(p_session_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile profiles%rowtype;
  v_sess training_sessions%rowtype;
  v_start timestamptz;
  v_end timestamptz;
  v_count int;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;

  select * into v_profile from profiles where user_id = v_uid;
  if not found then return json_build_object('ok', false, 'error', 'not_approved_athlete'); end if;
  if v_profile.disabled_at is not null then
    return json_build_object('ok', false, 'error', 'account_disabled');
  end if;
  if v_profile.approval_status <> 'approved' or v_profile.role <> 'athlete' then
    return json_build_object('ok', false, 'error', 'not_approved_athlete');
  end if;

  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  -- Studio-local wall-clock start/end, independent of the database or connection time zone.
  v_start := ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp at time zone 'Asia/Jerusalem');
  v_end := v_start + make_interval(mins => coalesce(v_sess.duration_minutes, 60));
  if now() >= v_end then
    return json_build_object('ok', false, 'error', 'session_ended');
  end if;
  if now() >= v_start then
    return json_build_object('ok', false, 'error', 'session_started');
  end if;

  if coalesce(v_sess.is_hidden, false) then
    return json_build_object('ok', false, 'error', 'session_not_available');
  end if;

  v_count := public.active_registration_count(p_session_id);
  if v_count < v_sess.max_participants then
    return json_build_object('ok', false, 'error', 'not_full');
  end if;

  insert into waitlist_requests (session_id, user_id) values (p_session_id, v_uid)
  on conflict (session_id, user_id) do nothing;
  return json_build_object('ok', true);
end;
$$;

create or replace function public.cancel_registration(p_session_id uuid, p_reason text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sess training_sessions%rowtype;
  v_start timestamptz;
  v_late boolean;
begin
  if v_uid is null then return json_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if p_reason is null or length(trim(p_reason)) < 1 then
    return json_build_object('ok', false, 'error', 'reason_required');
  end if;

  select * into v_sess from training_sessions where id = p_session_id;
  if not found then return json_build_object('ok', false, 'error', 'session_not_found'); end if;

  -- Studio-local wall-clock start, independent of the database or connection time zone.
  v_start := ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp at time zone 'Asia/Jerusalem');

  -- Athlete self-cancellation is not allowed at or after the session start.
  if now() >= v_start then
    return json_build_object('ok', false, 'error', 'session_started');
  end if;

  if not exists (
    select 1 from session_registrations r
    where r.session_id = p_session_id and r.user_id = v_uid and r.status = 'active'
  ) then
    return json_build_object('ok', false, 'error', 'not_registered');
  end if;

  -- Late = 12 hours or less before the start (inclusive boundary); the start itself was rejected above.
  v_late := (now() >= v_start - interval '12 hours');

  update session_registrations
  set status = 'cancelled'
  where session_id = p_session_id and user_id = v_uid and status = 'active';
  if not found then return json_build_object('ok', false, 'error', 'update_failed'); end if;

  -- Late cancellations are charged by default (the manager may waive afterwards); nothing is collected yet.
  insert into cancellations (session_id, user_id, reason, charged_full_price, penalty_collected_ils)
  values (p_session_id, v_uid, p_reason, v_late, 0);

  insert into registration_history (session_id, user_id, event_type, meta)
  values (
    p_session_id,
    v_uid,
    'cancelled',
    json_build_object('late_cancellation', v_late, 'charged_full_price', v_late)
  );

  return json_build_object('ok', true, 'late_cancellation', v_late, 'charged_full_price', v_late);
end;
$$;

-- Self-check: both functions exist exactly once with the expected signature, definer security and pinned search_path.
do $$
declare
  v_fn text;
  v_n integer;
begin
  foreach v_fn in array array['request_waitlist', 'cancel_registration'] loop
    select count(*) into v_n from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = v_fn and p.prosecdef
      and p.proconfig @> array['search_path=public'];
    if v_n <> 1 then
      raise exception 'self-check: expected exactly one SECURITY DEFINER public.% with search_path=public, found %', v_fn, v_n;
    end if;
  end loop;
  if pg_get_function_identity_arguments('public.request_waitlist(uuid)'::regprocedure) <> 'p_session_id uuid'
     or pg_get_function_identity_arguments('public.cancel_registration(uuid, text)'::regprocedure) <> 'p_session_id uuid, p_reason text' then
    raise exception 'self-check: unexpected function signature';
  end if;
end $$;

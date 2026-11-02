-- Waitlist notification eligibility: which sessions may be announced and who is first in line. Nothing here touches
-- waitlist order or registration. Rolls back. LOCAL stack only.
\set ON_ERROR_STOP 1
begin;
do $$
declare
  v_coach uuid := gen_random_uuid();
  v_disabled uuid := gen_random_uuid();
  v_registered uuid := gen_random_uuid();
  v_eligible uuid := gen_random_uuid();
  v_later uuid := gen_random_uuid();
  v_ok uuid; v_hidden uuid; v_closed uuid; v_started uuid;
  v_future date := current_date + 3;
  u uuid;
begin
  foreach u in array array[v_coach, v_disabled, v_registered, v_eligible, v_later] loop
    insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
    values (u, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 't206-' || u || '@t.local', now(), now());
    update public.profiles set approval_status = 'approved', role = 'athlete' where user_id = u;
  end loop;
  update public.profiles set role = 'coach' where user_id = v_coach;
  update public.profiles set disabled_at = now() where user_id = v_disabled;

  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (v_future, '10:00', v_coach, 8, true) returning id into v_ok;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration, is_hidden)
  values (v_future, '11:00', v_coach, 8, true, true) returning id into v_hidden;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (v_future, '12:00', v_coach, 8, false) returning id into v_closed;
  insert into public.training_sessions (session_date, start_time, coach_id, max_participants, is_open_for_registration)
  values (current_date - 1, '12:00', v_coach, 8, true) returning id into v_started;

  if public._waitlist_notify_skip_reason(v_ok) is not null then raise exception 'A FAILED: open future session must be announced'; end if;
  if public._waitlist_notify_skip_reason(v_hidden) is distinct from 'session_hidden' then raise exception 'B FAILED: hidden'; end if;
  if public._waitlist_notify_skip_reason(v_closed) is distinct from 'registration_closed' then raise exception 'C FAILED: closed'; end if;
  if public._waitlist_notify_skip_reason(v_started) is distinct from 'session_started' then raise exception 'D FAILED: started'; end if;
  if public._waitlist_notify_skip_reason(gen_random_uuid()) is distinct from 'session_not_found' then raise exception 'E FAILED: missing'; end if;
  raise notice 'session checks PASSED';

  insert into public.waitlist_requests (session_id, user_id, requested_at) values
    (v_ok, v_disabled, now() - interval '4 hours'),
    (v_ok, v_registered, now() - interval '3 hours'),
    (v_ok, v_eligible, now() - interval '2 hours'),
    (v_ok, v_later, now() - interval '1 hour');
  insert into public.session_registrations (session_id, user_id, status) values (v_ok, v_registered, 'active');

  if public._waitlist_first_eligible_user(v_ok) is distinct from v_eligible then
    raise exception 'F FAILED: disabled and already registered people must be passed over, earliest eligible wins';
  end if;
  delete from public.waitlist_requests where session_id = v_ok and user_id = v_eligible;
  if public._waitlist_first_eligible_user(v_ok) is distinct from v_later then raise exception 'G FAILED: FIFO must hold among the rest'; end if;
  raise notice 'first in line PASSED';

  if (select count(*) from public.waitlist_requests where session_id = v_ok) <> 3 then raise exception 'H FAILED: no waitlist row may be removed'; end if;
  raise notice 'waitlist rows untouched PASSED';

  if has_function_privilege('authenticated', 'public._waitlist_notify_skip_reason(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public._waitlist_first_eligible_user(uuid)', 'execute')
     or has_function_privilege('anon', 'public._waitlist_first_eligible_user(uuid)', 'execute') then
    raise exception 'I FAILED: helpers must not be callable by clients';
  end if;
  if not has_function_privilege('service_role', 'public._waitlist_first_eligible_user(uuid)', 'execute') then
    raise exception 'J FAILED: notify-waitlist runs as service_role and must be able to call it';
  end if;
  raise notice 'privileges PASSED';
end $$;
rollback;

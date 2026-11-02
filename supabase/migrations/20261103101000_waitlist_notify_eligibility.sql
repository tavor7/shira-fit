-- Waitlist "spot opened" notifications: stop telling people about a session they cannot register for.
--
-- notify-waitlist and maybe_enqueue_whatsapp_waitlist only checked that the session had space. So a removal after the
-- session had started, or from a hidden or closed session, still went out, and the person first in line could be someone
-- whose account is disabled or who is already registered, in which case nobody eligible heard anything.
--
-- These checks only decide whether the existing message goes out and to whom. Waitlist order is unchanged, nothing is
-- reserved, and registration is untouched.

-- Null means the session may be announced.
create or replace function public._waitlist_notify_skip_reason(p_session_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_sess public.training_sessions%rowtype;
  v_start timestamptz;
begin
  select * into v_sess from public.training_sessions where id = p_session_id;
  if not found then return 'session_not_found'; end if;
  if coalesce(v_sess.is_hidden, false) then return 'session_hidden'; end if;
  if not coalesce(v_sess.is_open_for_registration, false) then return 'registration_closed'; end if;
  v_start := ((v_sess.session_date + coalesce(v_sess.start_time, time '00:00'))::timestamp at time zone 'Asia/Jerusalem');
  if now() >= v_start then return 'session_started'; end if;
  return null;
end;
$function$;

-- First in line (FIFO by requested_at, as before) among people who could actually register.
create or replace function public._waitlist_first_eligible_user(p_session_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select w.user_id
  from public.waitlist_requests w
  join public.profiles p on p.user_id = w.user_id
  where w.session_id = p_session_id
    and p.role = 'athlete'
    and p.approval_status = 'approved'
    and p.disabled_at is null
    and not exists (
      select 1 from public.session_registrations r
      where r.session_id = p_session_id and r.user_id = w.user_id and r.status = 'active'
    )
  order by w.requested_at asc
  limit 1;
$function$;

revoke all on function public._waitlist_notify_skip_reason(uuid) from public, anon, authenticated;
revoke all on function public._waitlist_first_eligible_user(uuid) from public, anon, authenticated;
grant execute on function public._waitlist_notify_skip_reason(uuid) to service_role;
grant execute on function public._waitlist_first_eligible_user(uuid) to service_role;

create or replace function public.maybe_enqueue_whatsapp_waitlist(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sess record;
  v_filled int;
  v_first uuid;
  v_dedupe text;
  v_delivery_id uuid;
begin
  if p_session_id is null or public._whatsapp_rollout_mode() = 'off' then
    return;
  end if;

  select s.id, s.max_participants, s.session_date, s.start_time
  into v_sess
  from public.training_sessions s
  where s.id = p_session_id;

  if not found then
    return;
  end if;

  if public._waitlist_notify_skip_reason(p_session_id) is not null then
    return;
  end if;

  select count(*)::int into v_filled
  from (
    select 1 from public.session_registrations r
    where r.session_id = p_session_id and r.status = 'active'
    union all
    select 1 from public.session_manual_participants m
    where m.session_id = p_session_id
  ) x;

  if v_filled >= v_sess.max_participants then
    return;
  end if;

  v_first := public._waitlist_first_eligible_user(p_session_id);

  if v_first is null then
    return;
  end if;

  v_dedupe := 'waitlist:' || p_session_id::text || ':' || v_first::text || ':'
    || to_char(now() at time zone 'Asia/Jerusalem', 'YYYYMMDDHH24MI');

  v_delivery_id := public.enqueue_whatsapp_notification(
    v_first,
    'waitlist_spot',
    v_dedupe,
    jsonb_build_object(
      'session_id', p_session_id,
      'session_date', v_sess.session_date,
      'start_time', to_char(v_sess.start_time, 'HH24:MI'),
      'template', 'waitlist_spot'
    )
  );

  if v_delivery_id is not null then
    perform public.invoke_dispatch_notifications_edge();
  end if;
end;
$function$;

-- Waitlist "spot opened" notifications: tell the first person in line once per opening, not on every departure.
--
-- The triggers called notify-waitlist and the WhatsApp path on every cancellation or removal. While a session stayed
-- available, each further departure notified the same person again. They now fire only when the session goes from full
-- to available: occupancy after the departure is exactly one below capacity. A later full -> available change is a new
-- opening and notifies again.
--
-- The per-session advisory lock (the same key as the manager and availability checks, independent of them) makes
-- concurrent departures count one at a time. The new block also keeps a failure here from blocking the cancellation.
-- Who is first in line, waitlist rows, what registration does and the message itself are all unchanged. Nothing is reserved.

create or replace function public._waitlist_departure_opened_spot(p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_max integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('shira.session_occupancy:' || p_session_id::text, 0));
  select max_participants into v_max from public.training_sessions where id = p_session_id;
  if not found then
    return false;
  end if;
  return public.active_registration_count(p_session_id) = v_max - 1;
end;
$function$;

revoke all on function public._waitlist_departure_opened_spot(uuid) from public, anon, authenticated;

create or replace function public.tg_notify_waitlist_session_registration_cancelled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    if not public._waitlist_departure_opened_spot(new.session_id) then
      return new;
    end if;
    perform public.invoke_notify_waitlist_edge(new.session_id);
  exception when others then
    raise warning 'waitlist notify: opening check failed (sqlstate %)', sqlstate;
    return new;
  end;
  begin
    perform public.maybe_enqueue_whatsapp_waitlist(new.session_id);
  exception when others then
    null;
  end;
  return new;
end;
$function$;

create or replace function public.tg_notify_waitlist_manual_participant_removed()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    -- A quick-add row linked to an athlete with an active registration never held a seat of its own.
    if exists (
      select 1
      from public.manual_participants mp
      join public.session_registrations r on r.user_id = mp.linked_user_id and r.session_id = old.session_id and r.status = 'active'
      where mp.id = old.manual_participant_id
    ) or not public._waitlist_departure_opened_spot(old.session_id) then
      return old;
    end if;
    perform public.invoke_notify_waitlist_edge(old.session_id);
  exception when others then
    raise warning 'waitlist notify: opening check failed (sqlstate %)', sqlstate;
    return old;
  end;
  begin
    perform public.maybe_enqueue_whatsapp_waitlist(old.session_id);
  exception when others then
    null;
  end;
  return old;
end;
$function$;

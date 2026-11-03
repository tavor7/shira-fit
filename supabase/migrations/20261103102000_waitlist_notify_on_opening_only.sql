-- Waitlist "spot opened" notifications: tell the person at the head of the line once per opening, and tell the next person
-- if the head leaves the line while a place is still free. Builds on _waitlist_notify_skip_reason and
-- _waitlist_first_eligible_user (20261103101000).
--
-- The triggers called notify-waitlist and the WhatsApp path on every cancellation or removal, so while a session stayed
-- available each further departure notified the same person again. They now record an opening only when a session goes
-- from full to available (occupancy is exactly one below capacity), and a later full -> available change is a new opening.
--
-- The per-session advisory lock (same key as the manager and availability checks) makes concurrent changes count one at a
-- time. A failure here never blocks the cancellation, removal or waitlist change that caused it.
-- Who is first in line, what registration does and the message are unchanged. Nothing is reserved and nobody waits.

create table public.session_waitlist_openings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.training_sessions (id) on delete cascade,
  opened_at timestamptz not null default now()
);
create index session_waitlist_openings_session_idx on public.session_waitlist_openings (session_id, opened_at desc);

create table public.session_waitlist_notices (
  opening_id uuid not null references public.session_waitlist_openings (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  notified_at timestamptz not null default now(),
  primary key (opening_id, user_id)
);
create index session_waitlist_notices_user_idx on public.session_waitlist_notices (user_id);

-- Internal bookkeeping: no client access.
alter table public.session_waitlist_openings enable row level security;
alter table public.session_waitlist_notices enable row level security;
revoke all on public.session_waitlist_openings from anon, authenticated;
revoke all on public.session_waitlist_notices from anon, authenticated;

create or replace function public._waitlist_lock_session(p_session_id uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  select pg_advisory_xact_lock(hashtextextended('shira.session_occupancy:' || p_session_id::text, 0));
$function$;

create or replace function public._waitlist_recipient_already_told(p_opening_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  return exists (
    select 1 from public.session_waitlist_notices n
    where n.opening_id = p_opening_id and n.user_id = p_user_id
  );
end;
$function$;

-- Sends the existing notification to the head of the line, unless they already heard about this opening.
create or replace function public._waitlist_notify_head(p_session_id uuid, p_opening_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_head uuid;
begin
  if public._waitlist_notify_skip_reason(p_session_id) is not null then
    return;
  end if;
  v_head := public._waitlist_first_eligible_user(p_session_id);
  if v_head is null or public._waitlist_recipient_already_told(p_opening_id, v_head) then
    return;
  end if;

  insert into public.session_waitlist_notices (opening_id, user_id)
  values (p_opening_id, v_head)
  on conflict (opening_id, user_id) do nothing;
  if not found then
    return;
  end if;

  perform public.invoke_notify_waitlist_edge(p_session_id);
  begin
    perform public.maybe_enqueue_whatsapp_waitlist(p_session_id);
  exception when others then
    null;
  end;
end;
$function$;

-- A departure: if it took the session from full to available, that is a new opening.
create or replace function public._waitlist_note_departure(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_max integer;
  v_opening uuid;
begin
  perform public._waitlist_lock_session(p_session_id);
  select max_participants into v_max from public.training_sessions where id = p_session_id;
  if not found or public.active_registration_count(p_session_id) <> v_max - 1 then
    return;
  end if;
  if not exists (select 1 from public.waitlist_requests w where w.session_id = p_session_id) then
    return;
  end if;
  insert into public.session_waitlist_openings (session_id) values (p_session_id) returning id into v_opening;
  perform public._waitlist_notify_head(p_session_id, v_opening);
end;
$function$;

create or replace function public.tg_notify_waitlist_session_registration_cancelled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  perform public._waitlist_note_departure(new.session_id);
  return new;
exception when others then
  raise warning 'waitlist notify: opening check failed (sqlstate %)', sqlstate;
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
  -- A quick-add row linked to an athlete with an active registration never held a seat of its own.
  if not exists (
    select 1
    from public.manual_participants mp
    join public.session_registrations r on r.user_id = mp.linked_user_id and r.session_id = old.session_id and r.status = 'active'
    where mp.id = old.manual_participant_id
  ) then
    perform public._waitlist_note_departure(old.session_id);
  end if;
  return old;
exception when others then
  raise warning 'waitlist notify: opening check failed (sqlstate %)', sqlstate;
  return old;
end;
$function$;

-- Someone left the line (they withdrew, registered, or staff removed them). If a place is still free and the new head has
-- not heard about the current opening, tell them. Nobody is told twice about the same opening.
create or replace function public.tg_waitlist_continuity_after_leave()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_max integer;
  v_opening uuid;
begin
  perform public._waitlist_lock_session(old.session_id);
  select max_participants into v_max from public.training_sessions where id = old.session_id;
  if not found or public.active_registration_count(old.session_id) >= v_max then
    return old;
  end if;
  select o.id into v_opening
  from public.session_waitlist_openings o
  where o.session_id = old.session_id
  order by o.opened_at desc
  limit 1;
  if v_opening is not null then
    perform public._waitlist_notify_head(old.session_id, v_opening);
  end if;
  return old;
exception when others then
  raise warning 'waitlist notify: continuity check failed (sqlstate %)', sqlstate;
  return old;
end;
$function$;

create trigger trg_waitlist_continuity_after_leave
  after delete on public.waitlist_requests
  for each row
  execute function public.tg_waitlist_continuity_after_leave();

do $$
declare
  f text;
begin
  foreach f in array array[
    'public._waitlist_lock_session(uuid)',
    'public._waitlist_recipient_already_told(uuid, uuid)',
    'public._waitlist_notify_head(uuid, uuid)',
    'public._waitlist_note_departure(uuid)',
    'public.tg_waitlist_continuity_after_leave()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

comment on table public.session_waitlist_openings is
  'One row per full -> available transition of a session with a waitlist. Internal; reserves nothing.';
comment on table public.session_waitlist_notices is
  'Who was notified about each opening, so nobody is told twice about the same one.';

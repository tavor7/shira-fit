-- When a spot opens (registration cancelled / removed, or manual participant removed from session),
-- call the notify-waitlist Edge Function via pg_net so waitlisted users get a push (if tokens exist).
--
-- Setup (run once in Supabase SQL Editor after deploy, using YOUR project ref and the SAME value as Edge secret CRON_SECRET):
--
--   select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/notify-waitlist', 'notify_waitlist_url');
--   select vault.create_secret('YOUR_CRON_SECRET', 'notify_waitlist_secret');
--
-- If secrets are missing, the trigger no-ops safely.

create extension if not exists pg_net;

create or replace function public.invoke_notify_waitlist_edge(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  if p_session_id is null then
    return;
  end if;

  select ds.decrypted_secret into v_url
  from vault.decrypted_secrets ds
  where ds.name = 'notify_waitlist_url'
  limit 1;

  select ds.decrypted_secret into v_secret
  from vault.decrypted_secrets ds
  where ds.name = 'notify_waitlist_secret'
  limit 1;

  if v_url is null or v_secret is null
     or length(trim(v_url)) < 10
     or length(trim(v_secret)) < 4
  then
    return;
  end if;

  perform net.http_post(
    url := trim(v_url),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || trim(v_secret)
    ),
    body := jsonb_build_object('session_id', p_session_id::text)
  );
end;
$$;

comment on function public.invoke_notify_waitlist_edge(uuid) is
  'POSTs to notify-waitlist Edge Function if vault secrets notify_waitlist_url + notify_waitlist_secret are set.';

-- Athlete cancel, coach remove, manager remove: active → cancelled.
create or replace function public.tg_notify_waitlist_session_registration_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.invoke_notify_waitlist_edge(new.session_id);
  return new;
end;
$$;

drop trigger if exists trg_notify_waitlist_on_registration_cancelled on public.session_registrations;
create trigger trg_notify_waitlist_on_registration_cancelled
  after update of status on public.session_registrations
  for each row
  when (
    old.status = 'active'::public.registration_status
    and new.status = 'cancelled'::public.registration_status
  )
  execute procedure public.tg_notify_waitlist_session_registration_cancelled();

-- Manual participant removed from a session → spot may open.
create or replace function public.tg_notify_waitlist_manual_participant_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.invoke_notify_waitlist_edge(old.session_id);
  return old;
end;
$$;

drop trigger if exists trg_notify_waitlist_on_manual_removed on public.session_manual_participants;
create trigger trg_notify_waitlist_on_manual_removed
  after delete on public.session_manual_participants
  for each row
  execute procedure public.tg_notify_waitlist_manual_participant_removed();

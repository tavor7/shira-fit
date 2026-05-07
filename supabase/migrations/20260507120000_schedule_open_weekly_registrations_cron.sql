-- Schedule weekly registration auto-opening (server-side, no app dependency).
--
-- This cron job calls the `open-weekly-registrations` Edge Function on the configured UTC weekday+time.
-- To avoid wasteful polling (every minute/15m), we schedule the job to run exactly once per week.
--
-- When `app_settings.registration_open_weekday/time` changes, we automatically reschedule the cron job.
--
-- One-time setup (run in Supabase SQL editor after deploy):
--
--   select vault.create_secret('https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-weekly-registrations', 'open_weekly_registrations_url');
--   select vault.create_secret('YOUR_CRON_SECRET', 'open_weekly_registrations_secret');
--
-- Where YOUR_CRON_SECRET must match the Edge Function env var `CRON_SECRET`.
-- If secrets are missing, the cron job no-ops safely.

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.invoke_open_weekly_registrations_edge()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
  v_secret text;
begin
  select ds.decrypted_secret into v_url
  from vault.decrypted_secrets ds
  where ds.name = 'open_weekly_registrations_url'
  limit 1;

  select ds.decrypted_secret into v_secret
  from vault.decrypted_secrets ds
  where ds.name = 'open_weekly_registrations_secret'
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
    body := jsonb_build_object('ts', now()::text)
  );
end;
$$;

comment on function public.invoke_open_weekly_registrations_edge() is
  'Invokes open-weekly-registrations Edge Function if vault secrets are set.';

create or replace function public.reschedule_open_weekly_registrations_cron()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_weekday int;
  v_time time;
  v_min int;
  v_hour int;
  v_spec text;
  v_job_id int;
begin
  select s.registration_open_weekday, s.registration_open_time
  into v_weekday, v_time
  from public.app_settings s
  where s.id = 1;

  v_weekday := greatest(0, least(6, coalesce(v_weekday, 4)));
  v_time := coalesce(v_time, '08:00:00'::time);
  v_min := extract(minute from v_time)::int;
  v_hour := extract(hour from v_time)::int;

  -- pg_cron format: minute hour day-of-month month day-of-week
  -- Use UTC schedule (same convention as open_next_week_sessions_if_due / Edge function).
  v_spec := format('%s %s * * %s', v_min, v_hour, v_weekday);

  select j.jobid into v_job_id
  from cron.job j
  where j.jobname = 'open-weekly-registrations'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'open-weekly-registrations',
    v_spec,
    $job$select public.invoke_open_weekly_registrations_edge();$job$
  );
end;
$$;

comment on function public.reschedule_open_weekly_registrations_cron() is
  'Schedules (or reschedules) the open-weekly-registrations cron job from app_settings (UTC).';

-- Initial schedule on deploy.
select public.reschedule_open_weekly_registrations_cron();

-- Auto-reschedule when opening schedule changes.
create or replace function public.tg_reschedule_open_weekly_registrations_cron()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.registration_open_weekday is distinct from old.registration_open_weekday)
     or (new.registration_open_time is distinct from old.registration_open_time) then
    perform public.reschedule_open_weekly_registrations_cron();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reschedule_open_weekly_registrations_cron on public.app_settings;
create trigger trg_reschedule_open_weekly_registrations_cron
  after update of registration_open_weekday, registration_open_time on public.app_settings
  for each row
  when (old.id = 1)
  execute procedure public.tg_reschedule_open_weekly_registrations_cron();


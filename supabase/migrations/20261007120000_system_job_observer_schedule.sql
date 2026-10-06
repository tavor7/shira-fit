-- System monitoring, Phase 2.3: schedule the job observer (shadow mode).
--
-- Exactly ONE new cron job: system-monitor-observe, every 5 minutes. No business job is scheduled,
-- unscheduled, altered or wrapped here. The observer runs in shadow mode (config job_monitoring.shadow=true,
-- report_enabled=false): it only maintains public.system_job_state.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'system-monitor-observe') then
    raise exception 'system-monitor-observe is already scheduled';
  end if;
  perform cron.schedule('system-monitor-observe', '*/5 * * * *', 'select public._system_job_observe();');
end $$;

-- Self-check.
do $$
declare
  v_n integer;
begin
  select count(*) into v_n from cron.job
  where jobname = 'system-monitor-observe' and schedule = '*/5 * * * *' and active
    and command = 'select public._system_job_observe();';
  if v_n <> 1 then raise exception 'self-check: observer cron job not scheduled correctly'; end if;
end $$;
